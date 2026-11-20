import type { PoolClient } from "pg";
import { recordAuditEvent } from "@qualios/db";
import { badRequest } from "./errors.js";

/**
 * Reconciliation engine v0 (PRD FR-04, backlog Q-022, Data Model §4).
 *
 * One run compares, lot by lot, two sides:
 *   - the QualiOS ledger: current positions derived from inventory_movements
 *     (never a stored number — Data Model §2), and
 *   - the external record set: the accepted rows of one import run
 *     (a seed-to-sale export, a paper count sheet, or an allocation).
 *
 * Classification rules (per lot, per quantity dimension — milligrams and
 * units are compared independently, because a lot can carry both):
 *
 *   SEED_TO_SALE / PAPER_COUNT (external = what the outside system says):
 *     external > 0, ledger 0            -> PHANTOM_STOCK (nothing physical)
 *     external 0, ledger > 0            -> UNEXPLAINED_MOVEMENT
 *     external > ledger, both > 0       -> SHORTAGE (ledger short vs external)
 *     ledger > external, both > 0       -> UNEXPLAINED_MOVEMENT
 *     external missing                  -> MISSING_SOURCE line, no discrepancy
 *       (the file may be a partial export; absence is not proof of absence)
 *   ALLOCATION (external = demand for shippable product):
 *     allocated > ledger                -> SHORTAGE
 *     produced > allocated              -> UNALLOCATED_PRODUCTION
 *     allocated > 0, packaged 0, bulk > 0 -> BULK_VS_PACKAGED (cannot ship)
 *   Any kind:
 *     external row references a lot that does not exist in this org
 *                                        -> LOT_MISMATCH (from the rejected
 *                                           import row, which is never dropped)
 *
 * The engine never resolves anything: every discrepancy it creates is OPEN
 * and a human must move it through the workflow (routes/discrepancies.ts).
 * It never posts a correction anywhere. Quantities are compared exactly
 * (integer milligrams / units); there is no tolerance in v0 — a tolerance
 * config is a later decision, and silently tolerating a variance would hide
 * exactly what this wedge exists to find.
 *
 * Out of scope for v0: excise (the SK/MB difference in PRD case 5 is a
 * calculation, not an inventory discrepancy — the excise engine is a later
 * step and this engine performs no excise calculation).
 */

export type DiscrepancyType =
  | "PHANTOM_STOCK"
  | "SHORTAGE"
  | "UNALLOCATED_PRODUCTION"
  | "LOT_MISMATCH"
  | "BULK_VS_PACKAGED"
  | "UNEXPLAINED_MOVEMENT";

export type DiscrepancySeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface EngineSummary {
  lots_compared: number;
  matched: number;
  variance: number;
  missing_source: number;
  discrepancies_by_type: Record<string, number>;
  discrepancies_total: number;
  external_rows_excluded_no_date: number;
}

interface LotComparison {
  lotId: string;
  lotNumber: string;
  productId: string | null;
  ledgerMg: number | null;
  ledgerUnits: number | null;
  packagedMg: number;
  packagedUnits: number;
  bulkMg: number;
  bulkUnits: number;
  externalMg: number | null;
  externalUnits: number | null;
  producedMg: number | null;
  producedUnits: number | null;
}

