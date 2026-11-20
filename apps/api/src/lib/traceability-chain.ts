import type { PoolClient } from "pg";
import { recordAuditEvent } from "@qualios/db";
import { conflict, notFound } from "./errors.js";
import { createTraceLink } from "./traceability.js";

/**
 * Traceability proof of concept (P1, domain model §2.1).
 *
 * One generic chain, no industry concepts in the core — the stage names
 * (receive / consume / finish / ship) are the same for every pack; a pack
 * only supplies its own wording (seed-to-sale, farm-to-table, ...).
 *
 *   receive a lot -> consume it in a batch -> finish goods -> ship
 *   -> trace backward (recall: where did this lot come from?) and
 *      forward (where did this lot go?)
 *
 * Every stage writes to the movement ledger (inventory_movements) AND,
 * where genealogy is created, to traceability_links. The two records are
 * written in the same transaction, so a link's quantities can be checked
 * against the ledger (see checkTraceConsistency) — that is the connection
 * to the inventory reconciliation engine: positions are derived from the
 * movement ledger (inventory_positions view), never stored.
 *
 * The caller holds the transaction (withTenant). Quantities are integer
 * minor units (milligrams for mass, whole units for counted stock).
 */

export interface LotSummary {
  id: string;
  organization_id: string;
  product_id: string | null;
  lot_number: string;
  status: string;
  approved_for_sale: boolean;
}

