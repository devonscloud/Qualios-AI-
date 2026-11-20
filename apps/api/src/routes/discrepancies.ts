import { Router, type Request, type Response } from "express";
import { recordAuditEvent } from "@qualios/db";
import { isTenantMember, isUuid, withTenant } from "../lib/db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";

/**
 * Discrepancy routes — Sprint Days 14–18 (PRD FR-05/FR-06, backlog Q-023/Q-024,
 * Data Model §4).
 *
 *  GET  /api/discrepancies              List (filters: ?status=&type=&reconciliation_id=)
 *  GET  /api/discrepancies/:id          One discrepancy
 *  PATCH /api/discrepancies/:id         Move status / assign owner / set resolution note
 *  POST /api/discrepancies/:id/resolve  Propose a resolution (needs a note)
 *  POST /api/discrepancies/:id/approve  Approve a proposed resolution (second person)
 *
 * State machine (Data Model §4):
 *   OPEN -> INVESTIGATING -> RESOLUTION_PROPOSED -> RESOLVED -> CLOSED
 *   ESCALATED from any non-terminal state; ESCALATED -> INVESTIGATING/OPEN.
 *
 * No auto-resolution: a discrepancy is only RESOLVED when a second person
 * (not the one who proposed the resolution) approves it. The approval is a
 * signed row in `approvals` plus an immutable audit event. A resolution
 * that changes a compliance record is therefore always two humans and one
 * audit trail — the full approval workflow (Days 18–24) builds on this.
 */

export const discrepanciesRouter = Router();

const DISCREPANCY_TYPES = [
  "PHANTOM_STOCK",
  "SHORTAGE",
  "UNALLOCATED_PRODUCTION",
  "LOT_MISMATCH",
  "BULK_VS_PACKAGED",
  "UNEXPLAINED_MOVEMENT",
] as const;

const DISCREPANCY_STATUSES = [
  "OPEN",
  "INVESTIGATING",
  "RESOLUTION_PROPOSED",
  "RESOLVED",
  "EXPLAINED",
  "ESCALATED",
  "CLOSED",
] as const;

type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number];

/** Allowed status moves. RESOLVED is reached only through /approve. */
const ALLOWED_TRANSITIONS: Record<DiscrepancyStatus, DiscrepancyStatus[]> = {
  OPEN: ["INVESTIGATING", "RESOLUTION_PROPOSED", "ESCALATED"],
  INVESTIGATING: ["OPEN", "RESOLUTION_PROPOSED", "ESCALATED"],
  RESOLUTION_PROPOSED: ["INVESTIGATING", "ESCALATED"],
  RESOLVED: ["CLOSED"],
  EXPLAINED: ["CLOSED"],
  ESCALATED: ["OPEN", "INVESTIGATING"],
  CLOSED: [],
};

