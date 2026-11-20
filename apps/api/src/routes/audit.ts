import { Router, type Request, type Response } from "express";
import { isUuid, withTenant } from "../lib/db.js";
import { badRequest, notFound } from "../lib/errors.js";

/**
 * Audit-event read routes — Sprint Days 12–14 (Data Model §7).
 *
 *  GET /api/audit-events                 List events for this tenant, newest first
 *  GET /api/audit-events/:id             One event
 *
 * Read-only: audit events are append-only (migration 0008 triggers reject
 * UPDATE/DELETE) and are written only by the API's recordAuditEvent calls,
 * in the same transaction as the write they record. Chain verification is
 * a separate command: `npm run audit:verify --workspace=packages/db`.
 * Optional filters: ?target_type=document&target_id=<uuid>.
 */

export const auditRouter = Router();

interface AuditEventRow {
  id: string;
  organization_id: string;
  actor_id: string | null;
  event_type: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  model_version: string | null;
  created_at: string;
  previous_hash: string | null;
  event_hash: string;
  seq: string;
}

const AUDIT_SELECT = `
  id, organization_id, actor_id, event_type, target_type, target_id,
  payload, model_version, created_at, previous_hash, event_hash, seq
`;

/** Express 5 types route params as string | string[]; a repeated param is a client error. */
function paramString(value: string | string[], field: string): string {
  if (Array.isArray(value)) {
    throw badRequest("INVALID_ID", `${field} must be a single value.`);
  }
  return value;
}

function toAuditSummary(row: AuditEventRow): Record<string, unknown> {
  return {
    id: row.id,
    organization_id: row.organization_id,
    actor_id: row.actor_id,
    event_type: row.event_type,
    target_type: row.target_type,
    target_id: row.target_id,
    payload: row.payload,
    model_version: row.model_version,
    created_at: row.created_at,
    previous_hash: row.previous_hash,
    event_hash: row.event_hash,
    seq: Number(row.seq),
  };
}

auditRouter.get("/", async (req: Request, res: Response) => {
  const tenant = req.tenant;
  if (!tenant) throw new Error("tenant middleware did not run");
  const { organizationId } = tenant;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  const targetType = typeof req.query.target_type === "string" ? req.query.target_type : null;
  const targetId = typeof req.query.target_id === "string" ? req.query.target_id : null;
  if (targetId !== null && !isUuid(targetId)) {
    throw badRequest("INVALID_ID", "target_id must be a UUID.");
  }
  const { rows } = await withTenant(organizationId, async (client) => {
    const conditions = ["organization_id = $1"];
    const values: unknown[] = [organizationId];
    if (targetType !== null) {
      values.push(targetType);
      conditions.push(`target_type = $${values.length}`);
    }
    if (targetId !== null) {
      values.push(targetId);
      conditions.push(`target_id = $${values.length}`);
    }
    values.push(limit, offset);
    return client.query<AuditEventRow>(
      `SELECT ${AUDIT_SELECT} FROM audit_events
       WHERE ${conditions.join(" AND ")}
       ORDER BY seq DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
  });
  res.status(200).json({ audit_events: rows.map(toAuditSummary), limit, offset });
});

auditRouter.get("/:id", async (req: Request, res: Response) => {
  const tenant = req.tenant;
  if (!tenant) throw new Error("tenant middleware did not run");
  const { organizationId } = tenant;
  const eventId = paramString(req.params.id, "audit event id");
  if (!isUuid(eventId)) {
    throw badRequest("INVALID_ID", "Audit event id must be a UUID.");
  }
  const { rows } = await withTenant(organizationId, async (client) =>
    client.query<AuditEventRow>(
      `SELECT ${AUDIT_SELECT} FROM audit_events WHERE id = $1 AND organization_id = $2`,
      [eventId, organizationId],
    ),
  );
  if (rows.length === 0) {
    throw notFound("AUDIT_EVENT_NOT_FOUND", "No audit event with this id in this organization.");
  }
  res.status(200).json({ audit_event: toAuditSummary(rows[0]) });
});
