import express, { type Express } from "express";
import { tenantMiddleware } from "./middleware/tenant.js";
import { healthRouter } from "./routes/health.js";
import { reconciliationsRouter } from "./routes/reconciliations.js";
import { discrepanciesRouter } from "./routes/discrepancies.js";
import { exciseRouter } from "./routes/excise.js";

/** Build the Express app. Exported separately from index.ts so tests can start it on an ephemeral port. */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

  // Public: liveness only, no tenant context.
  app.use("/health", healthRouter);

  // Everything under /api requires tenant context (STUB middleware for now).
  app.use("/api", tenantMiddleware);
  app.use("/api/reconciliations", reconciliationsRouter);
  app.use("/api/discrepancies", discrepanciesRouter);
  app.use("/api/excise", exciseRouter);

  // Unknown routes.
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  return app;
}