interface DiscrepancyRow {
  id: string;
  organization_id: string;
  reconciliation_id: string | null;
  lot_id: string | null;
  lot_number: string | null;
  product_id: string | null;
  discrepancy_type: string;
  severity: string;
  description: string;
  quantity_mg: number | null;
  quantity_units: number | null;
  status: string;
  owner_id: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  approved_by: string | null;
  opened_at: string;
  closed_at: string | null;
  evidence: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function toDiscrepancySummary(row: DiscrepancyRow): Record<string, unknown> {
  return {
    id: row.id,
    organization_id: row.organization_id,
    reconciliation_id: row.reconciliation_id,
    lot_id: row.lot_id,
    lot_number: row.lot_number,
    product_id: row.product_id,
    discrepancy_type: row.discrepancy_type,
    severity: row.severity,
    description: row.description,
    quantity_mg: row.quantity_mg,
    quantity_units: row.quantity_units,
    status: row.status,
    owner_id: row.owner_id,
    resolution_note: row.resolution_note,
    resolved_by: row.resolved_by,
    approved_by: row.approved_by,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    evidence: row.evidence,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const DISCREPANCY_SELECT = `
  d.id, d.organization_id, d.reconciliation_id, d.lot_id, l.lot_number,
  d.product_id, d.discrepancy_type, d.severity, d.description,
  d.quantity_mg, d.quantity_units, d.status, d.owner_id, d.resolution_note,
  d.resolved_by, d.approved_by, d.opened_at, d.closed_at, d.evidence,
  d.created_at, d.updated_at
  FROM discrepancies d
  LEFT JOIN lots l ON l.id = d.lot_id
`;

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

async function loadDiscrepancy(
  client: {
    query: (text: string, values: unknown[]) => Promise<{ rows: DiscrepancyRow[] }>;
  },
  organizationId: string,
  discrepancyId: string,
  forUpdate: boolean,
): Promise<DiscrepancyRow> {
  // FOR UPDATE OF d: the lots side is a LEFT JOIN (nullable), and Postgres
  // refuses FOR UPDATE on the nullable side of an outer join. Locking only
  // the discrepancy row is what the state-machine transitions need.
  const { rows } = await client.query(
    `SELECT ${DISCREPANCY_SELECT}
     WHERE d.id = $1 AND d.organization_id = $2${forUpdate ? " FOR UPDATE OF d" : ""}`,
    [discrepancyId, organizationId],
  );
  const row = rows[0];
  if (!row) {
    throw notFound("DISCREPANCY_NOT_FOUND", "No discrepancy with this id in this organization.");
  }
  return row;
}

async function writeStatusEvent(
  client: Parameters<typeof recordAuditEvent>[0],
  organizationId: string,
  userId: string,
  discrepancy: DiscrepancyRow,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await recordAuditEvent(client, {
    organizationId,
    actorId: userId,
    eventType,
    targetType: "discrepancy",
    targetId: discrepancy.id,
    payload: {
      discrepancy_type: discrepancy.discrepancy_type,
      status: discrepancy.status,
      lot_number: discrepancy.lot_number,
      ...payload,
    },
    modelVersion: null,
    createdAt: new Date(),
  });
}

/** List discrepancies for this tenant, newest first. */
discrepanciesRouter.get("/", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const type = typeof req.query.type === "string" ? req.query.type : null;
  const reconciliationId =
    typeof req.query.reconciliation_id === "string" ? req.query.reconciliation_id : null;
  if (status !== null && !(DISCREPANCY_STATUSES as readonly string[]).includes(status)) {
    throw badRequest("INVALID_FIELD", `status must be one of: ${DISCREPANCY_STATUSES.join(", ")}.`);
  }
  if (type !== null && !(DISCREPANCY_TYPES as readonly string[]).includes(type)) {
    throw badRequest("INVALID_FIELD", `type must be one of: ${DISCREPANCY_TYPES.join(", ")}.`);
  }
  if (reconciliationId !== null && !isUuid(reconciliationId)) {
    throw badRequest("INVALID_ID", "reconciliation_id must be a UUID.");
  }
  const conditions = ["d.organization_id = $1"];
  const values: unknown[] = [organizationId];
  if (status !== null) {
    values.push(status);
    conditions.push(`d.status = $${values.length}`);
  }
  if (type !== null) {
    values.push(type);
    conditions.push(`d.discrepancy_type = $${values.length}`);
  }
  if (reconciliationId !== null) {
    values.push(reconciliationId);
    conditions.push(`d.reconciliation_id = $${values.length}`);
  }
  values.push(limit, offset);
  const { rows } = await withTenant(organizationId, async (client) =>
    client.query<DiscrepancyRow>(
      `SELECT ${DISCREPANCY_SELECT} WHERE ${conditions.join(" AND ")}
       ORDER BY d.opened_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    ),
  );
  res.status(200).json({ discrepancies: rows.map(toDiscrepancySummary), limit, offset });
});

/** One discrepancy. */
discrepanciesRouter.get("/:id", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const discrepancyId = paramString(req.params.id, "discrepancy id");
  if (!isUuid(discrepancyId)) {
    throw badRequest("INVALID_ID", "Discrepancy id must be a UUID.");
  }
  const row = await withTenant(organizationId, async (client) =>
    loadDiscrepancy(client, organizationId, discrepancyId, false),
  );
  res.status(200).json({ discrepancy: toDiscrepancySummary(row) });
});

/**
 * Move a discrepancy through the state machine, assign an owner, or set the
 * resolution note. Moving to RESOLUTION_PROPOSED requires a note and records
 * the caller as the proposer (resolved_by); moving to RESOLVED is not
 * allowed here — use /approve, which enforces a second person.
 */
discrepanciesRouter.patch("/:id", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const discrepancyId = paramString(req.params.id, "discrepancy id");
  if (!isUuid(discrepancyId)) {
    throw badRequest("INVALID_ID", "Discrepancy id must be a UUID.");
  }
  const nextStatus = req.body?.status;
  const ownerId = req.body?.owner_id;
  const resolutionNote = req.body?.resolution_note;
  if (
    nextStatus !== undefined &&
    nextStatus !== null &&
    !(DISCREPANCY_STATUSES as readonly string[]).includes(nextStatus)
  ) {
    throw badRequest("INVALID_FIELD", `status must be one of: ${DISCREPANCY_STATUSES.join(", ")}.`);
  }
  if (nextStatus === "RESOLVED" || nextStatus === "EXPLAINED") {
    throw badRequest(
      "USE_APPROVE_ENDPOINT",
      "A discrepancy is resolved or explained only through POST /:id/approve, by a second person.",
    );
  }
  if (
    ownerId !== undefined &&
    ownerId !== null &&
    (typeof ownerId !== "string" || !isUuid(ownerId))
  ) {
    throw badRequest("INVALID_FIELD", "owner_id must be a UUID.");
  }
  if (
    resolutionNote !== undefined &&
    resolutionNote !== null &&
    typeof resolutionNote !== "string"
  ) {
    throw badRequest("INVALID_FIELD", "resolution_note must be a string.");
  }

  const updated = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    const current = await loadDiscrepancy(client, organizationId, discrepancyId, true);
    const from = current.status as DiscrepancyStatus;
    if (nextStatus !== undefined && nextStatus !== null && nextStatus !== from) {
      const allowed = ALLOWED_TRANSITIONS[from] ?? [];
      if (!allowed.includes(nextStatus as DiscrepancyStatus)) {
        throw conflict(
          "INVALID_TRANSITION",
          `Cannot move a discrepancy from ${from} to ${nextStatus}.`,
        );
      }
      if (
        nextStatus === "RESOLUTION_PROPOSED" &&
        (resolutionNote === undefined || resolutionNote === null || resolutionNote.trim() === "") &&
        (current.resolution_note === null || current.resolution_note.trim() === "")
      ) {
        throw badRequest(
          "INVALID_FIELD",
          "A resolution note is required when proposing a resolution.",
        );
      }
    }
    if (ownerId !== undefined && ownerId !== null) {
      const owner = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM users u JOIN memberships m ON m.user_id = u.id
           WHERE u.id = $1 AND m.organization_id = $2 AND m.status = 'ACTIVE'
         ) AS exists`,
        [ownerId, organizationId],
      );
      if (!owner.rows[0]?.exists) {
        throw badRequest(
          "OWNER_NOT_FOUND",
          "owner_id is not an active member of this organization.",
        );
      }
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    if (nextStatus !== undefined && nextStatus !== null && nextStatus !== from) {
      values.push(nextStatus);
      sets.push(`status = $${values.length}`);
      if (nextStatus === "RESOLUTION_PROPOSED") {
        values.push(userId);
        sets.push(`resolved_by = $${values.length}`);
      }
      if (nextStatus === "CLOSED") {
        sets.push(`closed_at = now()`);
      }
    }
    if (ownerId !== undefined) {
      values.push(ownerId);
      sets.push(`owner_id = $${values.length}`);
    }
    if (resolutionNote !== undefined) {
      values.push(resolutionNote);
      sets.push(`resolution_note = $${values.length}`);
    }
    if (sets.length === 0) {
      return current;
    }
    values.push(discrepancyId, organizationId);
    await client.query(
      `UPDATE discrepancies SET ${sets.join(", ")}
       WHERE id = $${values.length - 1} AND organization_id = $${values.length}`,
      values,
    );
    // Re-read (RETURNING cannot join lots for lot_number).
    const row = await loadDiscrepancy(client, organizationId, discrepancyId, false);
    await writeStatusEvent(client, organizationId, userId, row, "DISCREPANCY_STATUS_CHANGED", {
      from_status: from,
      to_status: row.status,
    });
    return row;
  });
  res.status(200).json({ discrepancy: toDiscrepancySummary(updated) });
});

/** Propose a resolution: OPEN/INVESTIGATING -> RESOLUTION_PROPOSED, with a note. */
discrepanciesRouter.post("/:id/resolve", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const discrepancyId = paramString(req.params.id, "discrepancy id");
  if (!isUuid(discrepancyId)) {
    throw badRequest("INVALID_ID", "Discrepancy id must be a UUID.");
  }
  const note = req.body?.resolution_note ?? req.body?.note;
  if (typeof note !== "string" || note.trim() === "") {
    throw badRequest("INVALID_FIELD", "A resolution note is required to propose a resolution.");
  }
  const updated = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    const current = await loadDiscrepancy(client, organizationId, discrepancyId, true);
    const from = current.status as DiscrepancyStatus;
    if (!["OPEN", "INVESTIGATING"].includes(from)) {
      throw conflict("INVALID_TRANSITION", `Cannot propose a resolution from ${from}.`);
    }
    await client.query(
      `UPDATE discrepancies SET status = 'RESOLUTION_PROPOSED', resolution_note = $3, resolved_by = $4
       WHERE id = $1 AND organization_id = $2`,
      [discrepancyId, organizationId, note.trim(), userId],
    );
    // Re-read (RETURNING cannot join lots for lot_number).
    const row = await loadDiscrepancy(client, organizationId, discrepancyId, false);
    await writeStatusEvent(client, organizationId, userId, row, "DISCREPANCY_RESOLUTION_PROPOSED", {
      from_status: from,
      resolution_note: note.trim(),
    });
    return row;
  });
  res.status(200).json({ discrepancy: toDiscrepancySummary(updated) });
});

