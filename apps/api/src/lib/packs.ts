import type { NextFunction, Request, Response } from "express";
import { getPack, INDUSTRY_PACKS, type IndustryPack } from "@qualios/industry-packs";
import { pool } from "./db.js";
import { forbidden } from "./errors.js";

/**
 * Pack gating (B-110, leak 8).
 *
 * The imports / reconciliations / discrepancies / excise routes are
 * cannabis-pack surfaces mounted on the industry-neutral core. They are
 * not assumed present for every tenant: a tenant may only use a pack
 * surface when the pack is enabled for that tenant
 * (organization_packs, migration 0011).
 *
 * requirePack runs after tenantMiddleware (which supplies req.tenant).
 * It answers 403 PACK_NOT_ENABLED when the pack is unknown or not
 * enabled — never 404, so a tenant cannot probe for other tenants'
 * packs, and never a silent pass-through.
 */

export async function getEnabledPackIds(organizationId: string): Promise<string[]> {
  const { rows } = await pool.query<{ pack_id: string }>(
    `SELECT pack_id FROM organization_packs
     WHERE organization_id = $1 AND status = 'ENABLED' ORDER BY pack_id`,
    [organizationId],
  );
  return rows.map((row) => row.pack_id);
}

export async function isPackEnabled(organizationId: string, packId: string): Promise<boolean> {
  if (!getPack(packId)) return false;
  const enabled = await getEnabledPackIds(organizationId);
  return enabled.includes(packId);
}

export function requirePack(packId: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const tenant = req.tenant;
    if (!tenant) {
      next(new Error("tenant middleware did not run"));
      return;
    }
    let enabled: boolean;
    try {
      enabled = await isPackEnabled(tenant.organizationId, packId);
    } catch (error) {
      next(error);
      return;
    }
    if (!enabled) {
      next(
        forbidden(
          "PACK_NOT_ENABLED",
          `Industry pack "${packId}" is not enabled for this organization.`,
        ),
      );
      return;
    }
    next();
  };
}

export interface PackWithEnabled extends IndustryPack {
  enabled: boolean;
}

/** Every registered pack, with the calling tenant's enabled flag. */
export async function listPacksForTenant(organizationId: string): Promise<PackWithEnabled[]> {
  const enabled = new Set(await getEnabledPackIds(organizationId));
  return INDUSTRY_PACKS.map((pack) => ({ ...pack, enabled: enabled.has(pack.id) }));
}
