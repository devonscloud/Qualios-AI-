import { Router, type Request, type Response } from "express";
import { isTenantMember, isUuid, withTenant } from "../lib/db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { createTraceLink, parseLinkType, traceLot } from "../lib/traceability.js";

/**
 * Traceability routes — core surface (domain model, migration 0012).
 * Every industry traces lots; no pack gate applies here.
 *
 *  POST /api/traceability/links              Create one genealogy link
 *  GET  /api/traceability/lots/:lotId/backward   Ancestors (where it came from)
 *  GET  /api/traceability/lots/:lotId/forward    Descendants (where it went)
 *  GET  /api/traceability/lots/:lotId/links      Links touching the lot
 */
export const traceabilityRouter = Router();

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
