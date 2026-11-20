import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPool, runMigrations, runSeeds } from "@qualios/db";
import { LocalFilesystemStorage } from "@qualios/storage";
import { createApp } from "./app.js";
import { setStorageForTests } from "./lib/storage.js";

/**
 * P1 end-to-end flow (domain model §7 item 3) + auth boundary + tax
 * read-only, on the two demo tenants.
 *
 *   register company -> upload/version/approve SOP -> assign training ->
 *   complete/verify -> export audit evidence
 *
 * Registration is the auth boundary: it answers 501 AUTH_NOT_CONFIGURED
 * (no Clerk account exists yet), so the flow is exercised from the SOP
 * step onward against the dev tenant stub, on BOTH tenants, to prove
 * tenant isolation. Tax calculation stays stubbed (ADR D-07); only the
 * read-only rules list is exercised.
 *
 * Needs a real PostgreSQL (DATABASE_URL). Without it the suite is skipped.
 * Run-scoped SOP file names keep consecutive runs against the same
 * database green.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const hasDb = Boolean(DATABASE_URL);

const HERBA_ORG = "11111111-1111-4111-8111-111111111111";
const HERBA_OPS = "11111111-1111-4111-8111-111111111119";
const HERBA_QA = "11111111-1111-4111-8111-111111111113";
const FOOD_ORG = "22222222-2222-4222-8222-222222222222";
const FOOD_QA = "22222222-2222-4222-8222-222222222224";
const FOOD_OPS = "22222222-2222-4222-8222-222222222230";
const FOOD_OPS_MEMBERSHIP = "22222222-2222-4222-8222-222222222231";
const FOOD_QA_ROLE = "22222222-2222-4222-8222-222222222225";
const RUN_ID = randomUUID().slice(0, 8);

const PDF_V1 = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
const PDF_V2 = Buffer.from("%PDF-1.4\n2 0 obj\n<< /Type /Catalog /Version 2 >>\nendobj\n");

function headers(orgId: string, userId: string): Record<string, string> {
  return { "x-organization-id": orgId, "x-user-id": userId };
}

function jsonHeaders(orgId: string, userId: string): Record<string, string> {
  return { ...headers(orgId, userId), "content-type": "application/json" };
}

function uploadForm(data: Buffer, fileName: string, fields?: Record<string, string>): FormData {
  const form = new FormData();
  form.append("file", new Blob([data as BlobPart], { type: "application/pdf" }), fileName);
  for (const [key, value] of Object.entries(fields ?? {})) {
    form.append(key, value);
  }
  return form;
}

describe.skipIf(!hasDb)("P1 end-to-end flow + auth boundary (DB-backed)", () => {
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let baseUrl: string;
  let pool: Pool;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "qualios-p1-test-"));
    setStorageForTests(new LocalFilesystemStorage(tmpRoot));

    const dbPool = createPool(DATABASE_URL as string);
    await runMigrations(dbPool);
    await runSeeds(dbPool);
    await dbPool.end();

    pool = new Pool({ connectionString: DATABASE_URL });
    // The food tenant ships with a single demo user; the SOP flow needs
    // two (uploader != reviewer, completer != verifier). Idempotent.
    await pool.query(
      `INSERT INTO users (id, email, display_name, status)
       VALUES ($1, $2, 'Demo Food Ops Uploader', 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [FOOD_OPS, `demo.ops-food-${RUN_ID}@qualios.example`],
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role_id, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
      [FOOD_OPS_MEMBERSHIP, FOOD_OPS, FOOD_ORG, FOOD_QA_ROLE],
    );

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

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    if (pool) {
      await pool.end();
    }
    if (tmpRoot) {
      await rm(tmpRoot, { force: true, recursive: true });
    }
  });

  /**
   * The full flow for one tenant: upload SOP v1 -> upload v2 -> review
   * (approve, different user) -> publish v2 effective -> assign training
   * -> complete -> verify -> export the audit trail CSV and check every
   * step is present, in chain order.
   */
  async function runEndToEnd(args: {
    orgId: string;
    uploaderId: string;
    approverId: string;
    tag: string;
  }): Promise<{ documentId: string; assignmentId: string }> {
    const { orgId, uploaderId, approverId, tag } = args;
    const fileName = `sop-${tag}-${RUN_ID}.pdf`;

    const uploaded = await fetch(`${baseUrl}/api/documents`, {
      body: uploadForm(PDF_V1, fileName, { document_type: "SOP" }),
      headers: headers(orgId, uploaderId),
      method: "POST",
    });
    expect(uploaded.status).toBe(201);
    const uploadedBody = (await uploaded.json()) as {
      document: { id: string; status: string; latest_version: number };
    };
    const documentId = uploadedBody.document.id;
    expect(uploadedBody.document.status).toBe("UPLOADED");

    const v2 = await fetch(`${baseUrl}/api/documents/${documentId}/versions`, {
      body: uploadForm(PDF_V2, fileName, { change_note: "Clarified step 3." }),
      headers: headers(orgId, uploaderId),
      method: "POST",
    });
    expect(v2.status).toBe(200);
    const v2Body = (await v2.json()) as { version_number: number };
    expect(v2Body.version_number).toBe(2);

    const reviewed = await fetch(`${baseUrl}/api/documents/${documentId}/review`, {
      body: JSON.stringify({ decision: "APPROVED", note: "Reviewed, accurate." }),
      headers: jsonHeaders(orgId, approverId),
      method: "POST",
    });
    expect(reviewed.status).toBe(200);
    const reviewedBody = (await reviewed.json()) as {
      document: { status: string };
    };
    expect(reviewedBody.document.status).toBe("VERIFIED");

    const published = await fetch(`${baseUrl}/api/documents/${documentId}/publish`, {
      body: JSON.stringify({ version_number: 2 }),
      headers: jsonHeaders(orgId, approverId),
      method: "POST",
    });
    expect(published.status).toBe(200);
    const publishedBody = (await published.json()) as {
      document: { effective_version: number };
    };
    expect(publishedBody.document.effective_version).toBe(2);

    const assigned = await fetch(`${baseUrl}/api/training/assignments`, {
      body: JSON.stringify({
        assignee_id: uploaderId,
        document_id: documentId,
        due_at: "2027-01-15T00:00:00.000Z",
        version_number: 2,
      }),
      headers: jsonHeaders(orgId, approverId),
      method: "POST",
    });
    expect(assigned.status).toBe(201);
    const assignedBody = (await assigned.json()) as {
      assignment: { id: string; status: string; version_number: number };
    };
    expect(assignedBody.assignment.version_number).toBe(2);
    const assignmentId = assignedBody.assignment.id;

    const completed = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/complete`, {
      body: JSON.stringify({ acknowledgement: true, assessment_score: 92 }),
      headers: jsonHeaders(orgId, uploaderId),
      method: "POST",
    });
    expect(completed.status).toBe(200);
    const completedBody = (await completed.json()) as {
      assignment: { status: string; completion: { assessment_score: number } };
    };
    expect(completedBody.assignment.status).toBe("COMPLETED");
    expect(completedBody.assignment.completion.assessment_score).toBe(92);

    const verified = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/verify`, {
      body: JSON.stringify({ note: "Completion reviewed." }),
      headers: jsonHeaders(orgId, approverId),
      method: "POST",
    });
    expect(verified.status).toBe(200);
    const verifiedBody = (await verified.json()) as {
      assignment: { verified_by: string };
    };
    expect(verifiedBody.assignment.verified_by).toBe(approverId);

    const exported = await fetch(
      `${baseUrl}/api/training/audit-trail/export?document_id=${documentId}`,
      { headers: headers(orgId, approverId) },
    );
    expect(exported.status).toBe(200);
    const csv = await exported.text();
    const eventTypes = [
      "DOCUMENT_UPLOADED",
      "DOCUMENT_VERSION_UPLOADED",
      "DOCUMENT_APPROVED",
      "SOP_PUBLISHED",
      "TRAINING_ASSIGNED",
      "TRAINING_COMPLETED",
      "TRAINING_VERIFIED",
    ];
    let lastIndex = -1;
    for (const eventType of eventTypes) {
      const index = csv.indexOf(eventType);
      expect(index).toBeGreaterThan(-1);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
    return { assignmentId, documentId };
  }

  it("registration is the auth boundary: 501 AUTH_NOT_CONFIGURED, nothing created", async () => {
    const res = await fetch(`${baseUrl}/api/v1/registration`, {
      body: JSON.stringify({ company_name: "Acme Widgets Inc.", contact_email: "a@acme.example" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("AUTH_NOT_CONFIGURED");
    expect(body.error.message).toMatch(/Clerk/);
    expect(body.error.message).toMatch(/CLERK_SECRET_KEY/);
    const orgs = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM organizations WHERE name = 'Acme Widgets Inc.'`,
    );
    expect(Number(orgs.rows[0].n)).toBe(0);

    const status = await fetch(`${baseUrl}/api/v1/registration/auth-status`);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as {
      auth_configured: boolean;
      auth_provider: string;
      registration_available: boolean;
    };
    expect(statusBody.auth_configured).toBe(false);
    expect(statusBody.auth_provider).toBe("clerk");
    expect(statusBody.registration_available).toBe(false);
  });

  it("end-to-end flow works on the Herba tenant", async () => {
    const { documentId } = await runEndToEnd({
      approverId: HERBA_QA,
      orgId: HERBA_ORG,
      tag: "herba",
      uploaderId: HERBA_OPS,
    });
    // Tenant isolation: the food tenant cannot see Herba's SOP.
    const otherTenant = await fetch(`${baseUrl}/api/documents/${documentId}`, {
      headers: headers(FOOD_ORG, FOOD_QA),
    });
    expect(otherTenant.status).toBe(404);
  });

  it("end-to-end flow works on the Prairie Foods tenant", async () => {
    const { documentId } = await runEndToEnd({
      approverId: FOOD_QA,
      orgId: FOOD_ORG,
      tag: "food",
      uploaderId: FOOD_OPS,
    });
    const otherTenant = await fetch(`${baseUrl}/api/documents/${documentId}`, {
      headers: headers(HERBA_ORG, HERBA_OPS),
    });
    expect(otherTenant.status).toBe(404);
  });

  it("tax: rules list is read-only and calculate stays stubbed (ADR D-07)", async () => {
    const rules = await fetch(`${baseUrl}/api/v1/tax/rules`, {
      headers: headers(FOOD_ORG, FOOD_QA),
    });
    expect(rules.status).toBe(200);
    const rulesBody = (await rules.json()) as { rules: unknown[] };
    expect(Array.isArray(rulesBody.rules)).toBe(true);
    const filtered = await fetch(`${baseUrl}/api/v1/tax/rules?jurisdiction=CA-MB`, {
      headers: headers(FOOD_ORG, FOOD_QA),
    });
    expect(filtered.status).toBe(200);
    const calculate = await fetch(`${baseUrl}/api/v1/tax/calculate`, {
      body: JSON.stringify({ rule_id: randomUUID(), subject_type: "sales_invoice" }),
      headers: jsonHeaders(FOOD_ORG, FOOD_QA),
      method: "POST",
    });
    expect(calculate.status).toBe(501);
    const calculateBody = (await calculate.json()) as { error: { code: string } };
    expect(calculateBody.error.code).toBe("NOT_IMPLEMENTED");
  });
});
