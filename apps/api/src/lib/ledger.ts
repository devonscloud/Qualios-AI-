import type { PoolClient } from "pg";
import { buildIdempotencyKey, validateJournalEntry, type JournalEntryInput } from "@qualios/domain";
import { badRequest, notFound } from "./errors.js";

/**
 * Double-entry ledger posting (domain model, migration 0012).
 *
 * One source record posts at most one journal entry per module:
 * the idempotency key is derived from (source_module, source_type,
 * source_id), and the database enforces uniqueness per organization,
 * so replaying the same source returns the original entry instead of
 * double-posting. Entries are validated balanced here AND by the
 * database trigger on posting, and are inserted DRAFT then flipped to
 * POSTED in the same transaction. Posted entries' lines are immutable
 * in the database; a correction posts a new (reversing) entry.
 *
 * The caller holds the transaction (withTenant).
 */

export interface PostedJournalEntry {
  id: string;
  organizationId: string;
  status: string;
  duplicate: boolean;
}

export async function postJournalEntry(
  client: PoolClient,
  args: {
    organizationId: string;
    createdBy: string;
    entry: JournalEntryInput;
  },
): Promise<PostedJournalEntry> {
  const { organizationId, createdBy, entry } = args;
  const validation = validateJournalEntry(entry);
  if (!validation.valid) {
    throw badRequest("UNBALANCED_ENTRY", validation.issues.map((issue) => issue.message).join(" "));
  }
  const idempotencyKey = buildIdempotencyKey(entry.sourceModule, entry.sourceType, entry.sourceId);

  // Idempotent replay: the same source returns its original entry.
  const existing = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM journal_entries
     WHERE organization_id = $1 AND idempotency_key = $2`,
    [organizationId, idempotencyKey],
  );
  if (existing.rows.length > 0) {
    return {
      duplicate: true,
      id: existing.rows[0].id,
      organizationId,
      status: existing.rows[0].status,
    };
  }

  // Every line's account must exist in this organization.
  for (const line of entry.lines) {
    const account = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM gl_accounts WHERE id = $1 AND organization_id = $2) AS exists`,
      [line.accountId, organizationId],
    );
    if (!account.rows[0]?.exists) {
      throw notFound("ACCOUNT_NOT_FOUND", `GL account ${line.accountId} does not exist.`);
    }
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (organization_id, entry_date, source_module, source_type, source_id,
        idempotency_key, memo, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8)
     RETURNING id`,
    [
      organizationId,
      entry.entryDate,
      entry.sourceModule,
      entry.sourceType,
      entry.sourceId,
      idempotencyKey,
      entry.memo ?? null,
      createdBy,
    ],
  );
  const entryId = inserted.rows[0].id;
  for (const line of entry.lines) {
    await client.query(
      `INSERT INTO journal_lines
         (journal_entry_id, account_id, debit_cents, credit_cents, lot_id, product_id, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entryId,
        line.accountId,
        line.debitCents,
        line.creditCents,
        line.lotId ?? null,
        line.productId ?? null,
        line.memo ?? null,
      ],
    );
  }
  // The balance trigger re-checks here; an unbalanced entry cannot post
  // even if validation above is bypassed by a future caller.
  const posted = await client.query<{ id: string; status: string }>(
    `UPDATE journal_entries SET status = 'POSTED'
     WHERE id = $1 AND organization_id = $2 RETURNING id, status`,
    [entryId, organizationId],
  );
  return {
    duplicate: false,
    id: posted.rows[0].id,
    organizationId,
    status: posted.rows[0].status,
  };
}
