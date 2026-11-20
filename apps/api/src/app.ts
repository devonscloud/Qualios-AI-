import express, { type Express, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { ApiError } from "./lib/errors.js";
import { requirePack } from "./lib/packs.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { healthRouter } from "./routes/health.js";
import { auditRouter } from "./routes/audit.js";
import { documentsRouter } from "./routes/documents.js";
import { importsRouter } from "./routes/imports.js";
import { packsRouter } from "./routes/packs.js";
import { reconciliationsRouter } from "./routes/reconciliations.js";
import { discrepanciesRouter } from "./routes/discrepancies.js";
import { exciseRouter } from "./routes/excise.js";
import { traceabilityRouter } from "./routes/traceability.js";
import { trainingRouter } from "./routes/training.js";

/** Build the Express app. Exported separately from index.ts so tests can start it on an ephemeral port. */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

  // Public: liveness only, no tenant context.
  app.use("/health", healthRouter);

  // Everything under /api requires tenant context (STUB middleware for now).
  app.use("/api", tenantMiddleware);
  app.use("/api/documents", documentsRouter);
  app.use("/api/packs", packsRouter);
  app.use("/api/traceability", traceabilityRouter);
  // Cannabis-pack surfaces, mounted on the core and gated by the tenant's
  // enabled packs (B-110, leak 8). A tenant without the cannabis pack
  // gets 403 PACK_NOT_ENABLED, not a silent pass-through.
  app.use("/api/imports", requirePack("cannabis-ca"), importsRouter);
  app.use("/api/audit-events", auditRouter);
  app.use("/api/reconciliations", requirePack("cannabis-ca"), reconciliationsRouter);
  app.use("/api/discrepancies", requirePack("cannabis-ca"), discrepanciesRouter);
  app.use("/api/excise", requirePack("cannabis-ca"), exciseRouter);
  app.use("/api/training", trainingRouter);

  // Unknown routes.
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  // Central error handler (Express 5 forwards rejected async handlers here).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: {
            code: "FILE_TOO_LARGE",
            message: "Uploaded file exceeds the size limit (see MAX_UPLOAD_MB).",
          },
        });
        return;
      }
      res.status(400).json({ error: { code: "UPLOAD_ERROR", message: err.message } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  return app;
}
