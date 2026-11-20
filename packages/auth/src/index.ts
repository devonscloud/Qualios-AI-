/**
 * STUB — @qualios/auth (Days 7–12 scaffold).
 *
 * The managed auth provider is NOT selected yet (ADR-011). This package
 * currently holds only shared types. `verifyToken` throws until a provider
 * is wired; nothing in the system may treat a stub-verified identity as real.
 */

export type RoleName =
  "ORG_ADMIN" | "QA_APPROVER" | "FINANCE" | "PRODUCTION" | "READ_ONLY" | "PLATFORM_OPERATOR";

export type Permission =
  | "reconciliation.run"
  | "discrepancy.resolve"
  | "discrepancy.approve"
  | "excise.calculate"
  | "listing.generate";

export interface TenantContext {
  organizationId: string;
  userId: string;
  siteId: string | null;
  role: RoleName;
  permissions: Permission[];
}

/** STUB: throws. Replace with the managed provider's token verification (ADR-011). */
export function verifyToken(_token: string): Promise<TenantContext> {
  return Promise.reject(
    new Error("@qualios/auth is a stub: no auth provider selected yet (ADR-011)."),
  );
}
