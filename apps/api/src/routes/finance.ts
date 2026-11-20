import { Router, type Request, type Response } from "express";
import { isTenantMember, isUuid, withTenant } from "../lib/db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { getJournalEntry, postJournalEntry } from "../lib/ledger.js";
import {
  accountBalances,
  ensureStandardChart,
  postSupplierToSaleFlow,
  recordValuation,
} from "../lib/finance-flow.js";

/**
 * Finance routes (P1, domain model §4.3).
 *
 *  POST /api/v1/finance/journal-entries     Post one balanced entry (idempotent by source)
 *  GET  /api/v1/finance/journal-entries/:id One entry with its lines
 *  GET  /api/v1/finance/journal-entries     List entries (newest first)
 *  GET  /api/v1/finance/accounts            Chart of accounts with posted balances
 *  POST /api/v1/finance/accounts/ensure-chart  Create the standard chart (idempotent)
 *  GET  /api/v1/finance/inventory-valuations  Valuations (?lot_id=)
 *  POST /api/v1/finance/inventory-valuations  Record a valuation
 *  POST /api/v1/finance/flows/supplier-to-sale  Prototype flow: receipt/AP ->
 *       consumption/COGS -> sale/AR, with valuations moving at each step.
 *
 * Every posting goes through postJournalEntry (lib/ledger.ts) — there is
 * no second posting path. Tax is NOT calculated here: tax rules are
 * read-only until a domain expert reviews them (ADR D-07); the tax
 * routes live in routes/tax.ts and calculate nothing.
 */
export const financeRouter = Router();

function requireTenant(req: Request): { organizationId: string; userId: string } {
  const tenant = req.tenant;
  if (!tenant) throw new Error("tenant middleware did not run");
  return tenant;
}

function paramString(value: string | string[], field: string): string {
  if (Array.isArray(value)) {
    throw badRequest("INVALID_ID", `${field} must be a single value.`);
  }
  return value;
}

function parseMoneyField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw badRequest("INVALID_FIELD", `${field} must be a non-negative integer (cents).`);
  }
  return value;
}

function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest("INVALID_FIELD", `${field} is required and must be a non-empty string.`);
  }
  return value.trim();
}

function parseOptionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isUuid(value)) {
    throw badRequest("INVALID_FIELD", `${field} must be a UUID.`);
  }
  return value;
}

function parseEntryDate(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest("INVALID_FIELD", "entry_date is required as a YYYY-MM-DD date string.");
  }
  const date = new Date(`${value.trim()}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw badRequest("INVALID_FIELD", "entry_date must be a YYYY-MM-DD date string.");
  }
  return value.trim();
}

financeRouter.post("/journal-entries", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const entryDate = parseEntryDate(req.body?.entry_date);
  const sourceModule = parseRequiredString(req.body?.source_module, "source_module");
  const sourceType = parseRequiredString(req.body?.source_type, "source_type");
  const sourceId = parseRequiredString(req.body?.source_id, "source_id");
  if (!isUuid(sourceId)) {
    throw badRequest("INVALID_FIELD", "source_id must be a UUID.");
  }
  const rawLines = req.body?.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw badRequest("INVALID_FIELD", "lines must be a non-empty array.");
  }
  const lines = rawLines.map((raw) => {
    const accountId = raw?.account_id;
    if (typeof accountId !== "string" || !isUuid(accountId)) {
      throw badRequest("INVALID_FIELD", "lines[].account_id must be a UUID.");
    }
    return {
      accountId,
      creditCents: parseMoneyField(raw?.credit_cents ?? 0, "lines[].credit_cents"),
      debitCents: parseMoneyField(raw?.debit_cents ?? 0, "lines[].debit_cents"),
      lotId: parseOptionalUuid(raw?.lot_id, "lines[].lot_id"),
      memo: typeof raw?.memo === "string" ? raw.memo : null,
      productId: parseOptionalUuid(raw?.product_id, "lines[].product_id"),
    };
  });
  const result = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    const posted = await postJournalEntry(client, {
      createdBy: userId,
      entry: {
        entryDate,
        lines,
        memo: typeof req.body?.memo === "string" ? req.body.memo : null,
        sourceId,
        sourceModule,
        sourceType,
      },
      organizationId,
    });
    const entry = await getJournalEntry(client, { entryId: posted.id, organizationId });
    return { duplicate: posted.duplicate, entry };
  });
  res.status(result.duplicate ? 200 : 201).json(result);
});

financeRouter.get("/journal-entries/:id", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const entryId = paramString(req.params.id, "journal entry id");
  if (!isUuid(entryId)) throw badRequest("INVALID_ID", "Journal entry id must be a UUID.");
  const entry = await withTenant(organizationId, async (client) =>
    getJournalEntry(client, { entryId, organizationId }),
  );
  if (entry === null) {
    throw notFound(
      "JOURNAL_ENTRY_NOT_FOUND",
      "No journal entry with this id in this organization.",
    );
  }
  res.status(200).json({ entry });
});

financeRouter.get("/journal-entries", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  const entries = await withTenant(organizationId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE organization_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [organizationId, limit, offset],
    );
    const out = [];
    for (const row of rows) {
      out.push(await getJournalEntry(client, { entryId: row.id, organizationId }));
    }
    return out;
  });
  res.status(200).json({ entries, limit, offset });
});

financeRouter.get("/accounts", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const accounts = await withTenant(organizationId, async (client) =>
    accountBalances(client, organizationId),
  );
  res.status(200).json({ accounts });
});

financeRouter.post("/accounts/ensure-chart", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const accounts = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    return [...(await ensureStandardChart(client, organizationId)).values()];
  });
  res.status(200).json({ accounts });
});

financeRouter.get("/inventory-valuations", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const lotId =
    typeof req.query.lot_id === "string" && req.query.lot_id !== "" ? req.query.lot_id : null;
  if (lotId !== null && !isUuid(lotId)) {
    throw badRequest("INVALID_ID", "lot_id must be a UUID.");
  }
  const valuations = await withTenant(organizationId, async (client) => {
    const values: unknown[] = [organizationId];
    const conditions = ["organization_id = $1"];
    if (lotId !== null) {
      values.push(lotId);
      conditions.push(`lot_id = $${values.length}`);
    }
    const { rows } = await client.query(
      `SELECT id, lot_id, valuation_method, unit_cost_cents, total_cents, as_of, journal_entry_id
       FROM inventory_valuations WHERE ${conditions.join(" AND ")}
       ORDER BY as_of DESC LIMIT 100`,
      values,
    );
    return rows.map((row) => ({
      asOf: row.as_of,
      id: row.id,
      journalEntryId: row.journal_entry_id,
      lotId: row.lot_id,
      totalCents: Number(row.total_cents),
      unitCostCents: Number(row.unit_cost_cents),
      valuationMethod: row.valuation_method,
    }));
  });
  res.status(200).json({ valuations });
});

financeRouter.post("/inventory-valuations", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const lotId = req.body?.lot_id;
  if (typeof lotId !== "string" || !isUuid(lotId)) {
    throw badRequest("INVALID_FIELD", "lot_id is required and must be a UUID.");
  }
  const unitCostCents = parseMoneyField(req.body?.unit_cost_cents, "unit_cost_cents");
  const totalCents = parseMoneyField(req.body?.total_cents, "total_cents");
  const method =
    typeof req.body?.valuation_method === "string" && req.body.valuation_method !== ""
      ? req.body.valuation_method
      : "AVERAGE";
  if (!["FIFO", "AVERAGE", "STANDARD", "ACTUAL"].includes(method)) {
    throw badRequest(
      "INVALID_FIELD",
      "valuation_method must be one of: FIFO, AVERAGE, STANDARD, ACTUAL.",
    );
  }
  const asOfRaw = req.body?.as_of;
  const asOf = typeof asOfRaw === "string" && asOfRaw !== "" ? new Date(asOfRaw) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    throw badRequest("INVALID_FIELD", "as_of must be an ISO 8601 date-time string.");
  }
  const journalEntryId = parseOptionalUuid(req.body?.journal_entry_id, "journal_entry_id");
  const valuation = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    const lot = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM lots WHERE id = $1 AND organization_id = $2) AS exists`,
      [lotId, organizationId],
    );
    if (!lot.rows[0]?.exists) {
      throw notFound("LOT_NOT_FOUND", "Lot does not exist in this organization.");
    }
    return recordValuation(client, {
      asOf,
      createdBy: userId,
      journalEntryId,
      lotId,
      organizationId,
      totalCents,
      unitCostCents,
      valuationMethod: method,
    });
  });
  res.status(201).json({ valuation });
});