export interface BatchSummary {
  id: string;
  organization_id: string;
  site_id: string;
  output_lot_id: string;
  output_product_id: string;
  planned_quantity: number;
  produced_quantity: number | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

interface MovementRow {
  id: string;
  lot_id: string;
  movement_type: string;
  quantity_mg: number;
  quantity_units: number | null;
}

function toLotSummary(row: Record<string, unknown>): LotSummary {
  return {
    approved_for_sale: row.approved_for_sale as boolean,
    id: row.id as string,
    lot_number: row.lot_number as string,
    organization_id: row.organization_id as string,
    product_id: row.product_id as string | null,
    status: row.status as string,
  };
}

function toBatchSummary(row: Record<string, unknown>): BatchSummary {
  return {
    completed_at: row.completed_at as string | null,
    id: row.id as string,
    organization_id: row.organization_id as string,
    output_lot_id: row.output_lot_id as string,
    output_product_id: row.output_product_id as string,
    planned_quantity: Number(row.planned_quantity),
    produced_quantity: row.produced_quantity === null ? null : Number(row.produced_quantity),
    site_id: row.site_id as string,
    started_at: row.started_at as string | null,
    status: row.status as string,
  };
}

async function existsInOrg(
  client: PoolClient,
  table: "products" | "lots" | "batches" | "inventory_locations" | "sites",
  organizationId: string,
  id: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2) AS exists`,
    [id, organizationId],
  );
  return rows[0]?.exists === true;
}

async function insertMovement(
  client: PoolClient,
  args: {
    organizationId: string;
    lotId: string;
    locationId: string;
    movementType: string;
    quantityMg: number;
    quantityUnits: number | null;
    enteredBy: string;
    sourceReference: string | null;
    note: string | null;
  },
): Promise<MovementRow> {
  const { rows } = await client.query<MovementRow>(
    `INSERT INTO inventory_movements
       (organization_id, lot_id, location_id, movement_type, quantity_mg,
        quantity_units, source_system, source_reference, recorded_at, entered_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, 'QUALIOS', $7, now(), $8, $9)
     RETURNING id, lot_id, movement_type, quantity_mg, quantity_units`,
    [
      args.organizationId,
      args.lotId,
      args.locationId,
      args.movementType,
      args.quantityMg,
      args.quantityUnits,
      args.sourceReference,
      args.enteredBy,
      args.note,
    ],
  );
  return rows[0];
}

/** Current ledger position of one lot (derived from the movement ledger). */
export async function lotPosition(
  client: PoolClient,
  args: { organizationId: string; lotId: string },
): Promise<{ quantityMg: number; quantityUnits: number }> {
  const { rows } = await client.query<{ quantity_mg: string; quantity_units: string }>(
    `SELECT COALESCE(SUM(quantity_mg), 0) AS quantity_mg,
            COALESCE(SUM(quantity_units), 0) AS quantity_units
     FROM inventory_movements WHERE organization_id = $1 AND lot_id = $2`,
    [args.organizationId, args.lotId],
  );
  return {
    quantityMg: Number(rows[0]?.quantity_mg ?? 0),
    quantityUnits: Number(rows[0]?.quantity_units ?? 0),
  };
}

/**
 * Receive a lot: create the lot and record a RECEIVE movement for it.
 * A lot number that already exists in this organization is a 409 — the
 * caller retries with a new lot number, never by re-receiving the same one.
 */
export async function receiveLot(
  client: PoolClient,
  args: {
    organizationId: string;
    createdBy: string;
    productId: string;
    lotNumber: string;
    locationId: string;
    quantityMg: number;
    quantityUnits: number | null;
    sourceLotNumber?: string | null;
    sourceReference?: string | null;
    note?: string | null;
  },
): Promise<{ lot: LotSummary; movement: MovementRow }> {
  const { organizationId, createdBy } = args;
  if (!(await existsInOrg(client, "products", organizationId, args.productId))) {
    throw notFound("PRODUCT_NOT_FOUND", "Product does not exist in this organization.");
  }
  if (!(await existsInOrg(client, "inventory_locations", organizationId, args.locationId))) {
    throw notFound("LOCATION_NOT_FOUND", "Location does not exist in this organization.");
  }
  const duplicate = await client.query<{ id: string }>(
    `SELECT id FROM lots WHERE organization_id = $1 AND lot_number = $2`,
    [organizationId, args.lotNumber],
  );
  if (duplicate.rows.length > 0) {
    throw conflict(
      "LOT_ALREADY_EXISTS",
      `Lot number ${args.lotNumber} already exists in this organization.`,
    );
  }
  const { rows } = await client.query<Record<string, unknown>>(
    `INSERT INTO lots (organization_id, product_id, lot_number, source_lot_number, status, approved_for_sale)
     VALUES ($1, $2, $3, $4, 'ACTIVE', false) RETURNING *`,
    [organizationId, args.productId, args.lotNumber, args.sourceLotNumber ?? null],
  );
  const lot = toLotSummary(rows[0]);
  const movement = await insertMovement(client, {
    enteredBy: createdBy,
    locationId: args.locationId,
    lotId: lot.id,
    movementType: "RECEIVE",
    note: args.note ?? null,
    organizationId,
    quantityMg: args.quantityMg,
    quantityUnits: args.quantityUnits,
    sourceReference: args.sourceReference ?? null,
  });
  await recordAuditEvent(client, {
    actorId: createdBy,
    createdAt: new Date(),
    eventType: "LOT_RECEIVED",
    modelVersion: null,
    organizationId,
    payload: {
      lot_id: lot.id,
      lot_number: args.lotNumber,
      product_id: args.productId,
      quantity_mg: args.quantityMg,
      quantity_units: args.quantityUnits,
    },
    targetId: lot.id,
    targetType: "lot",
  });
  return { lot, movement };
}

export interface BatchInput {
  lotId: string;
  quantityMg: number;
  quantityUnits: number | null;
}

/**
 * Create a production batch: create the output (finished-goods) lot,
 * the batch in PLANNED status, its batch_inputs, and one CONSUMED_IN
 * traceability link per input lot. No inventory moves yet — quantities
 * move when the batch completes (completeBatch), so a planned batch
 * never changes stock.
 */
export async function createBatch(
  client: PoolClient,
  args: {
    organizationId: string;
    createdBy: string;
    siteId: string;
    outputProductId: string;
    outputLotNumber: string;
    plannedQuantityMg: number;
    inputs: BatchInput[];
    note?: string | null;
  },
): Promise<{ batch: BatchSummary; outputLot: LotSummary; links: Record<string, unknown>[] }> {
  const { organizationId, createdBy } = args;
  if (!(await existsInOrg(client, "sites", organizationId, args.siteId))) {
    throw notFound("SITE_NOT_FOUND", "Site does not exist in this organization.");
  }
  if (!(await existsInOrg(client, "products", organizationId, args.outputProductId))) {
    throw notFound("PRODUCT_NOT_FOUND", "Output product does not exist in this organization.");
  }
  const duplicate = await client.query<{ id: string }>(
    `SELECT id FROM lots WHERE organization_id = $1 AND lot_number = $2`,
    [organizationId, args.outputLotNumber],
  );
  if (duplicate.rows.length > 0) {
    throw conflict(
      "LOT_ALREADY_EXISTS",
      `Lot number ${args.outputLotNumber} already exists in this organization.`,
    );
  }
  for (const input of args.inputs) {
    if (!(await existsInOrg(client, "lots", organizationId, input.lotId))) {
      throw notFound("LOT_NOT_FOUND", `Input lot ${input.lotId} does not exist.`);
    }
  }
  const lotRows = await client.query<Record<string, unknown>>(
    `INSERT INTO lots (organization_id, product_id, lot_number, status, approved_for_sale)
     VALUES ($1, $2, $3, 'ACTIVE', false) RETURNING *`,
    [organizationId, args.outputProductId, args.outputLotNumber],
  );
  const outputLot = toLotSummary(lotRows.rows[0]);
  const batchRows = await client.query<Record<string, unknown>>(
    `INSERT INTO batches
       (organization_id, site_id, output_lot_id, output_product_id, planned_quantity, status, started_at)
     VALUES ($1, $2, $3, $4, $5, 'PLANNED', now()) RETURNING *`,
    [organizationId, args.siteId, outputLot.id, args.outputProductId, args.plannedQuantityMg],
  );
  const batch = toBatchSummary(batchRows.rows[0]);
  const links: Record<string, unknown>[] = [];
  for (const input of args.inputs) {
    await client.query(
      `INSERT INTO batch_inputs (batch_id, input_lot_id, quantity_mg, quantity_units)
       VALUES ($1, $2, $3, $4)`,
      [batch.id, input.lotId, input.quantityMg, input.quantityUnits],
    );
    links.push(
      await createTraceLink(client, {
        createdBy,
        input: {
          batchId: batch.id,
          childLotId: outputLot.id,
          linkType: "CONSUMED_IN",
          note: args.note ?? null,
          parentLotId: input.lotId,
          quantityMg: input.quantityMg,
          quantityUnits: input.quantityUnits,
        },
        organizationId,
      }),
    );
  }
  await recordAuditEvent(client, {
    actorId: createdBy,
    createdAt: new Date(),
    eventType: "BATCH_CREATED",
    modelVersion: null,
    organizationId,
    payload: {
      batch_id: batch.id,
      inputs: args.inputs.map((input) => ({
        lot_id: input.lotId,
        quantity_mg: input.quantityMg,
        quantity_units: input.quantityUnits,
      })),
      output_lot_id: outputLot.id,
      output_lot_number: args.outputLotNumber,
      planned_quantity_mg: args.plannedQuantityMg,
    },
    targetId: batch.id,
    targetType: "batch",
  });
  return { batch, links, outputLot };
}

/**
 * Finish a batch: CONSUME each input lot (negative movement), PRODUCE
 * the output lot (positive movement), mark the batch COMPLETED and the
 * output lot approved for sale. A batch that is not PLANNED cannot
 * complete twice — the second attempt is a 409.
 */
export async function completeBatch(
  client: PoolClient,
  args: {
    organizationId: string;
    createdBy: string;
    batchId: string;
    locationId: string;
    producedQuantityMg: number;
    producedQuantityUnits: number | null;
    note?: string | null;
  },
): Promise<{ batch: BatchSummary; outputLot: LotSummary; movements: MovementRow[] }> {
  const { organizationId, createdBy } = args;
  if (!(await existsInOrg(client, "inventory_locations", organizationId, args.locationId))) {
    throw notFound("LOCATION_NOT_FOUND", "Location does not exist in this organization.");
  }
  const batchRows = await client.query<Record<string, unknown>>(
    `SELECT * FROM batches WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [args.batchId, organizationId],
  );
  if (batchRows.rows.length === 0) {
    throw notFound("BATCH_NOT_FOUND", "Batch does not exist in this organization.");
  }
  const batch = toBatchSummary(batchRows.rows[0]);
  if (batch.status !== "PLANNED" && batch.status !== "IN_PROGRESS") {
    throw conflict("BATCH_NOT_COMPLETABLE", `Batch is ${batch.status} and cannot be completed.`);
  }
  const inputs = await client.query<{
    input_lot_id: string;
    quantity_mg: number;
    quantity_units: number | null;
  }>(`SELECT input_lot_id, quantity_mg, quantity_units FROM batch_inputs WHERE batch_id = $1`, [
    args.batchId,
  ]);
  const movements: MovementRow[] = [];
  for (const input of inputs.rows) {
    movements.push(
      await insertMovement(client, {
        enteredBy: createdBy,
        locationId: args.locationId,
        lotId: input.input_lot_id,
        movementType: "CONSUME",
        note: args.note ?? `Consumed in batch ${args.batchId}.`,
        organizationId,
        quantityMg: -Number(input.quantity_mg),
        quantityUnits: input.quantity_units === null ? null : -Number(input.quantity_units),
        sourceReference: args.batchId,
      }),
    );
  }
  movements.push(
    await insertMovement(client, {
      enteredBy: createdBy,
      locationId: args.locationId,
      lotId: batch.output_lot_id,
      movementType: "PRODUCE",
      note: args.note ?? `Produced by batch ${args.batchId}.`,
      organizationId,
      quantityMg: args.producedQuantityMg,
      quantityUnits: args.producedQuantityUnits,
      sourceReference: args.batchId,
    }),
  );
  const updated = await client.query<Record<string, unknown>>(
    `UPDATE batches SET status = 'COMPLETED', produced_quantity = $2, completed_at = now()
     WHERE id = $1 AND organization_id = $3 RETURNING *`,
    [args.batchId, args.producedQuantityMg, organizationId],
  );
  const lotRows = await client.query<Record<string, unknown>>(
    `UPDATE lots SET approved_for_sale = true WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [batch.output_lot_id, organizationId],
  );
  await recordAuditEvent(client, {
    actorId: createdBy,
    createdAt: new Date(),
    eventType: "BATCH_COMPLETED",
    modelVersion: null,
    organizationId,
    payload: {
      batch_id: args.batchId,
      output_lot_id: batch.output_lot_id,
      produced_quantity_mg: args.producedQuantityMg,
      produced_quantity_units: args.producedQuantityUnits,
    },
    targetId: args.batchId,
    targetType: "batch",
  });
  return {
    batch: toBatchSummary(updated.rows[0]),
    movements,
    outputLot: toLotSummary(lotRows.rows[0]),
  };
}

/**
 * Ship a lot: record a SHIP movement (negative) on the source lot and
 * create a shipment lot — the same product, a new lot number — linked
 * SHIPPED_AS, with a RECEIVE movement for the shipped quantity. The
 * shipment lot is what a recall traces backward from: shipment lot ->
 * finished lot -> source lots. Shipping more than the ledger position
 * holds is refused (409 INSUFFICIENT_STOCK).
 */
export async function shipLot(
  client: PoolClient,
  args: {
    organizationId: string;
    createdBy: string;
    lotId: string;
    locationId: string;
    quantityMg: number;
    quantityUnits: number | null;
    shipmentLotNumber: string;
    shipmentReference?: string | null;
    note?: string | null;
  },
): Promise<{
  shipmentLot: LotSummary;
  sourceLot: LotSummary;
  link: Record<string, unknown>;
  movements: MovementRow[];
}> {
  const { organizationId, createdBy } = args;
  if (!(await existsInOrg(client, "inventory_locations", organizationId, args.locationId))) {
    throw notFound("LOCATION_NOT_FOUND", "Location does not exist in this organization.");
  }
  const lotRows = await client.query<Record<string, unknown>>(
    `SELECT * FROM lots WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [args.lotId, organizationId],
  );
  if (lotRows.rows.length === 0) {
    throw notFound("LOT_NOT_FOUND", "Lot does not exist in this organization.");
  }
  const sourceLot = toLotSummary(lotRows.rows[0]);
  const position = await lotPosition(client, { lotId: args.lotId, organizationId });
  if (args.quantityMg > 0 && position.quantityMg < args.quantityMg) {
    throw conflict(
      "INSUFFICIENT_STOCK",
      `Lot holds ${position.quantityMg} mg; cannot ship ${args.quantityMg} mg.`,
    );
  }
  if (
    args.quantityUnits !== null &&
    args.quantityUnits > 0 &&
    position.quantityUnits < args.quantityUnits
  ) {
    throw conflict(
      "INSUFFICIENT_STOCK",
      `Lot holds ${position.quantityUnits} units; cannot ship ${args.quantityUnits} units.`,
    );
  }
  const duplicate = await client.query<{ id: string }>(
    `SELECT id FROM lots WHERE organization_id = $1 AND lot_number = $2`,
    [organizationId, args.shipmentLotNumber],
  );
  if (duplicate.rows.length > 0) {
    throw conflict(
      "LOT_ALREADY_EXISTS",
      `Lot number ${args.shipmentLotNumber} already exists in this organization.`,
    );
  }
  const shipmentRows = await client.query<Record<string, unknown>>(
    `INSERT INTO lots (organization_id, product_id, lot_number, source_lot_number, status, approved_for_sale)
     VALUES ($1, $2, $3, $4, 'ACTIVE', true) RETURNING *`,
    [organizationId, sourceLot.product_id, args.shipmentLotNumber, sourceLot.lot_number],
  );
  const shipmentLot = toLotSummary(shipmentRows.rows[0]);
  const link = await createTraceLink(client, {
    createdBy,
    input: {
      childLotId: shipmentLot.id,
      linkType: "SHIPPED_AS",
      note: args.note ?? null,
      parentLotId: sourceLot.id,
      quantityMg: args.quantityMg,
      quantityUnits: args.quantityUnits,
    },
    organizationId,
  });
  const movements: MovementRow[] = [
    await insertMovement(client, {
      enteredBy: createdBy,
      locationId: args.locationId,
      lotId: sourceLot.id,
      movementType: "SHIP",
      note: args.note ?? null,
      organizationId,
      quantityMg: -args.quantityMg,
      quantityUnits: args.quantityUnits === null ? null : -args.quantityUnits,
      sourceReference: args.shipmentReference ?? null,
    }),
    await insertMovement(client, {
      enteredBy: createdBy,
      locationId: args.locationId,
      lotId: shipmentLot.id,
      movementType: "RECEIVE",
      note: args.note ?? null,
      organizationId,
      quantityMg: args.quantityMg,
      quantityUnits: args.quantityUnits,
      sourceReference: args.shipmentReference ?? null,
    }),
  ];
  await recordAuditEvent(client, {
    actorId: createdBy,
    createdAt: new Date(),
    eventType: "LOT_SHIPPED",
    modelVersion: null,
    organizationId,
    payload: {
      lot_id: sourceLot.id,
      lot_number: sourceLot.lot_number,
      quantity_mg: args.quantityMg,
      quantity_units: args.quantityUnits,
      shipment_lot_id: shipmentLot.id,
      shipment_lot_number: args.shipmentLotNumber,
      shipment_reference: args.shipmentReference ?? null,
    },
    targetId: sourceLot.id,
    targetType: "lot",
  });
  return { link, movements, shipmentLot, sourceLot };
}

