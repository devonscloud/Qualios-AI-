import { Router } from "express";

/**
 * STUB — reconciliation routes. The reconciliation engine lands in Days 12–18
 * of the sprint. Until then every route answers 501 NOT_IMPLEMENTED.
 * Tenant scoping is enforced upstream by tenantMiddleware (ADR-008 layer 1).
 */
export const reconciliationsRouter = Router();

const NOT_IMPLEMENTED = {
  error: {
    code: "NOT_IMPLEMENTED",
    message: "Reconciliation routes are a stub. Engine lands in Days 12–18 of the sprint.",
  },
};

reconciliationsRouter.get("/", (_req, res) => {
  res.status(501).json(NOT_IMPLEMENTED);
});

reconciliationsRouter.post("/", (_req, res) => {
  res.status(501).json(NOT_IMPLEMENTED);
});

reconciliationsRouter.get("/:id", (_req, res) => {
  res.status(501).json(NOT_IMPLEMENTED);
});
