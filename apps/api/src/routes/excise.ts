import { Router } from "express";

/**
 * STUB — excise routes (cannabis-pack surface, B-110). The excise
 * calculation engine is a P1/P2 item and requires a domain expert /
 * accountant to review the rules first (ADR, D-07). Until then every
 * route answers 501 NOT_IMPLEMENTED. This scaffold calculates no duty
 * and files nothing. The generic tax engine is migration 0012
 * (tax_rules); PER_MG_THC is one basis the cannabis pack registers.
 * Tenant scoping is enforced upstream by tenantMiddleware (ADR-008 layer 1),
 * and the pack gate in app.ts refuses tenants without the cannabis pack.
 */
export const exciseRouter = Router();

exciseRouter.post("/calculate", (_req, res) => {
  res.status(501).json({
    error: {
      code: "NOT_IMPLEMENTED",
      message:
        "Excise calculation is a stub. Rules require expert review before any calculation is offered.",
    },
  });
});

exciseRouter.get("/rules", (_req, res) => {
  res.status(501).json({
    error: {
      code: "NOT_IMPLEMENTED",
      message:
        "Excise rules are a stub. Rules require expert review before any calculation is offered.",
    },
  });
});
