import { Router, type Request, type Response } from "express";
import { notImplemented } from "../lib/errors.js";
import { pool } from "../lib/db.js";

/**
 * Tax routes (P1, domain model §4.4) — read-only first.
 *
 *  GET  /api/v1/tax/rules       List versioned tax rules (?jurisdiction=, ?tax_type=)
 *  POST /api/v1/tax/calculate   501 NOT_IMPLEMENTED — stubbed until a domain
 *       expert reviews the rules (ADR D-07). No tax number is calculated
 *       here, and no calculation is offered on any rule, reviewed or not,
 *       until that review exists.
 *
 * tax_rules is shared reference configuration (no RLS), like excise_rules.
 * A rule with no reviewer (reviewed_by null) must never produce a FINAL
 * calculation — enforced by keeping calculate stubbed.
 */
export const taxRouter = Router();

taxRouter.get("/rules", async (req: Request, res: Response) => {
  const jurisdiction =
    typeof req.query.jurisdiction === "string" && req.query.jurisdiction !== ""
      ? req.query.jurisdiction
      : null;
  const taxType =
    typeof req.query.tax_type === "string" && req.query.tax_type !== "" ? req.query.tax_type : null;
  const values: unknown[] = [];
  const conditions: string[] = [];
  if (jurisdiction !== null) {
    values.push(jurisdiction);
    conditions.push(`jurisdiction = $${values.length}`);
  }
  if (taxType !== null) {
    values.push(taxType);
    conditions.push(`tax_type = $${values.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT id, jurisdiction, tax_type, basis, rate_numeric, rate_unit,
            flat_amount_cents, effective_from, effective_to, pack_id,
            reviewed_by, reviewed_at, status, created_at, updated_at
     FROM tax_rules ${where} ORDER BY jurisdiction, tax_type, effective_from`,
    values,
  );
  res.status(200).json({
    rules: rows.map((row) => ({
      basis: row.basis,
      createdAt: row.created_at,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      flatAmountCents: row.flat_amount_cents,
      id: row.id,
      jurisdiction: row.jurisdiction,
      packId: row.pack_id,
      rateNumeric: Number(row.rate_numeric),
      rateUnit: row.rate_unit,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by,
      status: row.status,
      taxType: row.tax_type,
      updatedAt: row.updated_at,
    })),
  });
});

taxRouter.post("/calculate", (_req: Request, _res: Response) => {
  throw notImplemented(
    "NOT_IMPLEMENTED",
    "Tax calculation is stubbed. No tax number is calculated until a domain expert reviews the tax rules (ADR D-07).",
  );
});