financeRouter.post("/flows/supplier-to-sale", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const lotId = req.body?.lot_id;
  if (typeof lotId !== "string" || !isUuid(lotId)) {
    throw badRequest("INVALID_FIELD", "lot_id is required and must be a UUID.");
  }
  const productId = parseOptionalUuid(req.body?.product_id, "product_id");
  const entryDate =
    req.body?.entry_date === undefined || req.body?.entry_date === null
      ? undefined
      : parseEntryDate(req.body.entry_date);
  const parseStep = (
    raw: unknown,
    field: string,
    needsUnitCost = false,
  ): { sourceId: string; amountCents: number; unitCostCents: number } => {
    if (typeof raw !== "object" || raw === null) {
      throw badRequest("INVALID_FIELD", `${field} is required as an object.`);
    }
    const step = raw as Record<string, unknown>;
    const sourceId = step.source_id;
    if (typeof sourceId !== "string" || !isUuid(sourceId)) {
      throw badRequest("INVALID_FIELD", `${field}.source_id must be a UUID.`);
    }
    const amountCents = parseMoneyField(step.amount_cents, `${field}.amount_cents`);
    if (amountCents === 0) {
      throw badRequest("INVALID_FIELD", `${field}.amount_cents must be positive.`);
    }
    return {
      amountCents,
      sourceId,
      unitCostCents: needsUnitCost
        ? parseMoneyField(step.unit_cost_cents, `${field}.unit_cost_cents`)
        : 0,
    };
  };
  const receipt = parseStep(req.body?.receipt, "receipt", true);
  const consumption = parseStep(req.body?.consumption, "consumption");
  const sale = parseStep(req.body?.sale, "sale");
  const result = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    const lot = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM lots WHERE id = $1 AND organization_id = $2) AS exists`,
      [lotId, organizationId],
    );
    if (!lot.rows[0]?.exists) {
      throw notFound("LOT_NOT_FOUND", "Lot does not exist in this organization.");
    }
    return postSupplierToSaleFlow(client, {
      createdBy: userId,
      input: {
        consumption: { amountCents: consumption.amountCents, sourceId: consumption.sourceId },
        entryDate,
        lotId,
        productId: productId ?? null,
        receipt: {
          amountCents: receipt.amountCents,
          sourceId: receipt.sourceId,
          unitCostCents: receipt.unitCostCents,
        },
        sale: { amountCents: sale.amountCents, sourceId: sale.sourceId },
      },
      organizationId,
    });
  });
  const replayed =
    result.receipt.duplicate && result.consumption.duplicate && result.sale.duplicate;
  res.status(replayed ? 200 : 201).json(result);
});
