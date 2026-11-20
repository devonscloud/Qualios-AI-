import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createApp } from "./app.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * B-108: the two tests below touch the database. Without a migrated
 * PostgreSQL they must skip — not fail. Readiness is probed once in
 * beforeAll: the tables must actually exist, not just DATABASE_URL being
 * set (an unmigrated database is still "no usable database" for these
 * tests). The DB-backed suites (documents.test.ts, reconciliation.test.ts,
 * sop-training.test.ts) migrate the database themselves in beforeAll, so
 * when the full suite runs against a migrated database these tests run
 * and must pass.
 */
let dbReady = false;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query("SELECT 1 FROM reconciliations LIMIT 1");
    await pool.query("SELECT 1 FROM discrepancies LIMIT 1");
    dbReady = true;
  } catch {
    dbReady = false;
  } finally {
    await pool.end();
  }
});

describe("qualios-api smoke tests (Days 7–12 scaffold)", () => {
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let baseUrl: string;

  beforeEach(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("test server did not bind");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("GET /health returns 200 without tenant context", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; status: string };
    expect(body.service).toBe("qualios-api");
    expect(body.status).toBe("ok");
  });

  it("GET /api/reconciliations without x-organization-id returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/reconciliations`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TENANT_CONTEXT_MISSING");
  });

  it("GET /api/reconciliations with a malformed x-organization-id returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/reconciliations`, {
      headers: { "x-organization-id": "not-a-uuid" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/reconciliations with tenant context returns a list (implemented Days 14–18)", async ({
    skip,
  }) => {
    if (!dbReady) skip();
    const res = await fetch(`${baseUrl}/api/reconciliations`, {
      headers: { "x-organization-id": ORG_ID },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reconciliations: unknown[] };
    expect(Array.isArray(body.reconciliations)).toBe(true);
  });

  it("GET /api/discrepancies with tenant context returns a list (implemented Days 14–18)", async ({
    skip,
  }) => {
    if (!dbReady) skip();
    const res = await fetch(`${baseUrl}/api/discrepancies`, {
      headers: { "x-organization-id": ORG_ID },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { discrepancies: unknown[] };
    expect(Array.isArray(body.discrepancies)).toBe(true);
  });

  it("POST /api/excise/calculate with tenant context returns 501 (stub)", async () => {
    const res = await fetch(`${baseUrl}/api/excise/calculate`, {
      body: JSON.stringify({}),
      headers: { "content-type": "application/json", "x-organization-id": ORG_ID },
      method: "POST",
    });
    expect(res.status).toBe(501);
  });

  it("unknown routes return 404", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