interface DiscrepancySpec {
  type: DiscrepancyType;
  severity: DiscrepancySeverity;
  description: string;
  quantityMg: number | null;
  quantityUnits: number | null;
  evidence: Record<string, unknown>;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function severityFor(
  type: DiscrepancyType,
  quantityMg: number | null,
  quantityUnits: number | null,
): DiscrepancySeverity {
  const mg = quantityMg ?? null;
  const units = quantityUnits ?? null;
  switch (type) {
    case "LOT_MISMATCH":
      return "HIGH";
    case "BULK_VS_PACKAGED":
    case "UNEXPLAINED_MOVEMENT":
      return "MEDIUM";
    case "PHANTOM_STOCK":
      if (mg !== null) return mg >= 1_000_000 ? "HIGH" : mg >= 100_000 ? "MEDIUM" : "LOW";
      if (units !== null) return units >= 1000 ? "HIGH" : units >= 100 ? "MEDIUM" : "LOW";
      return "LOW";
    case "SHORTAGE":
      if (mg !== null) return mg >= 1_000_000 ? "HIGH" : mg >= 100_000 ? "MEDIUM" : "LOW";
      if (units !== null) return units >= 200 ? "HIGH" : units >= 50 ? "MEDIUM" : "LOW";
      return "LOW";
    case "UNALLOCATED_PRODUCTION":
      if (units !== null) return units >= 1000 ? "HIGH" : units >= 100 ? "MEDIUM" : "LOW";
      if (mg !== null) return mg >= 1_000_000 ? "HIGH" : mg >= 100_000 ? "MEDIUM" : "LOW";
      return "LOW";
  }
}

interface ScopeFilter {
  siteId: string | null;
  lotNumber: string | null;
  productId: string | null;
  from: Date | null;
  to: Date | null;
}

function parseScope(scopeType: string, scopeReference: string, siteId: string | null): ScopeFilter {
  const scope: ScopeFilter = {
    siteId: siteId,
    lotNumber: null,
    productId: null,
    from: null,
    to: null,
  };
  if (scopeType === "LOT") {
    scope.lotNumber = scopeReference;
  } else if (scopeType === "PRODUCT") {
    scope.productId = scopeReference;
  } else if (scopeType === "SITE") {
    scope.siteId = scopeReference === "ALL" ? null : scopeReference;
  } else if (scopeType === "DATE_RANGE") {
    const parts = scopeReference.split("..");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw badRequest(
        "INVALID_SCOPE",
        'DATE_RANGE scope_reference must be "YYYY-MM-DD..YYYY-MM-DD".',
      );
    }
    scope.from = new Date(`${parts[0]}T00:00:00.000Z`);
    scope.to = new Date(`${parts[1]}T23:59:59.999Z`);
    if (Number.isNaN(scope.from.getTime()) || Number.isNaN(scope.to.getTime())) {
      throw badRequest("INVALID_SCOPE", "DATE_RANGE scope_reference holds invalid dates.");
    }
  }
  return scope;
}

interface ExternalRow {
  lot_number: string;
  quantity_mg: number | null;
  quantity_units: number | null;
  recorded_date: string | null;
}

/**
 * Run the engine for one DRAFT reconciliation. The caller holds the
 * transaction (withTenant): the status flip, lines, discrepancies, summary
 * and audit events commit or roll back together. Throws on a bad run
 * (missing import, FAILED import, empty scope) before writing anything.
 */
