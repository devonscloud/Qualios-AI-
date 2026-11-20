import { Router, type Request, type Response } from "express";
import { isTenantMember, isUuid, withTenant } from "../lib/db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { runReconciliationEngine } from "../lib/reconcile.js";

/**
 * Reconciliation routes — Sprint Days 14–18 (PRD FR-04, backlog Q-022).
 *
 *  POST /api/reconciliations              Create a DRAFT run (scope + external source)
 *  POST /api/reconciliations/:id/run      Execute the engine (DRAFT only)
 *  GET  /api/reconciliations              List runs (tenant-scoped)
 *  GET  /api/reconciliations/:id          One run + its lines + discrepancies
 *
 * A run compares the QualiOS ledger (derived from inventory_movements)
 * against one external record set — the accepted rows of an import run
 * (seed-to-sale export, paper count sheet, or allocation). The engine
 * (lib/reconcile.ts) creates the lines and discrepancies; a run with no
 * discrepancies still needs a human to close it — a clean run is not
 * auto-approved. Tenant scoping is enforced upstream by tenantMiddleware
 * (ADR-008 layer 1) and on every query here.
 */

export const reconciliationsRouter = Router();

const SCOPE_TYPES = ["LOT", "PRODUCT", "SITE", "DATE_RANGE"] as const;
type ScopeType = (typeof SCOPE_TYPES)[number];

interface ReconciliationRow {
  id: string;
  organization_id: string;
  site_id: string | null;
  scope_type: string;
  scope_reference: string;
  started_at: string | null;
  completed_at: string | null;
  run_by: string;
  status: string;
  summary: Record<string, unknown>;
  seed_to_sale_snapshot_id: string | null;
  external_import_run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface LineRow {
  id: string;
  reconciliation_id: string;
  lot_id: string | null;
  product_id: string | null;
  lot_number: string | null;
  seed_to_sale_qty_mg: number | null;
  seed_to_sale_qty_units: number | null;
  paper_record_qty_mg: number | null;
  paper_record_qty_units: number | null;
  allocated_qty_mg: number | null;
  allocated_qty_units: number | null;
  produced_qty_mg: number | null;
  produced_qty_units: number | null;
  variance_mg: number | null;
  variance_units: number | null;
  match_status: string;
  discrepancy_id: string | null;
  created_at: string;
}

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
}