/**
 * Approve a proposed resolution: RESOLUTION_PROPOSED -> RESOLVED (or
 * EXPLAINED, when the variance is understood rather than fixed — pass
 * outcome: "EXPLAINED"). The approver must differ from the proposer
 * (segregation of duties). Writes a signed approvals row and an audit event.
 */
discrepanciesRouter.post("/:id/approve", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const discrepancyId = paramString(req.params.id, "discrepancy id");
  if (!isUuid(discrepancyId)) {
    throw badRequest("INVALID_ID", "Discrepancy id must be a UUID.");
  }
  const note = typeof req.body?.note === "string" ? req.body.note : null;
  const outcome = req.body?.outcome;
  if (outcome !== undefined && outcome !== "RESOLVED" && outcome !== "EXPLAINED") {
    throw badRequest("INVALID_FIELD", "outcome must be RESOLVED or EXPLAINED.");
  }
  const terminalStatus = outcome === "EXPLAINED" ? "EXPLAINED" : "RESOLVED";
  const updated = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    const current = await loadDiscrepancy(client, organizationId, discrepancyId, true);
    if (current.status !== "RESOLUTION_PROPOSED") {
      throw conflict(
        "INVALID_TRANSITION",
        `Only a RESOLUTION_PROPOSED discrepancy can be approved (current: ${current.status}).`,
      );
    }
    if (current.resolved_by === userId) {
      throw forbidden(
        "SEGREGATION_OF_DUTIES",
        "The person who proposed the resolution cannot approve it; a second person must decide.",
      );
    }
    const approval = await client.query<{ id: string }>(
      `INSERT INTO approvals
         (organization_id, action_type, target_id, target_type, approver_id, decision, note)
       VALUES ($1, 'DISCREPANCY_RESOLUTION', $2, 'discrepancy', $3, 'APPROVED', $4)
       RETURNING id`,
      [organizationId, discrepancyId, userId, note],
    );
    await client.query(
      `UPDATE discrepancies SET status = $3, approved_by = $4
       WHERE id = $1 AND organization_id = $2`,
      [discrepancyId, organizationId, terminalStatus, userId],
    );
    // Re-read (RETURNING cannot join lots for lot_number).
    const row = await loadDiscrepancy(client, organizationId, discrepancyId, false);
    await writeStatusEvent(
      client,
      organizationId,
      userId,
      row,
      terminalStatus === "EXPLAINED" ? "DISCREPANCY_EXPLAINED" : "DISCREPANCY_RESOLVED",
      {
        approval_id: approval.rows[0].id,
        resolution_note: row.resolution_note,
      },
    );
    return { row, approvalId: approval.rows[0].id };
  });
  res.status(200).json({
    discrepancy: toDiscrepancySummary(updated.row),
    approval_id: updated.approvalId,
  });
});
