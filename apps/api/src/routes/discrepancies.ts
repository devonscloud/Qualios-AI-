import { Router } from "express";

/**
 * STUB — discrepancy routes. The discrepancy workflow lands in Days 18–24
 * of the sprint. Until then every route answers 501 NOT_IMPLEMENTED.
 * Tenant scoping is enforced upstream by tenantMiddleware (ADR-008 layer 1).
 */
export const discrepanciesRouter = Router();

discrepanciesRouter.get("/", (_req, res) => {
  res.status(501).json({
    error: {
      code: "NOT_IMPLEMENTED",
      message: "Discrepancy routes are a stub. Workflow lands in Days 18–24 of the sprint.",
    },
  });
});

discrepanciesRouter.get("/:id", (_req, res) => {
  res.status(501).json({
    error: {
      code: "NOT_IMPLEMENTED",
      message: "Discrepancy routes are a stub. Workflow lands in Days 18–24 of the sprint.",
    },
  });
});

discrepanciesRouter.post("/:id/resolve", (_req, res) => {
  res.status(501).json({
    error: {
      code: "NOT_IMPLEMENTED",
      message: "Discrepancy routes are a stub. Workflow lands in Days 18–24 of the sprint.",
    },
  });
});
