/**
 * STUB — @qualios/workflows (Days 7–12 scaffold).
 * State machines from Data Model §4, as types only. The engine that enforces
 * transitions (and writes the audit events) lands in Days 18–24.
 */

export type ReconciliationStatus =
  "DRAFT" | "RUNNING" | "REVIEW" | "RESOLUTION_PENDING" | "APPROVED" | "CLOSED";

export type DiscrepancyStatus =
  "OPEN" | "INVESTIGATING" | "RESOLUTION_PROPOSED" | "RESOLVED" | "ESCALATED" | "CLOSED";

export const RECONCILIATION_TRANSITIONS: Record<ReconciliationStatus, ReconciliationStatus[]> = {
  DRAFT: ["RUNNING"],
  RUNNING: ["REVIEW", "APPROVED"],
  REVIEW: ["RESOLUTION_PENDING", "APPROVED"],
  RESOLUTION_PENDING: ["APPROVED"],
  APPROVED: ["CLOSED"],
  CLOSED: [],
};

export const DISCREPANCY_TRANSITIONS: Record<DiscrepancyStatus, DiscrepancyStatus[]> = {
  OPEN: ["INVESTIGATING", "ESCALATED"],
  INVESTIGATING: ["RESOLUTION_PROPOSED", "ESCALATED"],
  RESOLUTION_PROPOSED: ["RESOLVED", "ESCALATED"],
  RESOLVED: ["CLOSED", "ESCALATED"],
  ESCALATED: ["INVESTIGATING", "RESOLUTION_PROPOSED", "RESOLVED", "CLOSED"],
  CLOSED: [],
};

/** Pure helper: is this status transition allowed? (Engine enforcement comes later.) */
export function canTransition(from: DiscrepancyStatus, to: DiscrepancyStatus): boolean {
  return DISCREPANCY_TRANSITIONS[from].includes(to);
}