function toRunSummary(row: ReconciliationRow): Record<string, unknown> {
  return {
    id: row.id,
    organization_id: row.organization_id,
    site_id: row.site_id,
    scope_type: row.scope_type,
    scope_reference: row.scope_reference,
    started_at: row.started_at,
    completed_at: row.completed_at,
    run_by: row.run_by,
    status: row.status,
    summary: row.summary,
    seed_to_sale_snapshot_id: row.seed_to_sale_snapshot_id,
    external_import_run_id: row.external_import_run_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toLineSummary(row: LineRow): Record<string, unknown> {
  return {
    id: row.id,
    reconciliation_id: row.reconciliation_id,
    lot_id: row.lot_id,
    lot_number: row.lot_number,
    product_id: row.product_id,
    seed_to_sale_qty_mg: row.seed_to_sale_qty_mg,
    seed_to_sale_qty_units: row.seed_to_sale_qty_units,
    paper_record_qty_mg: row.paper_record_qty_mg,
    paper_record_qty_units: row.paper_record_qty_units,
    allocated_qty_mg: row.allocated_qty_mg,
    allocated_qty_units: row.allocated_qty_units,
    produced_qty_mg: row.produced_qty_mg,
    produced_qty_units: row.produced_qty_units,
    variance_mg: row.variance_mg,
    variance_units: row.variance_units,
    match_status: row.match_status,
    discrepancy_id: row.discrepancy_id,
    created_at: row.created_at,
  };
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
  };
}

const RECONCILIATION_COLUMNS = `
  id, organization_id, site_id, scope_type, scope_reference, started_at,
  completed_at, run_by, status, summary, seed_to_sale_snapshot_id,
  external_import_run_id, created_at, updated_at
`;

const RECONCILIATION_SELECT = `
  ${RECONCILIATION_COLUMNS}
  FROM reconciliations
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

/** Validate the scope at creation time, so a run cannot be created against a scope that does not exist. */
async function validateScope(
  client: {
    query: (text: string, values: unknown[]) => Promise<{ rows: { exists: boolean }[] }>;
  },
  organizationId: string,
  scopeType: ScopeType,
  scopeReference: string,
  siteId: string | null,
): Promise<string | null> {
  // Returns the site_id to store (null unless the scope is a single site).
  if (scopeType === "LOT") {
    const found = await client.query(
      `SELECT EXISTS (SELECT 1 FROM lots WHERE organization_id = $1 AND lot_number = $2) AS exists`,
      [organizationId, scopeReference],
    );
    if (!found.rows[0]?.exists) {
      throw badRequest(
        "SCOPE_NOT_FOUND",
        `Lot ${scopeReference} does not exist in this organization.`,
      );
    }
    return siteId;
  }
  if (scopeType === "PRODUCT") {
    if (!isUuid(scopeReference)) {
      throw badRequest("INVALID_SCOPE", "PRODUCT scope_reference must be a product UUID.");
    }
    const found = await client.query(
      `SELECT EXISTS (SELECT 1 FROM products WHERE organization_id = $1 AND id = $2) AS exists`,
      [organizationId, scopeReference],
    );
    if (!found.rows[0]?.exists) {
      throw badRequest("SCOPE_NOT_FOUND", "Product does not exist in this organization.");
    }
    return siteId;
  }
  if (scopeType === "SITE") {
    if (scopeReference === "ALL") return null;
    if (!isUuid(scopeReference)) {
      throw badRequest("INVALID_SCOPE", 'SITE scope_reference must be a site UUID or "ALL".');
    }
    const found = await client.query(
      `SELECT EXISTS (SELECT 1 FROM sites WHERE organization_id = $1 AND id = $2) AS exists`,
      [organizationId, scopeReference],
    );
    if (!found.rows[0]?.exists) {
      throw badRequest("SCOPE_NOT_FOUND", "Site does not exist in this organization.");
    }
    return scopeReference;
  }
  // DATE_RANGE
  const parts = scopeReference.split("..");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw badRequest(
      "INVALID_SCOPE",
      'DATE_RANGE scope_reference must be "YYYY-MM-DD..YYYY-MM-DD".',
    );
  }
  const from = new Date(`${parts[0]}T00:00:00.000Z`);
  const to = new Date(`${parts[1]}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw badRequest("INVALID_SCOPE", "DATE_RANGE scope_reference holds invalid dates.");
  }
  return siteId;
}