export async function runReconciliationEngine(
  client: PoolClient,
  args: {
    organizationId: string;
    reconciliationId: string;
    runBy: string;
  },
): Promise<EngineSummary> {
  const { organizationId, reconciliationId, runBy } = args;

  const runRes = await client.query<{
    id: string;
    scope_type: string;
    scope_reference: string;
    site_id: string | null;
    external_import_run_id: string | null;
    status: string;
  }>(
    `SELECT id, scope_type, scope_reference, site_id, external_import_run_id, status
     FROM reconciliations WHERE id = $1 AND organization_id = $2`,
    [reconciliationId, organizationId],
  );
  const recon = runRes.rows[0];
  if (!recon) {
    throw badRequest("RECONCILIATION_NOT_FOUND", "No reconciliation with this id.");
  }
  if (recon.status !== "DRAFT") {
    throw badRequest(
      "RECONCILIATION_NOT_DRAFT",
      `Reconciliation is ${recon.status}; only a DRAFT run can be executed.`,
    );
  }
  if (!recon.external_import_run_id) {
    throw badRequest(
      "NO_EXTERNAL_SOURCE",
      "This reconciliation has no external import run to compare against.",
    );
  }

  const importRes = await client.query<{
    id: string;
    import_kind: string;
    status: string;
  }>(
    `SELECT id, import_kind, status FROM import_runs
     WHERE id = $1 AND organization_id = $2`,
    [recon.external_import_run_id, organizationId],
  );
  const importRun = importRes.rows[0];
  if (!importRun) {
    throw badRequest("IMPORT_RUN_NOT_FOUND", "The external import run does not exist.");
  }
  if (importRun.status === "FAILED") {
    throw badRequest(
      "IMPORT_RUN_FAILED",
      "The external import run failed; there is no external record set to compare.",
    );
  }
  const importKind = importRun.import_kind as "SEED_TO_SALE" | "PAPER_COUNT" | "ALLOCATION";
  const scope = parseScope(recon.scope_type, recon.scope_reference, recon.site_id);

  await client.query(
    `UPDATE reconciliations SET status = 'RUNNING', started_at = now()
     WHERE id = $1 AND organization_id = $2`,
    [reconciliationId, organizationId],
  );

  // ---- External record set: accepted rows of the import run, by lot. ----
  const externalRes = await client.query<ExternalRow>(
    `SELECT lot_number, quantity_mg, quantity_units, recorded_date
     FROM import_rows
     WHERE import_run_id = $1 AND status = 'ACCEPTED' AND lot_number IS NOT NULL`,
    [importRun.id],
  );
  const externalByLot = new Map<
    string,
    { mg: number | null; units: number | null; rows: number }
  >();
  let excludedNoDate = 0;
  for (const row of externalRes.rows) {
    if (scope.from !== null && scope.to !== null) {
      const when = row.recorded_date === null ? null : new Date(row.recorded_date);
      if (when === null || when < scope.from || when > scope.to) {
        excludedNoDate += 1;
        continue;
      }
    }
    const current = externalByLot.get(row.lot_number) ?? { mg: null, units: null, rows: 0 };
    if (row.quantity_mg !== null) current.mg = (current.mg ?? 0) + row.quantity_mg;
    if (row.quantity_units !== null) current.units = (current.units ?? 0) + row.quantity_units;
    current.rows += 1;
    externalByLot.set(row.lot_number, current);
  }

  // ---- Ledger side: positions per lot (derived from the movement ledger). ----
  // DATE_RANGE scope compares activity in the range; every other scope
  // compares the current position (all-time).
  const ledgerParams: unknown[] = [organizationId];
  let ledgerSql: string;
  if (scope.from !== null && scope.to !== null) {
    ledgerSql = `
      SELECT m.lot_id, l.stock_state,
             COALESCE(SUM(m.quantity_mg), 0)::bigint AS quantity_mg,
             COALESCE(SUM(m.quantity_units), 0)::bigint AS quantity_units
      FROM inventory_movements m
      JOIN inventory_locations l ON l.id = m.location_id
      WHERE m.organization_id = $1 AND m.recorded_at >= $2 AND m.recorded_at <= $3`;
    ledgerParams.push(scope.from.toISOString(), scope.to.toISOString());
    if (scope.siteId !== null) {
      ledgerSql += ` AND l.site_id = $${ledgerParams.length + 1}`;
      ledgerParams.push(scope.siteId);
    }
    ledgerSql += ` GROUP BY m.lot_id, l.stock_state`;
  } else {
    ledgerSql = `
      SELECT p.lot_id, p.stock_state, p.quantity_mg, p.quantity_units
      FROM inventory_positions p
      WHERE p.organization_id = $1`;
    if (scope.siteId !== null) {
      ledgerSql += ` AND p.location_id IN (SELECT id FROM inventory_locations WHERE site_id = $${ledgerParams.length + 1})`;
      ledgerParams.push(scope.siteId);
    }
  }
  const ledgerRes = await client.query<{
    lot_id: string;
    stock_state: string;
    quantity_mg: string;
    quantity_units: string;
  }>(ledgerSql, ledgerParams);

  // Produced quantities (PRODUCE movements) per lot, for ALLOCATION runs.
  // Same scope filters as the ledger side, so a site- or date-scoped run
  // does not count production from outside its scope.
  const producedParams: unknown[] = [organizationId];
  let producedSql = `
    SELECT m.lot_id,
           COALESCE(SUM(m.quantity_mg), 0)::bigint AS quantity_mg,
           COALESCE(SUM(m.quantity_units), 0)::bigint AS quantity_units
    FROM inventory_movements m
    WHERE m.organization_id = $1 AND m.movement_type = 'PRODUCE'`;
  if (scope.from !== null && scope.to !== null) {
    producedSql += ` AND m.recorded_at >= $${producedParams.length + 1} AND m.recorded_at <= $${producedParams.length + 2}`;
    producedParams.push(scope.from.toISOString(), scope.to.toISOString());
  }
  if (scope.siteId !== null) {
    producedSql += ` AND m.location_id IN (SELECT id FROM inventory_locations WHERE site_id = $${producedParams.length + 1})`;
    producedParams.push(scope.siteId);
  }
  producedSql += ` GROUP BY m.lot_id`;
  const producedRes = await client.query<{
    lot_id: string;
    quantity_mg: string;
    quantity_units: string;
  }>(producedSql, producedParams);
  const producedByLot = new Map(
    producedRes.rows.map((r) => [
      r.lot_id,
      { mg: Number(r.quantity_mg), units: Number(r.quantity_units) },
    ]),
  );

  // Lot identity for every lot in either side.
  const lotIds = new Set<string>(ledgerRes.rows.map((r) => r.lot_id));
  const lotNumbers = [...externalByLot.keys()];
  const lotLookup =
    lotNumbers.length > 0
      ? await client.query<{ id: string; lot_number: string; product_id: string | null }>(
          `SELECT id, lot_number, product_id FROM lots
           WHERE organization_id = $1 AND lot_number = ANY ($2)`,
          [organizationId, lotNumbers],
        )
      : { rows: [] as { id: string; lot_number: string; product_id: string | null }[] };
  for (const row of lotLookup.rows) lotIds.add(row.id);
  const lotByNumber = new Map(lotLookup.rows.map((r) => [r.lot_number, r]));

  // Apply LOT / PRODUCT scope to the lot set.
  let scopedLotIds = [...lotIds];
  if (scope.lotNumber !== null) {
    const only = lotByNumber.get(scope.lotNumber);
    scopedLotIds = only ? [only.id] : [];
  } else if (scope.productId !== null) {
    const productLots = await client.query<{ id: string }>(
      `SELECT id FROM lots WHERE organization_id = $1 AND product_id = $2`,
      [organizationId, scope.productId],
    );
    const allowed = new Set(productLots.rows.map((r) => r.id));
    scopedLotIds = scopedLotIds.filter((id) => allowed.has(id));
  }

  const lotMeta =
    scopedLotIds.length > 0
      ? await client.query<{ id: string; lot_number: string; product_id: string | null }>(
          `SELECT id, lot_number, product_id FROM lots
           WHERE organization_id = $1 AND id = ANY ($2)`,
          [organizationId, scopedLotIds],
        )
      : { rows: [] as { id: string; lot_number: string; product_id: string | null }[] };
  const metaById = new Map(lotMeta.rows.map((r) => [r.id, r]));

  // Ledger positions aggregated per lot, split by stock state.
  const ledgerByLot = new Map<
    string,
    {
      mg: number;
      units: number;
      packagedMg: number;
      packagedUnits: number;
      bulkMg: number;
      bulkUnits: number;
    }
  >();
  for (const row of ledgerRes.rows) {
    if (!metaById.has(row.lot_id)) continue;
    const current = ledgerByLot.get(row.lot_id) ?? {
      mg: 0,
      units: 0,
      packagedMg: 0,
      packagedUnits: 0,
      bulkMg: 0,
      bulkUnits: 0,
    };
    const mg = Number(row.quantity_mg);
    const units = Number(row.quantity_units);
    current.mg += mg;
    current.units += units;
    if (row.stock_state === "PACKAGED") {
      current.packagedMg += mg;
      current.packagedUnits += units;
    } else if (row.stock_state === "BULK") {
      current.bulkMg += mg;
      current.bulkUnits += units;
    }
    ledgerByLot.set(row.lot_id, current);
  }

  const summary: EngineSummary = {
    lots_compared: 0,
    matched: 0,
    variance: 0,
    missing_source: 0,
    discrepancies_by_type: {},
    discrepancies_total: 0,
    external_rows_excluded_no_date: excludedNoDate,
  };
  const countDiscrepancy = (type: DiscrepancyType): void => {
    summary.discrepancies_by_type[type] = (summary.discrepancies_by_type[type] ?? 0) + 1;
    summary.discrepancies_total += 1;
  };

  const isAllocation = importKind === "ALLOCATION";

  for (const lotId of scopedLotIds) {
    const meta = metaById.get(lotId);
    if (!meta) continue;
    const ledger = ledgerByLot.get(lotId);
    const external = externalByLot.get(meta.lot_number);
    const produced = producedByLot.get(lotId);
    const comparison: LotComparison = {
      lotId,
      lotNumber: meta.lot_number,
      productId: meta.product_id,
      ledgerMg: ledger ? ledger.mg : null,
      ledgerUnits: ledger ? ledger.units : null,
      packagedMg: ledger ? ledger.packagedMg : 0,
      packagedUnits: ledger ? ledger.packagedUnits : 0,
      bulkMg: ledger ? ledger.bulkMg : 0,
      bulkUnits: ledger ? ledger.bulkUnits : 0,
      externalMg: external ? external.mg : null,
      externalUnits: external ? external.units : null,
      producedMg: produced ? produced.mg : null,
      producedUnits: produced ? produced.units : null,
    };

    const specs: DiscrepancySpec[] = [];
    const evidenceBase = {
      ledger_qty_mg: comparison.ledgerMg,
      ledger_qty_units: comparison.ledgerUnits,
      external_qty_mg: comparison.externalMg,
      external_qty_units: comparison.externalUnits,
      external_kind: importKind,
      import_run_id: importRun.id,
      packaged_qty_mg: comparison.packagedMg,
      packaged_qty_units: comparison.packagedUnits,
      bulk_qty_mg: comparison.bulkMg,
      bulk_qty_units: comparison.bulkUnits,
      produced_qty_mg: comparison.producedMg,
      produced_qty_units: comparison.producedUnits,
    };

    const checkDimension = (
      dimension: "mg" | "units",
      externalQty: number | null,
      ledgerQty: number | null,
    ): void => {
      const unitLabel = dimension === "mg" ? "mg" : "units";
      const ext = externalQty;
      const led = ledgerQty ?? 0;
      if (ext === null) return; // handled by MISSING_SOURCE at the line level
      const push = (
        type: DiscrepancyType,
        description: string,
        quantityMg: number | null,
        quantityUnits: number | null,
      ): void => {
        specs.push({
          type,
          severity: severityFor(type, quantityMg, quantityUnits),
          description,
          quantityMg,
          quantityUnits,
          evidence: { ...evidenceBase, dimension: unitLabel },
        });
      };
      if (!isAllocation) {
        if (led === 0 && ext > 0) {
          push(
            "PHANTOM_STOCK",
            `External ${importKind === "SEED_TO_SALE" ? "seed-to-sale" : "paper"} record shows ${fmt(ext)} ${unitLabel} for lot ${comparison.lotNumber}; the QualiOS ledger shows 0 ${unitLabel}. Phantom stock in the external system.`,
            dimension === "mg" ? ext : null,
            dimension === "units" ? ext : null,
          );
        } else if (ext === 0 && led > 0) {
          push(
            "UNEXPLAINED_MOVEMENT",
            `External record shows 0 ${unitLabel} for lot ${comparison.lotNumber}; the QualiOS ledger holds ${fmt(led)} ${unitLabel} with no matching external record.`,
            dimension === "mg" ? led : null,
            dimension === "units" ? led : null,
          );
        } else if (ext > led) {
          push(
            "SHORTAGE",
            `External record shows ${fmt(ext)} ${unitLabel} for lot ${comparison.lotNumber}; the QualiOS ledger holds ${fmt(led)} ${unitLabel} — ${fmt(ext - led)} ${unitLabel} short.`,
            dimension === "mg" ? ext - led : null,
            dimension === "units" ? ext - led : null,
          );
        } else if (led > ext) {
          push(
            "UNEXPLAINED_MOVEMENT",
            `External record shows ${fmt(ext)} ${unitLabel} for lot ${comparison.lotNumber}; the QualiOS ledger holds ${fmt(led)} ${unitLabel} — ${fmt(led - ext)} ${unitLabel} more than the external record.`,
            dimension === "mg" ? led - ext : null,
            dimension === "units" ? led - ext : null,
          );
        }
      } else {
        if (ext > led) {
          push(
            "SHORTAGE",
            `Allocation calls for ${fmt(ext)} ${unitLabel} of lot ${comparison.lotNumber}; the QualiOS ledger holds ${fmt(led)} ${unitLabel} — ${fmt(ext - led)} ${unitLabel} short.`,
            dimension === "mg" ? ext - led : null,
            dimension === "units" ? ext - led : null,
          );
        }
      }
    };

    checkDimension("mg", comparison.externalMg, comparison.ledgerMg);
    checkDimension("units", comparison.externalUnits, comparison.ledgerUnits);

    if (isAllocation) {
      // Produced vs allocated: production with no home on any allocation.
      const producedCheck = (
        dimension: "mg" | "units",
        producedQty: number | null,
        allocatedQty: number | null,
      ): void => {
        if (producedQty === null || allocatedQty === null) return;
        if (producedQty <= allocatedQty) return;
        const unitLabel = dimension === "mg" ? "mg" : "units";
        specs.push({
          type: "UNALLOCATED_PRODUCTION",
          severity: severityFor(
            "UNALLOCATED_PRODUCTION",
            dimension === "mg" ? producedQty - allocatedQty : null,
            dimension === "units" ? producedQty - allocatedQty : null,
          ),
          description: `Lot ${comparison.lotNumber} produced ${fmt(producedQty)} ${unitLabel}; the allocation covers ${fmt(allocatedQty)} ${unitLabel} — ${fmt(producedQty - allocatedQty)} ${unitLabel} with no home on any allocation.`,
          quantityMg: dimension === "mg" ? producedQty - allocatedQty : null,
          quantityUnits: dimension === "units" ? producedQty - allocatedQty : null,
          evidence: { ...evidenceBase, dimension: unitLabel },
        });
      };
      producedCheck("mg", comparison.producedMg, comparison.externalMg);
      producedCheck("units", comparison.producedUnits, comparison.externalUnits);
      // Bulk vs packaged: an allocation can only be filled from packaged stock.
      const bulkCheck = (
        dimension: "mg" | "units",
        allocatedQty: number | null,
        packagedQty: number,
        bulkQty: number,
      ): void => {
        if (allocatedQty === null || allocatedQty <= 0) return;
        if (packagedQty !== 0 || bulkQty <= 0) return;
        const unitLabel = dimension === "mg" ? "mg" : "units";
        specs.push({
          type: "BULK_VS_PACKAGED",
          severity: "MEDIUM",
          description: `Lot ${comparison.lotNumber} holds ${fmt(bulkQty)} ${unitLabel} in bulk and 0 ${unitLabel} packaged, but the allocation calls for ${fmt(allocatedQty)} ${unitLabel} of shippable (packaged) stock.`,
          quantityMg: dimension === "mg" ? bulkQty : null,
          quantityUnits: dimension === "units" ? bulkQty : null,
          evidence: { ...evidenceBase, dimension: unitLabel },
        });
      };
      bulkCheck("mg", comparison.externalMg, comparison.packagedMg, comparison.bulkMg);
      bulkCheck("units", comparison.externalUnits, comparison.packagedUnits, comparison.bulkUnits);
    }

    // ---- Line + discrepancies. ----
    const externalPresent = comparison.externalMg !== null || comparison.externalUnits !== null;
    const ledgerPresent = comparison.ledgerMg !== null || comparison.ledgerUnits !== null;
    let matchStatus: "MATCH" | "VARIANCE" | "MISSING_SOURCE";
    if (!externalPresent) {
      matchStatus = "MISSING_SOURCE";
    } else if (
      (comparison.externalMg ?? null) === (comparison.ledgerMg ?? null) &&
      (comparison.externalUnits ?? null) === (comparison.ledgerUnits ?? null) &&
      ledgerPresent
    ) {
      matchStatus = "MATCH";
    } else {
      matchStatus = "VARIANCE";
    }
    summary.lots_compared += 1;
    if (matchStatus === "MATCH") summary.matched += 1;
    if (matchStatus === "VARIANCE") summary.variance += 1;
    if (matchStatus === "MISSING_SOURCE") summary.missing_source += 1;

    const discrepancyIds: string[] = [];
    for (const spec of specs) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO discrepancies
           (organization_id, reconciliation_id, lot_id, product_id,
            discrepancy_type, severity, description, quantity_mg, quantity_units,
            status, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10::jsonb)
         RETURNING id`,
        [
          organizationId,
          reconciliationId,
          lotId,
          comparison.productId,
          spec.type,
          spec.severity,
          spec.description,
          spec.quantityMg,
          spec.quantityUnits,
          JSON.stringify(spec.evidence),
        ],
      );
      const discrepancyId = inserted.rows[0].id;
      discrepancyIds.push(discrepancyId);
      countDiscrepancy(spec.type);
      await recordAuditEvent(client, {
        organizationId,
        actorId: runBy,
        eventType: "DISCREPANCY_OPENED",
        targetType: "discrepancy",
        targetId: discrepancyId,
        payload: {
          discrepancy_type: spec.type,
          severity: spec.severity,
          lot_number: comparison.lotNumber,
          reconciliation_id: reconciliationId,
          quantity_mg: spec.quantityMg,
          quantity_units: spec.quantityUnits,
        },
        modelVersion: null,
        createdAt: new Date(),
      });
    }

    const varianceMg =
      comparison.externalMg !== null && comparison.ledgerMg !== null
        ? comparison.externalMg - comparison.ledgerMg
        : null;
    const varianceUnits =
      comparison.externalUnits !== null && comparison.ledgerUnits !== null
        ? comparison.externalUnits - comparison.ledgerUnits
        : null;
    await client.query(
      `INSERT INTO reconciliation_lines
         (reconciliation_id, lot_id, product_id,
          seed_to_sale_qty_mg, seed_to_sale_qty_units,
          paper_record_qty_mg, paper_record_qty_units,
          allocated_qty_mg, allocated_qty_units,
          produced_qty_mg, produced_qty_units,
          variance_mg, variance_units, match_status, discrepancy_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        reconciliationId,
        lotId,
        comparison.productId,
        isAllocation ? null : comparison.externalMg,
        isAllocation ? null : comparison.externalUnits,
        comparison.ledgerMg,
        comparison.ledgerUnits,
        isAllocation ? comparison.externalMg : null,
        isAllocation ? comparison.externalUnits : null,
        comparison.producedMg,
        comparison.producedUnits,
        varianceMg,
        varianceUnits,
        matchStatus,
        discrepancyIds[0] ?? null,
      ],
    );
  }

  // ---- LOT_MISMATCH: external rows referencing lots that do not exist. ----
  // These rows were REJECTED at import (the row is never silently dropped),
  // and the reconciliation surfaces each distinct unknown lot as a
  // discrepancy so the mismatch is triaged instead of buried in the log.
  // A LOT-scoped run only surfaces its own lot; other scopes see the whole
  // file (lot numbers are org-wide, and the file is this run's source).
  const mismatchParams: unknown[] = [importRun.id];
  let mismatchSql = `
    SELECT lot_number,
           SUM(quantity_mg)::bigint AS quantity_mg,
           SUM(quantity_units)::bigint AS quantity_units
    FROM import_rows
    WHERE import_run_id = $1 AND status = 'REJECTED' AND error LIKE 'LOT_NOT_FOUND%'
      AND lot_number IS NOT NULL`;
  if (scope.lotNumber !== null) {
    mismatchSql += ` AND lot_number = $${mismatchParams.length + 1}`;
    mismatchParams.push(scope.lotNumber);
  }
  mismatchSql += ` GROUP BY lot_number`;
  const mismatchRes = await client.query<{
    lot_number: string;
    quantity_mg: number | null;
    quantity_units: number | null;
  }>(mismatchSql, mismatchParams);
  for (const row of mismatchRes.rows) {
    const lotNumber = row.lot_number;
    // Only lots that still do not exist (one may have been created since).
    const exists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM lots WHERE organization_id = $1 AND lot_number = $2) AS exists`,
      [organizationId, lotNumber],
    );
    if (exists.rows[0]?.exists) continue;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO discrepancies
         (organization_id, reconciliation_id, lot_id, product_id,
          discrepancy_type, severity, description, quantity_mg, quantity_units,
          status, evidence)
       VALUES ($1, $2, NULL, NULL, 'LOT_MISMATCH', 'HIGH', $3, $4, $5, 'OPEN', $6::jsonb)
       RETURNING id`,
      [
        organizationId,
        reconciliationId,
        `External record references lot ${lotNumber}, which does not exist as an active lot in this organization.`,
        row.quantity_mg === null ? null : Number(row.quantity_mg),
        row.quantity_units === null ? null : Number(row.quantity_units),
        JSON.stringify({
          lot_number: lotNumber,
          external_kind: importKind,
          import_run_id: importRun.id,
        }),
      ],
    );
    countDiscrepancy("LOT_MISMATCH");
    await recordAuditEvent(client, {
      organizationId,
      actorId: runBy,
      eventType: "DISCREPANCY_OPENED",
      targetType: "discrepancy",
      targetId: inserted.rows[0].id,
      payload: {
        discrepancy_type: "LOT_MISMATCH",
        severity: "HIGH",
        lot_number: lotNumber,
        reconciliation_id: reconciliationId,
      },
      modelVersion: null,
      createdAt: new Date(),
    });
  }

  await client.query(
    `UPDATE reconciliations SET status = 'REVIEW', completed_at = now(), summary = $2
     WHERE id = $1 AND organization_id = $3`,
    [reconciliationId, JSON.stringify(summary), organizationId],
  );
  await recordAuditEvent(client, {
    organizationId,
    actorId: runBy,
    eventType: "RECONCILIATION_COMPLETED",
    targetType: "reconciliation",
    targetId: reconciliationId,
    payload: {
      external_import_run_id: importRun.id,
      external_kind: importKind,
      ...summary,
    },
    modelVersion: null,
    createdAt: new Date(),
  });

  return summary;
}
