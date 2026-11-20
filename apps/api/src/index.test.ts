import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

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

  it("GET /api/reconciliations with tenant context returns a list (implemented Days 14–18)", async () => {
    const res = await fetch(`${baseUrl}/api/reconciliations`, {
      headers: { "x-organization-id": ORG_ID },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reconciliations: unknown[] };
    expect(Array.isArray(body.reconciliations)).toBe(true);
  });

  it("GET /api/discrepancies with tenant context returns a list (implemented Days 14–18)", async () => {
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
