import { Router, type Request, type Response } from "express";
import { isTenantMember, isUuid, withTenant } from "../lib/db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { createTraceLink, parseLinkType, traceLot } from "../lib/traceability.js";
import {
  checkTraceConsistency,
  completeBatch,
  createBatch,
  lotPosition,
  receiveLot,
  shipLot,
} from "../lib/traceability-chain.js";

/**
 * Traceability routes — core surface (domain model, migration 0012).
 * Every industry traces lots; no pack gate applies here.
 *
 *  POST /api/traceability/links              Create one genealogy link
 *  GET  /api/traceability/lots/:lotId/backward   Ancestors (where it came from)
 *  GET  /api/traceability/lots/:lotId/forward    Descendants (where it went)
 *  GET  /api/traceability/lots/:lotId/links      Links touching the lot
 *
 * Proof of concept (P1, lib/traceability-chain.ts) — the full chain:
 *  POST /api/traceability/receive             Receive a lot (lot + RECEIVE movement)
 *  POST /api/traceability/batches             Create a batch (output lot + CONSUMED_IN links)
 *  POST /api/traceability/batches/:id/complete Finish it (CONSUME + PRODUCE movements)
 *  POST /api/traceability/ship                Ship a lot (SHIP movement + SHIPPED_AS link)
 *  GET  /api/traceability/lots/:lotId/positions   Ledger-derived position
 *  GET  /api/traceability/lots/:lotId/trace-check Links vs movement ledger
 *
 * The same router is mounted versioned (/api/v1/traceability) and
 * unversioned (/api/traceability); the versioned paths are the contract.
 */
export const traceabilityRouter = Router();

function parseUuidField(value: unknown, field: string): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw badRequest("INVALID_FIELD", `${field} is required and must be a UUID.`);
  }
  return value;
}

function parseIntField(value: unknown, field: string, opts?: { min?: number }): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw badRequest("INVALID_FIELD", `${field} must be an integer.`);
  }
  if (opts?.min !== undefined && value < opts.min) {
    throw badRequest("INVALID_FIELD", `${field} must be at least ${opts.min}.`);
  }
  return value;
}

function parseOptionalIntField(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return parseIntField(value, field, { min: 0 });
}

function parseLotNumber(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest("INVALID_FIELD", "lot_number is required and must be a non-empty string.");
  }
  return value.trim();
}

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

traceabilityRouter.post("/links", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const parentLotId = req.body?.parent_lot_id;
  const childLotId = req.body?.child_lot_id;
  if (typeof parentLotId !== "string" || !isUuid(parentLotId)) {
    throw badRequest("INVALID_FIELD", "parent_lot_id is required and must be a UUID.");
  }
  if (typeof childLotId !== "string" || !isUuid(childLotId)) {
    throw badRequest("INVALID_FIELD", "child_lot_id is required and must be a UUID.");
  }
  const linkType = parseLinkType(req.body?.link_type);
  const batchId =
    req.body?.batch_id === undefined || req.body?.batch_id === null || req.body?.batch_id === ""
      ? null
      : req.body.batch_id;
  if (batchId !== null && (typeof batchId !== "string" || !isUuid(batchId))) {
    throw badRequest("INVALID_FIELD", "batch_id must be a UUID.");
  }
  const quantityMg = req.body?.quantity_mg ?? null;
  const quantityUnits = req.body?.quantity_units ?? null;
  if (quantityMg !== null && (typeof quantityMg !== "number" || !Number.isInteger(quantityMg))) {
    throw badRequest("INVALID_FIELD", "quantity_mg must be an integer.");
  }
  if (
    quantityUnits !== null &&
    (typeof quantityUnits !== "number" || !Number.isInteger(quantityUnits))
  ) {
    throw badRequest("INVALID_FIELD", "quantity_units must be an integer.");
  }
  const link = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    return createTraceLink(client, {
      createdBy: userId,
      input: {
        batchId,
        childLotId,
        linkType,
        note: typeof req.body?.note === "string" ? req.body.note : null,
        parentLotId,
        quantityMg,
        quantityUnits,
      },
      organizationId,
    });
  });
  res.status(201).json({ link });
});

