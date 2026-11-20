import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPool, runMigrations, runSeeds, verifyAuditChain } from "@qualios/db";
import { LocalFilesystemStorage } from "@qualios/storage";
import { createApp } from "./app.js";
import { setStorageForTests } from "./lib/storage.js";

/**
 * Document flow integration tests (Days 12–18).
 *
 * These need a real PostgreSQL (DATABASE_URL) — CI provides one (see
 * .github/workflows/ci.yml). Without DATABASE_URL the suite is skipped
 * rather than failing: run with DATABASE_URL set, e.g.
 *   DATABASE_URL=postgres://qualios:qualios@localhost:5432/qualios_test npm test
 *
 * Tests create a fresh organization + two users per run (uploader and a
 * different approver) and leave the rows in the scratch database; the
 * audit chain is per-organization, so leftover rows cannot break later
 * runs. Uploaded files go to a temp directory that is removed afterwards.
 */

const execFileAsync = promisify(execFile);
const DATABASE_URL = process.env.DATABASE_URL;
const hasDb = Boolean(DATABASE_URL);

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const SITE_A = randomUUID();
const UPLOADER = randomUUID();
const APPROVER = randomUUID();
// Unique per run, so re-running the suite against the same scratch database
// does not collide on the users.email unique constraint.
const RUN_ID = randomUUID().slice(0, 8);
const UPLOADER_EMAIL = `uploader-${RUN_ID}@test.example`;
const APPROVER_EMAIL = `approver-${RUN_ID}@test.example`;

const PDF_V1 = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
const PDF_V2 = Buffer.from("%PDF-1.4\n2 0 obj\n<< /Type /Catalog /Version 2 >>\nendobj\n");

function headers(orgId: string, userId: string): Record<string, string> {
  return { "x-organization-id": orgId, "x-user-id": userId };
}

function uploadForm(
  data: Buffer,
  fileName: string,
  mime: string,
  fields?: Record<string, string>,
): FormData {
  const form = new FormData();
  form.append("file", new Blob([data as BlobPart], { type: mime }), fileName);
  for (const [key, value] of Object.entries(fields ?? {})) {
    form.append(key, value);
  }
  return form;
}