/** Create a DRAFT reconciliation run. */
reconciliationsRouter.post("/", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const scopeType = req.body?.scope_type;
  if (typeof scopeType !== "string" || !(SCOPE_TYPES as readonly string[]).includes(scopeType)) {
    throw badRequest("INVALID_FIELD", `scope_type must be one of: ${SCOPE_TYPES.join(", ")}.`);
  }
  const scopeReference = req.body?.scope_reference;
  if (typeof scopeReference !== "string" || scopeReference.trim() === "") {
    throw badRequest("INVALID_FIELD", "scope_reference is required.");
  }
  const externalImportRunId = req.body?.external_import_run_id;
  if (typeof externalImportRunId !== "string" || !isUuid(externalImportRunId)) {
    throw badRequest(
      "INVALID_FIELD",
      "external_import_run_id is required and must be an import run UUID.",
    );
  }
  const siteId =
    req.body?.site_id === undefined || req.body?.site_id === null || req.body?.site_id === ""
      ? null
      : req.body.site_id;
  if (siteId !== null && (typeof siteId !== "string" || !isUuid(siteId))) {
    throw badRequest("INVALID_FIELD", "site_id must be a UUID.");
  }

  const created = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    const storedSiteId = await validateScope(
      client,
      organizationId,
      scopeType as ScopeType,
      scopeReference,
      siteId,
    );
    const importRun = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM import_runs WHERE id = $1 AND organization_id = $2) AS exists`,
      [externalImportRunId, organizationId],
    );
    if (!importRun.rows[0]?.exists) {
      throw badRequest(
        "IMPORT_RUN_NOT_FOUND",
        "external_import_run_id does not exist in this organization.",
      );
    }
    const inserted = await client.query<ReconciliationRow>(
      `INSERT INTO reconciliations
         (organization_id, site_id, scope_type, scope_reference, run_by,
          status, external_import_run_id)
       VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6)
       RETURNING ${RECONCILIATION_COLUMNS}`,
      [organizationId, storedSiteId, scopeType, scopeReference, userId, externalImportRunId],
    );
    return inserted.rows[0];
  });
  res.status(201).json({ reconciliation: toRunSummary(created) });
});

/** Execute a DRAFT run. The engine runs in the same transaction as the status flip. */
reconciliationsRouter.post("/:id/run", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const reconciliationId = paramString(req.params.id, "reconciliation id");
  if (!isUuid(reconciliationId)) {
    throw badRequest("INVALID_ID", "Reconciliation id must be a UUID.");
  }
  const summary = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    return runReconciliationEngine(client, {
      organizationId,
      reconciliationId,
      runBy: userId,
    });
  });
  const updated = await withTenant(organizationId, async (client) => {
    const { rows } = await client.query<ReconciliationRow>(
      `SELECT ${RECONCILIATION_SELECT} WHERE id = $1 AND organization_id = $2`,
      [reconciliationId, organizationId],
    );
    if (rows.length === 0) {
      throw notFound("RECONCILIATION_NOT_FOUND", "No reconciliation with this id.");
    }
    return rows[0];
  });
  res.status(200).json({ reconciliation: toRunSummary(updated), summary });
});

/** List runs for this tenant, newest first. */
reconciliationsRouter.get("/", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  const { rows } = await withTenant(organizationId, async (client) =>
    client.query<ReconciliationRow>(
      `SELECT ${RECONCILIATION_SELECT} WHERE organization_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [organizationId, limit, offset],
    ),
  );
  res.status(200).json({ reconciliations: rows.map(toRunSummary), limit, offset });
});

/** One run with its lines and discrepancies. */
reconciliationsRouter.get("/:id", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const reconciliationId = paramString(req.params.id, "reconciliation id");
  if (!isUuid(reconciliationId)) {
    throw badRequest("INVALID_ID", "Reconciliation id must be a UUID.");
  }
  const result = await withTenant(organizationId, async (client) => {
    const run = await client.query<ReconciliationRow>(
      `SELECT ${RECONCILIATION_SELECT} WHERE id = $1 AND organization_id = $2`,
      [reconciliationId, organizationId],
    );
    if (run.rows.length === 0) {
      throw notFound("RECONCILIATION_NOT_FOUND", "No reconciliation with this id.");
    }
    const lines = await client.query<LineRow>(
      `SELECT rl.*, l.lot_number
       FROM reconciliation_lines rl
       LEFT JOIN lots l ON l.id = rl.lot_id
       WHERE rl.reconciliation_id = $1 ORDER BY rl.created_at ASC`,
      [reconciliationId],
    );
    const discrepancies = await client.query<DiscrepancyRow>(
      `SELECT d.*, l.lot_number
       FROM discrepancies d
       LEFT JOIN lots l ON l.id = d.lot_id
       WHERE d.reconciliation_id = $1 ORDER BY d.opened_at ASC`,
      [reconciliationId],
    );
    return {
      run: run.rows[0],
      lines: lines.rows,
      discrepancies: discrepancies.rows,
    };
  });
  res.status(200).json({
    reconciliation: toRunSummary(result.run),
    lines: result.lines.map(toLineSummary),
    discrepancies: result.discrepancies.map(toDiscrepancySummary),
  });
});