export interface TraceCheck {
  kind: "CONSUMED_OUT" | "PRODUCED_IN" | "SHIPPED_OUT" | "SHIPPED_IN";
  linkedMg: number;
  ledgerMg: number;
  match: boolean;
}

/**
 * Reconciliation connection: compare what the traceability links say a
 * lot gave / received against what the movement ledger actually recorded.
 * A mismatch means the genealogy and the ledger disagree and the lot
 * needs a reconciliation run — the check never silently passes one.
 * RECEIVE movements with no link (an initial supplier receipt) are not
 * checked here: only quantities the links claim are compared.
 */
export async function checkTraceConsistency(
  client: PoolClient,
  args: { organizationId: string; lotId: string },
): Promise<{ lotId: string; checks: TraceCheck[]; consistent: boolean }> {
  const { organizationId, lotId } = args;
  if (!(await existsInOrg(client, "lots", organizationId, lotId))) {
    throw notFound("LOT_NOT_FOUND", "Lot does not exist in this organization.");
  }
  const links = await client.query<{
    link_type: string;
    direction: string;
    quantity_mg: string | null;
  }>(
    `SELECT link_type,
            CASE WHEN parent_lot_id = $2 THEN 'OUT' ELSE 'IN' END AS direction,
            quantity_mg
     FROM traceability_links
     WHERE organization_id = $1 AND (parent_lot_id = $2 OR child_lot_id = $2)`,
    [organizationId, lotId],
  );
  const movements = await client.query<{
    movement_type: string;
    quantity_mg: string;
  }>(
    `SELECT movement_type, COALESCE(SUM(quantity_mg), 0) AS quantity_mg
     FROM inventory_movements
     WHERE organization_id = $1 AND lot_id = $2 GROUP BY movement_type`,
    [organizationId, lotId],
  );
  const ledger = new Map<string, number>();
  for (const row of movements.rows) {
    ledger.set(row.movement_type, Number(row.quantity_mg));
  }
  const sumLinks = (type: string, direction: string): number =>
    links.rows
      .filter((row) => row.link_type === type && row.direction === direction)
      .reduce((total, row) => total + Number(row.quantity_mg ?? 0), 0);
  const checks: TraceCheck[] = [];
  const consumedOut = sumLinks("CONSUMED_IN", "OUT");
  if (consumedOut > 0) {
    const ledgerMg = Math.abs(ledger.get("CONSUME") ?? 0);
    checks.push({
      kind: "CONSUMED_OUT",
      ledgerMg,
      linkedMg: consumedOut,
      match: ledgerMg === consumedOut,
    });
  }
  const producedIn = sumLinks("CONSUMED_IN", "IN") + sumLinks("PRODUCED_FROM", "IN");
  if (producedIn > 0) {
    const ledgerMg = ledger.get("PRODUCE") ?? 0;
    checks.push({
      kind: "PRODUCED_IN",
      ledgerMg,
      linkedMg: producedIn,
      match: ledgerMg === producedIn,
    });
  }
  const shippedOut = sumLinks("SHIPPED_AS", "OUT");
  if (shippedOut > 0) {
    const ledgerMg = Math.abs(ledger.get("SHIP") ?? 0);
    checks.push({
      kind: "SHIPPED_OUT",
      ledgerMg,
      linkedMg: shippedOut,
      match: ledgerMg === shippedOut,
    });
  }
  const shippedIn = sumLinks("SHIPPED_AS", "IN");
  if (shippedIn > 0) {
    const ledgerMg = ledger.get("RECEIVE") ?? 0;
    checks.push({
      kind: "SHIPPED_IN",
      ledgerMg,
      linkedMg: shippedIn,
      match: ledgerMg === shippedIn,
    });
  }
  return { checks, consistent: checks.every((check) => check.match), lotId };
}