describe.skipIf(!hasDb)("document upload, versions, review, audit (DB-backed)", () => {
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let baseUrl: string;
  let pool: Pool;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "qualios-storage-test-"));
    setStorageForTests(new LocalFilesystemStorage(tmpRoot));

    const dbPool = createPool(DATABASE_URL as string);
    await runMigrations(dbPool);
    await runSeeds(dbPool);
    await dbPool.end();

    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `INSERT INTO organizations (id, name, country, currency, status) VALUES ($1, 'Test Org A', 'CA', 'CAD', 'ACTIVE')`,
      [ORG_A],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, country, currency, status) VALUES ($1, 'Test Org B', 'CA', 'CAD', 'ACTIVE')`,
      [ORG_B],
    );
    await pool.query(
      `INSERT INTO sites (id, organization_id, name, timezone, status) VALUES ($1, $2, 'Test Site', 'America/Regina', 'ACTIVE')`,
      [SITE_A, ORG_A],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name, status) VALUES
         ($1, $3, 'Test Uploader', 'ACTIVE'),
         ($2, $4, 'Test Approver', 'ACTIVE')`,
      [UPLOADER, APPROVER, UPLOADER_EMAIL, APPROVER_EMAIL],
    );
    await pool.query(
      `INSERT INTO roles (id, organization_id, name, permissions) VALUES
         ($1, $2, 'TEST_UPLOADER', '["document.upload"]'::jsonb),
         ($3, $2, 'TEST_APPROVER', '["document.review"]'::jsonb)`,
      [randomUUID(), ORG_A, randomUUID()],
    );
    const roleRows = await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM roles WHERE organization_id = $1",
      [ORG_A],
    );
    const uploaderRole = roleRows.rows.find((r) => r.name === "TEST_UPLOADER")?.id;
    const approverRole = roleRows.rows.find((r) => r.name === "TEST_APPROVER")?.id;
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role_id, status) VALUES
         ($1, $2, $3, $4, 'ACTIVE'),
         ($5, $6, $3, $7, 'ACTIVE')`,
      [randomUUID(), UPLOADER, ORG_A, uploaderRole, randomUUID(), APPROVER, approverRole],
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
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  async function uploadDocument(
    data = PDF_V1,
    fileName = "batch-record.pdf",
  ): Promise<{
    status: number;
    body: { document: Record<string, unknown> };
  }> {
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: headers(ORG_A, UPLOADER),
      body: uploadForm(data, fileName, "application/pdf", {
        document_type: "BATCH_RECORD",
      }),
    });
    return {
      status: res.status,
      body: (await res.json()) as { document: Record<string, unknown> },
    };
  }

  it("uploads a document: 201, version 1, sha256 recorded", async () => {
    const { status, body } = await uploadDocument();
    expect(status).toBe(201);
    expect(body.document.status).toBe("UPLOADED");
    expect(body.document.document_type).toBe("BATCH_RECORD");
    expect(body.document.version_count).toBe(1);
    expect(body.document.latest_version).toBe(1);
    expect(typeof body.document.sha256).toBe("string");
    expect((body.document.sha256 as string).length).toBe(64);
  });

  it("rejects a disallowed MIME type", async () => {
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: headers(ORG_A, UPLOADER),
      body: uploadForm(Buffer.from("MZ..."), "evil.exe", "application/x-msdownload"),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FILE_TYPE_NOT_ALLOWED");
  });

  it("rejects content that does not match its declared type", async () => {
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: headers(ORG_A, UPLOADER),
      body: uploadForm(Buffer.from("this is not a pdf"), "fake.pdf", "application/pdf"),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FILE_CONTENT_MISMATCH");
  });

  it("requires tenant context", async () => {
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      body: uploadForm(PDF_V1, "batch-record.pdf", "application/pdf"),
    });
    expect(res.status).toBe(401);
  });

  it("uploads a new version and keeps the original downloadable", async () => {
    const { body } = await uploadDocument();
    const docId = body.document.id as string;

    const v2 = await fetch(`${baseUrl}/api/documents/${docId}/versions`, {
      method: "POST",
      headers: headers(ORG_A, UPLOADER),
      body: uploadForm(PDF_V2, "batch-record-v2.pdf", "application/pdf", {
        change_note: "Corrected quantity",
      }),
    });
    expect(v2.status).toBe(200);
    const v2Body = (await v2.json()) as {
      document: Record<string, unknown>;
      version_number: number;
    };
    expect(v2Body.version_number).toBe(2);
    expect(v2Body.document.version_count).toBe(2);
    expect(v2Body.document.status).toBe("UPLOADED");

    const downloadV1 = await fetch(`${baseUrl}/api/documents/${docId}/versions/1/download`, {
      headers: headers(ORG_A, UPLOADER),
    });
    expect(downloadV1.status).toBe(200);
    expect(Buffer.from(await downloadV1.arrayBuffer()).equals(PDF_V1)).toBe(true);

    const downloadV2 = await fetch(`${baseUrl}/api/documents/${docId}/versions/2/download`, {
      headers: headers(ORG_A, UPLOADER),
    });
    expect(downloadV2.status).toBe(200);
    expect(Buffer.from(await downloadV2.arrayBuffer()).equals(PDF_V2)).toBe(true);
  });

  it("lists the review queue and approves as a different user", async () => {
    const { body } = await uploadDocument();
    const docId = body.document.id as string;

    const queue = await fetch(`${baseUrl}/api/documents/review-queue`, {
      headers: headers(ORG_A, APPROVER),
    });
    expect(queue.status).toBe(200);
    const queueBody = (await queue.json()) as { documents: { id: string }[] };
    expect(queueBody.documents.some((d) => d.id === docId)).toBe(true);

    const review = await fetch(`${baseUrl}/api/documents/${docId}/review`, {
      method: "POST",
      headers: { ...headers(ORG_A, APPROVER), "content-type": "application/json" },
      body: JSON.stringify({ decision: "APPROVED", note: "Checked against the original." }),
    });
    expect(review.status).toBe(200);
    const reviewBody = (await review.json()) as {
      document: Record<string, unknown>;
      approval_id: string;
    };
    expect(reviewBody.document.status).toBe("VERIFIED");
    expect(typeof reviewBody.approval_id).toBe("string");

    // The approval row and the audit events exist.
    const approvals = await pool.query(
      "SELECT decision FROM approvals WHERE target_id = $1 AND organization_id = $2",
      [docId, ORG_A],
    );
    expect(approvals.rows).toHaveLength(1);
    expect(approvals.rows[0].decision).toBe("APPROVED");
    const events = await pool.query(
      "SELECT event_type FROM audit_events WHERE target_id = $1 AND organization_id = $2 ORDER BY seq",
      [docId, ORG_A],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual([
      "DOCUMENT_UPLOADED",
      "DOCUMENT_APPROVED",
    ]);
  });

  it("refuses the uploader reviewing their own document (segregation of duties)", async () => {
    const { body } = await uploadDocument();
    const docId = body.document.id as string;
    const review = await fetch(`${baseUrl}/api/documents/${docId}/review`, {
      method: "POST",
      headers: { ...headers(ORG_A, UPLOADER), "content-type": "application/json" },
      body: JSON.stringify({ decision: "APPROVED" }),
    });
    expect(review.status).toBe(403);
    const reviewBody = (await review.json()) as { error: { code: string } };
    expect(reviewBody.error.code).toBe("SEGREGATION_OF_DUTIES");
  });

  it("rejects a review without a reason, then accepts one with a reason", async () => {
    const { body } = await uploadDocument();
    const docId = body.document.id as string;
    const noNote = await fetch(`${baseUrl}/api/documents/${docId}/review`, {
      method: "POST",
      headers: { ...headers(ORG_A, APPROVER), "content-type": "application/json" },
      body: JSON.stringify({ decision: "REJECTED" }),
    });
    expect(noNote.status).toBe(400);
    const withNote = await fetch(`${baseUrl}/api/documents/${docId}/review`, {
      method: "POST",
      headers: { ...headers(ORG_A, APPROVER), "content-type": "application/json" },
      body: JSON.stringify({ decision: "REJECTED", note: "Illegible scan." }),
    });
    expect(withNote.status).toBe(200);
    const withNoteBody = (await withNote.json()) as { document: Record<string, unknown> };
    expect(withNoteBody.document.status).toBe("REJECTED");
  });

  it("refuses to re-review a decided document", async () => {
    const { body } = await uploadDocument();
    const docId = body.document.id as string;
    await fetch(`${baseUrl}/api/documents/${docId}/review`, {
      method: "POST",
      headers: { ...headers(ORG_A, APPROVER), "content-type": "application/json" },
      body: JSON.stringify({ decision: "APPROVED" }),
    });
    const again = await fetch(`${baseUrl}/api/documents/${docId}/review`, {
      method: "POST",
      headers: { ...headers(ORG_A, APPROVER), "content-type": "application/json" },
      body: JSON.stringify({ decision: "APPROVED" }),
    });
    expect(again.status).toBe(409);
    const againBody = (await again.json()) as { error: { code: string } };
    expect(againBody.error.code).toBe("DOCUMENT_NOT_REVIEWABLE");
  });

  it("does not leak documents across tenants", async () => {
    const { body } = await uploadDocument();
    const docId = body.document.id as string;
    const otherTenant = await fetch(`${baseUrl}/api/documents/${docId}`, {
      headers: headers(ORG_B, APPROVER),
    });
    expect(otherTenant.status).toBe(404);
    const otherQueue = await fetch(`${baseUrl}/api/documents/review-queue`, {
      headers: headers(ORG_B, APPROVER),
    });
    const queueBody = (await otherQueue.json()) as { documents: { id: string }[] };
    expect(queueBody.documents.some((d) => d.id === docId)).toBe(false);
  });

  it("serves the audit trail for a document", async () => {
    const { body } = await uploadDocument();
    const docId = body.document.id as string;
    const res = await fetch(`${baseUrl}/api/audit-events?target_type=document&target_id=${docId}`, {
      headers: headers(ORG_A, APPROVER),
    });
    expect(res.status).toBe(200);
    const resBody = (await res.json()) as {
      audit_events: { event_type: string; event_hash: string; previous_hash: string | null }[];
    };
    expect(resBody.audit_events).toHaveLength(1);
    expect(resBody.audit_events[0].event_type).toBe("DOCUMENT_UPLOADED");
    expect(typeof resBody.audit_events[0].event_hash).toBe("string");
  });

  it("rejects UPDATE and DELETE on audit_events at the database level", async () => {
    const { body } = await uploadDocument();
    const docId = body.document.id as string;
    const eventRow = await pool.query<{ id: string }>(
      "SELECT id FROM audit_events WHERE target_id = $1 AND organization_id = $2 LIMIT 1",
      [docId, ORG_A],
    );
    const eventId = eventRow.rows[0].id;
    await expect(
      pool.query("UPDATE audit_events SET event_type = 'FORGED' WHERE id = $1", [eventId]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM audit_events WHERE id = $1", [eventId])).rejects.toThrow(
      /append-only/,
    );
  });

  it("the hash chain verifies, and the verify CLI agrees", async () => {
    await uploadDocument();
    const result = await verifyAuditChain(pool);
    expect(result.ok).toBe(true);
    expect(result.totalEvents).toBeGreaterThan(0);

    // The CLI is the same code path, run as a separate process.
    const { stdout } = await execFileAsync("npx", ["tsx", "src/verify-audit-chain.ts"], {
      cwd: join(process.cwd(), "..", "..", "packages", "db"),
      env: { ...process.env, DATABASE_URL: DATABASE_URL as string },
    });
    expect(stdout).toMatch(/AUDIT CHAIN OK/);
  });
});
