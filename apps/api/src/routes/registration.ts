import { Router, type Request, type Response } from "express";
import { notImplemented } from "../lib/errors.js";

/**
 * Company registration — AUTH BOUNDARY (P1 end-to-end flow, step 1).
 *
 * Real registration is NOT built here: it needs the managed auth
 * provider account that does not exist yet (Clerk, recommended by the
 * OD-1 auth evaluation; ADR-011). Until Devon creates the Clerk
 * application and supplies its keys, this endpoint answers
 * 501 AUTH_NOT_CONFIGURED and creates nothing — no organization, no
 * user, no membership, no invite.
 *
 * The rest of the end-to-end flow (upload/version/approve SOP -> assign
 * training -> complete/verify -> export audit evidence) is implemented
 * against the dev tenant stub (x-organization-id / x-user-id headers,
 * middleware/tenant.ts) and is exercised end-to-end in
 * src/p1-flows.test.ts on both demo tenants. When Clerk lands, this
 * router is where real sign-up, tenant creation, invites, and MFA
 * attach; the downstream flow does not change.
 *
 *  POST /api/v1/registration            501 AUTH_NOT_CONFIGURED
 *  GET  /api/v1/registration/auth-status Auth readiness (200, configured: false)
 */
export const registrationRouter = Router();

export const AUTH_NOT_CONFIGURED_MESSAGE =
  "Company registration requires managed authentication (Clerk, ADR-011 / OD-1). " +
  "No Clerk account is configured for this deployment yet: create the Clerk application " +
  "and set CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY, then registration will create the " +
  "organization, owner membership, and invite flow. Until then, use the dev tenant stub " +
  "(x-organization-id header) for all other flows.";

registrationRouter.post("/", (_req: Request, _res: Response) => {
  throw notImplemented("AUTH_NOT_CONFIGURED", AUTH_NOT_CONFIGURED_MESSAGE);
});

registrationRouter.get("/auth-status", (_req: Request, res: Response) => {
  res.status(200).json({
    auth_configured: false,
    auth_provider: "clerk",
    message: AUTH_NOT_CONFIGURED_MESSAGE,
    mfa_available: false,
    registration_available: false,
    tenant_stub: "dev-only x-organization-id / x-user-id headers (no token verification)",
  });
});