traceabilityRouter.get("/lots/:lotId/backward", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const lotId = paramString(req.params.lotId, "lot id");
  if (!isUuid(lotId)) throw badRequest("INVALID_ID", "Lot id must be a UUID.");
  const result = await withTenant(organizationId, async (client) =>
    traceLot(client, { direction: "backward", lotId, organizationId }),
  );
  res.status(200).json(result);
});

traceabilityRouter.get("/lots/:lotId/forward", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const lotId = paramString(req.params.lotId, "lot id");
  if (!isUuid(lotId)) throw badRequest("INVALID_ID", "Lot id must be a UUID.");
  const result = await withTenant(organizationId, async (client) =>
    traceLot(client, { direction: "forward", lotId, organizationId }),
  );
  res.status(200).json(result);
});

traceabilityRouter.get("/lots/:lotId/links", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const lotId = paramString(req.params.lotId, "lot id");
  if (!isUuid(lotId)) throw badRequest("INVALID_ID", "Lot id must be a UUID.");
  const rows = await withTenant(organizationId, async (client) => {
    const found = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM lots WHERE id = $1 AND organization_id = $2) AS exists`,
      [lotId, organizationId],
    );
    if (!found.rows[0]?.exists) {
      throw notFound("LOT_NOT_FOUND", "Lot does not exist in this organization.");
    }
    const links = await client.query(
      `SELECT * FROM traceability_links
       WHERE organization_id = $1 AND (parent_lot_id = $2 OR child_lot_id = $2)
       ORDER BY created_at ASC`,
      [organizationId, lotId],
    );
    return links.rows as Record<string, unknown>[];
  });
  res.status(200).json({ lot_id: lotId, links: rows });
});

// ---------------------------------------------------------------------------
// Proof of concept: receive -> batch -> finish -> ship (P1).
// Every write is membership-checked, like the link route above.
// ---------------------------------------------------------------------------

traceabilityRouter.post("/receive", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const productId = parseUuidField(req.body?.product_id, "product_id");
  const locationId = parseUuidField(req.body?.location_id, "location_id");
  const lotNumber = parseLotNumber(req.body?.lot_number);
  const quantityMg = parseIntField(req.body?.quantity_mg, "quantity_mg", { min: 0 });
  const quantityUnits = parseOptionalIntField(req.body?.quantity_units, "quantity_units");
  if (quantityMg === 0 && (quantityUnits === null || quantityUnits === 0)) {
    throw badRequest(
      "INVALID_FIELD",
      "Receive at least some quantity (quantity_mg or quantity_units).",
    );
  }
  const result = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    return receiveLot(client, {
      createdBy: userId,
      locationId,
      lotNumber,
      note: typeof req.body?.note === "string" ? req.body.note : null,
      organizationId,
      productId,
      quantityMg,
      quantityUnits,
      sourceLotNumber:
        typeof req.body?.source_lot_number === "string" ? req.body.source_lot_number : null,
      sourceReference:
        typeof req.body?.source_reference === "string" ? req.body.source_reference : null,
    });
  });
  res.status(201).json(result);
});

traceabilityRouter.post("/batches", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const siteId = parseUuidField(req.body?.site_id, "site_id");
  const outputProductId = parseUuidField(req.body?.output_product_id, "output_product_id");
  const outputLotNumber = parseLotNumber(req.body?.output_lot_number);
  const plannedQuantityMg = parseIntField(req.body?.planned_quantity_mg, "planned_quantity_mg", {
    min: 1,
  });
  const rawInputs = req.body?.inputs;
  if (!Array.isArray(rawInputs) || rawInputs.length === 0) {
    throw badRequest(
      "INVALID_FIELD",
      "inputs must be a non-empty array of { lot_id, quantity_mg, quantity_units }.",
    );
  }
  const inputs = rawInputs.map((raw) => ({
    lotId: parseUuidField(raw?.lot_id, "inputs[].lot_id"),
    quantityMg: parseIntField(raw?.quantity_mg, "inputs[].quantity_mg", { min: 1 }),
    quantityUnits: parseOptionalIntField(raw?.quantity_units, "inputs[].quantity_units"),
  }));
  const result = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    return createBatch(client, {
      createdBy: userId,
      inputs,
      note: typeof req.body?.note === "string" ? req.body.note : null,
      organizationId,
      outputLotNumber,
      outputProductId,
      plannedQuantityMg,
      siteId,
    });
  });
  res.status(201).json(result);
});

traceabilityRouter.post("/batches/:id/complete", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const batchId = paramString(req.params.id, "batch id");
  if (!isUuid(batchId)) throw badRequest("INVALID_ID", "Batch id must be a UUID.");
  const locationId = parseUuidField(req.body?.location_id, "location_id");
  const producedQuantityMg = parseIntField(req.body?.produced_quantity_mg, "produced_quantity_mg", {
    min: 0,
  });
  const producedQuantityUnits = parseOptionalIntField(
    req.body?.produced_quantity_units,
    "produced_quantity_units",
  );
  if (producedQuantityMg === 0 && (producedQuantityUnits === null || producedQuantityUnits === 0)) {
    throw badRequest("INVALID_FIELD", "Complete with at least some produced quantity.");
  }
  const result = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    return completeBatch(client, {
      batchId,
      createdBy: userId,
      locationId,
      note: typeof req.body?.note === "string" ? req.body.note : null,
      organizationId,
      producedQuantityMg,
      producedQuantityUnits,
    });
  });
  res.status(200).json(result);
});

traceabilityRouter.post("/ship", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const lotId = parseUuidField(req.body?.lot_id, "lot_id");
  const locationId = parseUuidField(req.body?.location_id, "location_id");
  const shipmentLotNumber = parseLotNumber(req.body?.shipment_lot_number);
  const quantityMg = parseIntField(req.body?.quantity_mg, "quantity_mg", { min: 0 });
  const quantityUnits = parseOptionalIntField(req.body?.quantity_units, "quantity_units");
  if (quantityMg === 0 && (quantityUnits === null || quantityUnits === 0)) {
    throw badRequest(
      "INVALID_FIELD",
      "Ship at least some quantity (quantity_mg or quantity_units).",
    );
  }
  const result = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    return shipLot(client, {
      createdBy: userId,
      locationId,
      lotId,
      note: typeof req.body?.note === "string" ? req.body.note : null,
      organizationId,
      quantityMg,
      quantityUnits,
      shipmentLotNumber,
      shipmentReference:
        typeof req.body?.shipment_reference === "string" ? req.body.shipment_reference : null,
    });
  });
  res.status(201).json(result);
});

traceabilityRouter.get("/lots/:lotId/positions", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const lotId = paramString(req.params.lotId, "lot id");
  if (!isUuid(lotId)) throw badRequest("INVALID_ID", "Lot id must be a UUID.");
  const result = await withTenant(organizationId, async (client) => {
    const found = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM lots WHERE id = $1 AND organization_id = $2) AS exists`,
      [lotId, organizationId],
    );
    if (!found.rows[0]?.exists) {
      throw notFound("LOT_NOT_FOUND", "Lot does not exist in this organization.");
    }
    const position = await lotPosition(client, { lotId, organizationId });
    const byLocation = await client.query<{
      location_id: string;
      location_name: string;
      stock_state: string;
      quantity_mg: string;
      quantity_units: string;
    }>(
      `SELECT lot_id, location_id, stock_state, quantity_mg, quantity_units
       FROM inventory_positions WHERE organization_id = $1 AND lot_id = $2`,
      [organizationId, lotId],
    );
    // inventory_positions carries location_id + stock_state; resolve names.
    const rows = [];
    for (const row of byLocation.rows) {
      const loc = await client.query<{ name: string }>(
        `SELECT name FROM inventory_locations WHERE id = $1`,
        [row.location_id],
      );
      rows.push({
        location_id: row.location_id,
        location_name: loc.rows[0]?.name ?? null,
        quantity_mg: Number(row.quantity_mg),
        quantity_units: Number(row.quantity_units),
        stock_state: row.stock_state,
      });
    }
    return { lot_id: lotId, position, positions: rows };
  });
  res.status(200).json(result);
});

traceabilityRouter.get("/lots/:lotId/trace-check", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const lotId = paramString(req.params.lotId, "lot id");
  if (!isUuid(lotId)) throw badRequest("INVALID_ID", "Lot id must be a UUID.");
  const result = await withTenant(organizationId, async (client) =>
    checkTraceConsistency(client, { lotId, organizationId }),
  );
  res.status(200).json(result);
});
