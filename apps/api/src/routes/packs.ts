import { Router, type Request, type Response } from "express";
import { listPacksForTenant } from "../lib/packs.js";

/**
 * Pack routes — core surface (no pack gate: every tenant can see which
 * packs exist and which ones they have enabled).
 *
 *  GET /api/packs   Registered packs + enabled flags for this tenant.
 */
export const packsRouter = Router();

packsRouter.get("/", async (req: Request, res: Response) => {
  const tenant = req.tenant;
  if (!tenant) throw new Error("tenant middleware did not run");
  const packs = await listPacksForTenant(tenant.organizationId);
  res.status(200).json({
    packs: packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      country: pack.country,
      status: pack.status,
      description: pack.description,
      enabled: pack.enabled,
      taxonomy: pack.taxonomy,
      listing_types: pack.listingTypes,
      tax_bases: pack.taxBases,
      lot_dispositions: pack.lotDispositions,
      product_attribute_keys: pack.productAttributeKeys,
      source_systems: pack.sourceSystems,
    })),
  });
});
