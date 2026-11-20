/**
 * STUB — @qualios/rules (Days 7–12 scaffold).
 * Versioned rule types only. Rules are configuration, never hard-coded
 * (Data Model §5). The calculation engine is NOT here: excise rules require
 * a domain expert / accountant review before any calculation is offered
 * (ADR, D-07), and no duty is computed anywhere in this scaffold.
 */

export type ExciseBasis = "PER_MG_THC";
export type ExciseRuleStatus = "DRAFT" | "ACTIVE" | "SUPERSEDED";
export type ThcBasis = "LABEL" | "TESTED";

export interface ExciseRule {
  id: string;
  jurisdiction: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  basis: ExciseBasis;
  /** Integer cents per mg THC. */
  rateCentsPerMg: number;
  flatPerUnitCents: number | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  status: ExciseRuleStatus;
}
