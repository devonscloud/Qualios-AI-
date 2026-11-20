/**
 * @qualios/rules — versioned rule types (B-110: generic tax engine types).
 *
 * The core tax engine is generic: a rule names a jurisdiction, a tax type,
 * a basis, a rate, and effective dates (migration 0012, tax_rules). A basis
 * is a key a pack registers — the core knows the generic bases below, and
 * PER_MG_THC is one basis the cannabis pack registers, not the core's only
 * basis. Rules are configuration, never hard-coded (Data Model §5).
 *
 * The calculation engine is NOT here: tax rules require a domain expert /
 * accountant review before any calculation is offered (ADR, D-07), and no
 * duty is computed anywhere in this package.
 */

/** Tax bases the generic core engine accepts. Packs register more. */
export type TaxBasis = "PER_UNIT" | "AD_VALOREM" | "PER_LITRE" | "PER_KG" | "PER_MG_THC";

/** Bases the core knows without any pack enabled. */
export const CORE_TAX_BASES: readonly TaxBasis[] = [
  "PER_UNIT",
  "AD_VALOREM",
  "PER_LITRE",
  "PER_KG",
];

/** Bases registered by the cannabis pack (cannabis-ca). */
export const CANNABIS_TAX_BASES: readonly TaxBasis[] = ["PER_MG_THC"];

/** @deprecated Use TaxBasis. Kept so the old name still resolves. */
export type ExciseBasis = TaxBasis;

export type TaxType = "GST" | "HST" | "VAT" | "SALES_TAX" | "EXCISE" | "OTHER";
export type TaxRuleStatus = "DRAFT" | "ACTIVE" | "SUPERSEDED";

/** Generic versioned tax rule (migration 0012, tax_rules). */
export interface TaxRule {
  id: string;
  jurisdiction: string;
  taxType: TaxType;
  /** Pack-registered basis key (e.g. PER_UNIT, PER_MG_THC). */
  basis: TaxBasis | string;
  /** Rate in the basis unit (numeric; exact decimal in the database). */
  rateNumeric: number;
  rateUnit: string | null;
  flatAmountCents: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Pack that registered this rule's basis, or null for a core basis. */
  packId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  status: TaxRuleStatus;
}

export type ExciseRuleStatus = TaxRuleStatus;
export type ThcBasis = "LABEL" | "TESTED";

/**
 * Cannabis-pack excise rule (migration 0005, excise_rules). These tables
 * are owned by the cannabis pack (pack_id = 'cannabis-ca'); the generic
 * engine above is the core's tax model. `rateCentsPerBasisUnit` is the
 * integer-cents rate per unit of the rule's basis.
 */
export interface ExciseRule {
  id: string;
  jurisdiction: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  basis: TaxBasis;
  /** Integer cents per unit of the basis. */
  rateCentsPerBasisUnit: number;
  flatPerUnitCents: number | null;
  /** Pack that owns this rule. Always 'cannabis-ca' for excise rules. */
  packId: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  status: ExciseRuleStatus;
}
