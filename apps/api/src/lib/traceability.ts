import type { PoolClient } from "pg";
import {
  validateTraceLinks,
  type CreateTraceLinkInput,
  type TraceLinkType,
  type TraceResult,
} from "@qualios/domain";
import { badRequest, notFound } from "./errors.js";

/**
 * Lot genealogy (domain model, migration 0012, traceability_links).
 *
 * Links run parent -> child: the parent lot was consumed, split, or
 * transformed to produce the child. Backward trace (child -> parents)
 * answers "where did this lot come from"; forward trace (parent ->
 * children) answers "where did this lot go" — the two directions a
 * recall needs. A link that would create a cycle is refused, and a lot
 * can never link to itself.
 *
 * Traceability is core, not a pack surface: every industry traces lots.
 * The caller holds the transaction (withTenant) for creation; traces
 * are read-only queries.
 */

const LINK_TYPES: readonly TraceLinkType[] = [
  "CONSUMED_IN",
  "PRODUCED_FROM",
  "PACKAGED_FROM",
  "SPLIT_FROM",
  "MERGED_INTO",
  "SHIPPED_AS",
  "RECEIVED_AS",
];

export function parseLinkType(value: unknown): TraceLinkType {
  if (typeof value === "string" && (LINK_TYPES as readonly string[]).includes(value)) {
    return value as TraceLinkType;
  }
  throw badRequest("INVALID_FIELD", `link_type must be one of: ${LINK_TYPES.join(", ")}.`);
}

interface LinkRow {
  id: string;
  organization_id: string;
  parent_lot_id: string;
  child_lot_id: string;
  link_type: string;
  batch_id: string | null;
  quantity_mg: number | null;
  quantity_units: number | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

function toLinkSummary(row: LinkRow): Record<string, unknown> {
  return {
    id: row.id,
    organization_id: row.organization_id,
    parent_lot_id: row.parent_lot_id,
    child_lot_id: row.child_lot_id,
    link_type: row.link_type,
    batch_id: row.batch_id,
    quantity_mg: row.quantity_mg,
    quantity_units: row.quantity_units,
    note: row.note,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

async function lotExists(
  client: PoolClient,
  organizationId: string,
  lotId: string,
): Promise<boolean> {
  const found = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM lots WHERE id = $1 AND organization_id = $2) AS exists`,
    [lotId, organizationId],
  );
  return found.rows[0]?.exists === true;
}

/** Create one genealogy link, refusing cycles and cross-tenant lots. */
export async function createTraceLink(
  client: PoolClient,
  args: {
    organizationId: string;
    createdBy: string;
    input: CreateTraceLinkInput;
  },
): Promise<Record<string, unknown>> {
  const { organizationId, createdBy, input } = args;
  if (input.parentLotId === input.childLotId) {
    throw badRequest("VALIDATION_ERROR", "A lot cannot link to itself.");
  }
  if (!(await lotExists(client, organizationId, input.parentLotId))) {
    throw notFound("LOT_NOT_FOUND", "Parent lot does not exist in this organization.");
  }
  if (!(await lotExists(client, organizationId, input.childLotId))) {
    throw notFound("LOT_NOT_FOUND", "Child lot does not exist in this organization.");
  }
  if (input.batchId !== undefined && input.batchId !== null) {
    const batch = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM batches WHERE id = $1 AND organization_id = $2) AS exists`,
      [input.batchId, organizationId],
    );
    if (!batch.rows[0]?.exists) {
      throw notFound("BATCH_NOT_FOUND", "Batch does not exist in this organization.");
    }
  }
  // Cycle check against the links already stored for this tenant.
  const stored = await client.query<{
    parent_lot_id: string;
    child_lot_id: string;
    link_type: string;
  }>(
    `SELECT parent_lot_id, child_lot_id, link_type FROM traceability_links
     WHERE organization_id = $1`,
    [organizationId],
  );
  const check = validateTraceLinks([
    ...stored.rows.map((row) => ({
      childLotId: row.child_lot_id,
      linkType: row.link_type as TraceLinkType,
      parentLotId: row.parent_lot_id,
    })),
    {
      childLotId: input.childLotId,
      linkType: input.linkType,
      parentLotId: input.parentLotId,
    },
  ]);
  if (!check.valid) {
    throw badRequest("TRACE_CYCLE", check.issues.map((issue) => issue.message).join(" "));
  }
  const inserted = await client.query<LinkRow>(
    `INSERT INTO traceability_links
       (organization_id, parent_lot_id, child_lot_id, link_type, batch_id,
        quantity_mg, quantity_units, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (organization_id, parent_lot_id, child_lot_id, link_type) DO NOTHING
     RETURNING *`,
    [
      organizationId,
      input.parentLotId,
      input.childLotId,
      input.linkType,
      input.batchId ?? null,
      input.quantityMg ?? null,
      input.quantityUnits ?? null,
      input.note ?? null,
      createdBy,
    ],
  );
  if (inserted.rows.length === 0) {
    throw badRequest(
      "VALIDATION_ERROR",
      `A ${input.linkType} link from this parent lot to this child lot already exists.`,
    );
  }
  return toLinkSummary(inserted.rows[0]);
}

/**
 * Trace a lot in one direction with a recursive query. Depth 0 is the
 * lot itself; each step follows one link. Cycles cannot occur (creation
 * refuses them), but the recursion is still depth-capped as a backstop.
 */
export async function traceLot(
  client: PoolClient,
  args: { organizationId: string; lotId: string; direction: "backward" | "forward" },
): Promise<TraceResult> {
  const { organizationId, lotId, direction } = args;
  if (!(await lotExists(client, organizationId, lotId))) {
    throw notFound("LOT_NOT_FOUND", "Lot does not exist in this organization.");
  }
  const edge =
    direction === "backward"
      ? `SELECT child_lot_id AS from_id, parent_lot_id AS to_id, link_type
         FROM traceability_links WHERE organization_id = $1`
      : `SELECT parent_lot_id AS from_id, child_lot_id AS to_id, link_type
         FROM traceability_links WHERE organization_id = $1`;
  const { rows } = await client.query<{
    lot_id: string;
    lot_number: string;
    depth: number;
    via_link_type: string | null;
  }>(
    `WITH RECURSIVE trace (lot_id, depth, via_link_type) AS (
       SELECT $2::uuid, 0, NULL::text
       UNION ALL
       SELECT e.to_id, t.depth + 1, e.link_type
       FROM trace t
       JOIN (${edge}) e ON e.from_id = t.lot_id
       WHERE t.depth < 50
     )
     SELECT DISTINCT ON (t.lot_id) t.lot_id, l.lot_number, t.depth, t.via_link_type
     FROM trace t JOIN lots l ON l.id = t.lot_id
     ORDER BY t.lot_id, t.depth ASC`,
    [organizationId, lotId],
  );
  return {
    direction,
    lotId,
    nodes: rows.map((row) => ({
      depth: Number(row.depth),
      lotId: row.lot_id,
      lotNumber: row.lot_number,
      viaLinkType: row.via_link_type as TraceLinkType | null,
    })),
  };
}
