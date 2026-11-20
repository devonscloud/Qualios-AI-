import type { NextFunction, Request, Response } from "express";

/**
 * STUB tenant middleware — Days 7–12 scaffold only.
 *
 * What it does: reads `x-organization-id` (+ optional `x-user-id`, `x-site-id`)
 * headers and attaches them as `req.tenant`. Requests without an organization
 * header are rejected with 401.
 *
 * What it does NOT do: verify any token, session, or signature. There is no
 * authentication here. ADR-011 requires a managed auth provider with MFA;
 * this stub must be replaced by real token verification before any real
 * tenant data is served, and index.ts refuses to start in production while
 * the stub is in place.
 *
 * ADR-008 layer 1 (application-level tenant scoping) is implemented by
 * requiring tenant context on every /api route and never accepting a tenant
 * id from a request body or query string.
 */
export interface TenantContext {
  organizationId: string;
  userId: string;
  siteId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const organizationId = req.header("x-organization-id");
  const userId = req.header("x-user-id") ?? "00000000-0000-4000-8000-000000000000";
  const siteId = req.header("x-site-id") ?? null;

  if (!organizationId || !UUID_RE.test(organizationId)) {
    res.status(401).json({
      error: {
        code: "TENANT_CONTEXT_MISSING",
        message: "A valid x-organization-id header is required.",
      },
    });
    return;
  }

  req.tenant = { organizationId, userId, siteId };
  next();
}
