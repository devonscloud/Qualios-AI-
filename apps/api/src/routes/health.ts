import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.status(200).json({ service: "qualios-api", status: "ok", version: "0.1.0" });
});
