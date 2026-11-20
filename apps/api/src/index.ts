import { createApp } from "./app.js";
import { env } from "./lib/env.js";

if (process.env.NODE_ENV === "production") {
  // The tenant middleware in this scaffold is a STUB (see src/middleware/tenant.ts).
  // It must never serve production traffic. Refuse to start.
  throw new Error(
    "QualiOS API scaffold: tenant auth is a stub and must not run in production. " +
      "See ADR-011 — a managed auth provider must be wired first.",
  );
}

const app = createApp();

app.listen(env.port, env.host, () => {
  console.log(`qualios-api listening on http://${env.host}:${env.port}`);
  console.log(
    "WARNING: tenant middleware is a STUB (header-based, no token verification). Development only.",
  );
});
