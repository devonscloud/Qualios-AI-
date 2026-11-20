import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPool, runMigrations, runSeeds, verifyAuditChain } from "@qualios/db";
import { LocalFilesystemStorage } from "@qualios/storage";
import { createApp } from "./app.js";
import { setStorageForTests } from "./lib/storage.js";

/**
 * SOP + training integration tests (Phase 2, B-201–B-204, B-206).
 *
 * Needs a real PostgreSQL (DATABASE_URL) — same pattern as
 * documents.test.ts: without DATABASE_URL the suite is skipped.
 * Run with DATABASE_URL set, e.g.
 *   DATABASE_URL=postgres://qualios:qualios@127.0.0.1:5432/qualios_test npm test
 *
 * Flow under test: upload an SOP → approve (different user) → publish an
 * effective version → assign training on the effective version → employee
 * completes (acknowledgement) → manager verifies → dated audit-trail
 * export shows every step. Tenant isolation is proven with a second
 * organization that must see none of the first tenant's SOPs or training.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const hasDb = Boolean(DATABASE_URL);

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const UPLOADER = randomUUID();
const APPROVER = randomUUID();
const EMPLOYEE = randomUUID();
const ORG_B_USER = randomUUID();
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

describe.skipIf(!hasDb)("SOP publish + training (DB-backed)", () => {
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
      `INSERT INTO organizations (id, name, country, currency, status) VALUES
         ($1, 'Test Org A', 'CA', 'CAD', 'ACTIVE'),
         ($2, 'Test Org B', 'CA', 'CAD', 'ACTIVE')`,
      [ORG_A, ORG_B],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name, status) VALUES
         ($1, $2, 'Test Uploader', 'ACTIVE'),
         ($3, $4, 'Test Approver', 'ACTIVE'),
         ($5, $6, 'Test Employee', 'ACTIVE'),
         ($7, $8, 'Test Org B User', 'ACTIVE')`,
      [
        UPLOADER,
        `sop-uploader-${RUN_ID}@test.example`,
        APPROVER,
        `sop-approver-${RUN_ID}@test.example`,
        EMPLOYEE,
        `sop-employee-${RUN_ID}@test.example`,
        ORG_B_USER,
        `sop-orgb-${RUN_ID}@test.example`,
      ],
    );
    const roleA = randomUUID();
    const roleB = randomUUID();
    await pool.query(
      `INSERT INTO roles (id, organization_id, name, permissions) VALUES
         ($1, $2, 'TEST_SOP', '["document.upload", "document.review", "sop.publish", "training.assign", "training.verify"]'::jsonb),
         ($3, $4, 'TEST_SOP_B', '["document.upload"]'::jsonb)`,
      [roleA, ORG_A, roleB, ORG_B],
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role_id, status) VALUES
         ($1, $2, $3, $4, 'ACTIVE'),
         ($5, $6, $3, $4, 'ACTIVE'),
         ($7, $8, $3, $4, 'ACTIVE'),
         ($9, $10, $11, $12, 'ACTIVE')`,
      [
        randomUUID(),
        UPLOADER,
        ORG_A,
        roleA,
        randomUUID(),
        APPROVER,
        randomUUID(),
        EMPLOYEE,
        randomUUID(),
        ORG_B_USER,
        ORG_B,
        roleB,
      ],
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

  async function uploadSop(
    documentType = "SOP",
    data = PDF_V1,
  ): Promise<{ status: number; body: { document: Record<string, unknown> } }> {
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: headers(ORG_A, UPLOADER),
      body: uploadForm(data, "sop.pdf", { document_type: documentType }),
    });
    return {
      status: res.status,
      body: (await res.json()) as { document: Record<string, unknown> },
    };
  }

  async function approve(docId: string, userId: string = APPROVER): Promise<number> {
    const res = await fetch(`${baseUrl}/api/documents/${docId}/review`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, userId),
      body: JSON.stringify({ decision: "APPROVED", note: "Reviewed." }),
    });
    return res.status;
  }

  async function publish(
    docId: string,
    versionNumber: number,
    userId: string = APPROVER,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/documents/${docId}/publish`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, userId),
      body: JSON.stringify({ version_number: versionNumber }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** Upload → approve → publish; returns the effective SOP's document id. */
  async function makeEffectiveSop(): Promise<string> {
    const { body } = await uploadSop();
    const docId = body.document.id as string;
    expect(await approve(docId)).toBe(200);
    const { status, body: published } = await publish(docId, 1);
    expect(status).toBe(200);
    expect((published.document as Record<string, unknown>).effective_version).toBe(1);
    return docId;
  }

  async function assignTraining(
    docId: string,
    assigneeId: string = EMPLOYEE,
    assignerId: string = APPROVER,
    versionNumber?: number,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/training/assignments`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, assignerId),
      body: JSON.stringify({
        document_id: docId,
        assignee_id: assigneeId,
        due_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        ...(versionNumber === undefined ? {} : { version_number: versionNumber }),
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("uploads an SOP document (type SOP)", async () => {
    const { status, body } = await uploadSop();
    expect(status).toBe(201);
    expect(body.document.document_type).toBe("SOP");
    expect(body.document.status).toBe("UPLOADED");
    expect(body.document.effective_version).toBeNull();
  });

  it("refuses to publish an SOP that has not been approved", async () => {
    const { body } = await uploadSop();
    const docId = body.document.id as string;
    const { status, body: errBody } = await publish(docId, 1);
    expect(status).toBe(409);
    expect((errBody.error as { code: string }).code).toBe("DOCUMENT_NOT_APPROVED");
  });

  it("refuses to publish a non-SOP document", async () => {
    const { body } = await uploadSop("OTHER");
    const docId = body.document.id as string;
    expect(await approve(docId)).toBe(200);
    const { status, body: errBody } = await publish(docId, 1);
    expect(status).toBe(409);
    expect((errBody.error as { code: string }).code).toBe("DOCUMENT_NOT_SOP");
  });

  it("publishes an approved SOP as effective, and refuses the uploader publishing it", async () => {
    const { body } = await uploadSop();
    const docId = body.document.id as string;
    expect(await approve(docId)).toBe(200);

    const selfPublish = await publish(docId, 1, UPLOADER);
    expect(selfPublish.status).toBe(403);
    expect((selfPublish.body.error as { code: string }).code).toBe("SEGREGATION_OF_DUTIES");

    const { status, body: published } = await publish(docId, 1);
    expect(status).toBe(200);
    const document = published.document as Record<string, unknown>;
    expect(document.effective_version).toBe(1);
    expect(typeof document.effective_from).toBe("string");
    expect(typeof published.approval_id).toBe("string");

    // Publishing the same version again is a conflict.
    const again = await publish(docId, 1);
    expect(again.status).toBe(409);
    expect((again.body.error as { code: string }).code).toBe("VERSION_ALREADY_EFFECTIVE");
  });

  it("a new version clears the effective version until it is approved and published", async () => {
    const docId = await makeEffectiveSop();

    const v2 = await fetch(`${baseUrl}/api/documents/${docId}/versions`, {
      method: "POST",
      headers: headers(ORG_A, UPLOADER),
      body: uploadForm(PDF_V2, "sop-v2.pdf", { change_note: "Updated step 3." }),
    });
    expect(v2.status).toBe(200);
    const v2Body = (await v2.json()) as { document: Record<string, unknown> };
    expect(v2Body.document.effective_version).toBeNull();
    expect(v2Body.document.status).toBe("UPLOADED");

    // The old effective version can no longer be assigned.
    const assign = await assignTraining(docId);
    expect(assign.status).toBe(409);
    expect((assign.body.error as { code: string }).code).toBe("SOP_NOT_EFFECTIVE");

    expect(await approve(docId)).toBe(200);
    const { status, body: published } = await publish(docId, 2);
    expect(status).toBe(200);
    expect((published.document as Record<string, unknown>).effective_version).toBe(2);
  });

  it("assigns training on the effective SOP version", async () => {
    const docId = await makeEffectiveSop();
    const { status, body } = await assignTraining(docId);
    expect(status).toBe(201);
    const assignment = body.assignment as Record<string, unknown>;
    expect(assignment.document_id).toBe(docId);
    expect(assignment.version_number).toBe(1);
    expect(assignment.assignee_id).toBe(EMPLOYEE);
    expect(assignment.status).toBe("ASSIGNED");
    expect(assignment.overdue).toBe(false);

    // A second open assignment for the same user/version is a conflict.
    const duplicate = await assignTraining(docId);
    expect(duplicate.status).toBe(409);
    expect((duplicate.body.error as { code: string }).code).toBe("ASSIGNMENT_ALREADY_OPEN");
  });

  it("refuses to assign training on a non-effective version", async () => {
    const docId = await makeEffectiveSop();
    const { status, body } = await assignTraining(docId, EMPLOYEE, APPROVER, 99);
    expect(status).toBe(409);
    expect((body.error as { code: string }).code).toBe("TRAINING_VERSION_NOT_EFFECTIVE");
  });

  it("refuses to assign training to a user outside the tenant", async () => {
    const docId = await makeEffectiveSop();
    const { status, body } = await assignTraining(docId, ORG_B_USER);
    expect(status).toBe(400);
    expect((body.error as { code: string }).code).toBe("ASSIGNEE_NOT_IN_TENANT");
  });

  it("only the assignee can complete, and only with an acknowledgement", async () => {
    const docId = await makeEffectiveSop();
    const { body } = await assignTraining(docId);
    const assignmentId = (body.assignment as Record<string, unknown>).id as string;

    const byOther = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/complete`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, APPROVER),
      body: JSON.stringify({ acknowledgement: true }),
    });
    expect(byOther.status).toBe(403);
    expect(((await byOther.json()) as { error: { code: string } }).error.code).toBe("NOT_ASSIGNEE");

    const noAck = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/complete`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, EMPLOYEE),
      body: JSON.stringify({ acknowledgement: false }),
    });
    expect(noAck.status).toBe(400);

    const done = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/complete`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, EMPLOYEE),
      body: JSON.stringify({ acknowledgement: true, assessment_score: 90 }),
    });
    expect(done.status).toBe(200);
    const doneBody = (await done.json()) as { assignment: Record<string, unknown> };
    expect(doneBody.assignment.status).toBe("COMPLETED");
    const completion = doneBody.assignment.completion as Record<string, unknown>;
    expect(completion.acknowledgement).toBe(true);
    expect(completion.assessment_score).toBe(90);
    expect(completion.version_number).toBe(1);

    // Completing twice is a conflict.
    const again = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/complete`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, EMPLOYEE),
      body: JSON.stringify({ acknowledgement: true }),
    });
    expect(again.status).toBe(409);
  });

  it("manager review list shows the completion; the completer cannot verify it", async () => {
    const docId = await makeEffectiveSop();
    const { body } = await assignTraining(docId);
    const assignmentId = (body.assignment as Record<string, unknown>).id as string;
    const done = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/complete`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, EMPLOYEE),
      body: JSON.stringify({ acknowledgement: true }),
    });
    expect(done.status).toBe(200);

    const review = await fetch(`${baseUrl}/api/training/review`, {
      headers: headers(ORG_A, APPROVER),
    });
    expect(review.status).toBe(200);
    const reviewBody = (await review.json()) as {
      assignments: { id: string; status: string }[];
      counts: Record<string, number>;
    };
    expect(reviewBody.assignments.some((a) => a.id === assignmentId)).toBe(true);
    expect(reviewBody.counts.completed).toBeGreaterThanOrEqual(1);

    // Self-verification is refused (segregation of duties).
    const selfVerify = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/verify`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, EMPLOYEE),
      body: JSON.stringify({}),
    });
    expect(selfVerify.status).toBe(403);
    expect(((await selfVerify.json()) as { error: { code: string } }).error.code).toBe(
      "SEGREGATION_OF_DUTIES",
    );

    // The manager verifies.
    const verify = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/verify`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, APPROVER),
      body: JSON.stringify({ note: "Checked the acknowledgement." }),
    });
    expect(verify.status).toBe(200);
    const verifyBody = (await verify.json()) as { assignment: Record<string, unknown> };
    expect(verifyBody.assignment.verified_by).toBe(APPROVER);
    expect(typeof verifyBody.assignment.verified_at).toBe("string");

    // Verifying twice is a conflict.
    const again = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/verify`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, APPROVER),
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(409);
  });

  it("the dated audit-trail export shows every step of the full flow, in order", async () => {
    const docId = await makeEffectiveSop();
    const { body } = await assignTraining(docId);
    const assignmentId = (body.assignment as Record<string, unknown>).id as string;
    await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/complete`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, EMPLOYEE),
      body: JSON.stringify({ acknowledgement: true, assessment_score: 100 }),
    });
    await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/verify`, {
      method: "POST",
      headers: jsonHeaders(ORG_A, APPROVER),
      body: JSON.stringify({}),
    });

    const res = await fetch(`${baseUrl}/api/training/audit-trail/export?document_id=${docId}`, {
      headers: headers(ORG_A, APPROVER),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/qualios-sop-training-audit-trail-\d{4}-\d{2}-\d{2}\.csv/);
    const csv = await res.text();
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "seq,created_at,event_type,actor_id,actor_name,target_type,target_id,event_hash,payload",
    );
    const eventTypes = lines.slice(1).map((line) => line.split(",")[2]);
    expect(eventTypes).toEqual([
      "DOCUMENT_UPLOADED",
      "DOCUMENT_APPROVED",
      "SOP_PUBLISHED",
      "TRAINING_ASSIGNED",
      "TRAINING_COMPLETED",
      "TRAINING_VERIFIED",
    ]);
  });

  it("tenant B cannot see tenant A's SOPs or training records", async () => {
    const docId = await makeEffectiveSop();
    const { body } = await assignTraining(docId);
    const assignmentId = (body.assignment as Record<string, unknown>).id as string;

    // SOP invisible to tenant B.
    const doc = await fetch(`${baseUrl}/api/documents/${docId}`, {
      headers: headers(ORG_B, ORG_B_USER),
    });
    expect(doc.status).toBe(404);
    const sopList = await fetch(`${baseUrl}/api/documents?document_type=SOP`, {
      headers: headers(ORG_B, ORG_B_USER),
    });
    const sopListBody = (await sopList.json()) as { documents: { id: string }[] };
    expect(sopListBody.documents.some((d) => d.id === docId)).toBe(false);

    // Training invisible to tenant B: list, detail, review, export.
    const list = await fetch(`${baseUrl}/api/training/assignments`, {
      headers: headers(ORG_B, ORG_B_USER),
    });
    const listBody = (await list.json()) as { assignments: { id: string }[] };
    expect(listBody.assignments.some((a) => a.id === assignmentId)).toBe(false);
    const detail = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}`, {
      headers: headers(ORG_B, ORG_B_USER),
    });
    expect(detail.status).toBe(404);
    const complete = await fetch(`${baseUrl}/api/training/assignments/${assignmentId}/complete`, {
      method: "POST",
      headers: jsonHeaders(ORG_B, ORG_B_USER),
      body: JSON.stringify({ acknowledgement: true }),
    });
    expect(complete.status).toBe(404);
    const review = await fetch(`${baseUrl}/api/training/review`, {
      headers: headers(ORG_B, ORG_B_USER),
    });
    const reviewBody = (await review.json()) as {
      assignments: { id: string }[];
      counts: Record<string, number>;
    };
    expect(reviewBody.assignments.some((a) => a.id === assignmentId)).toBe(false);
    const exportRes = await fetch(`${baseUrl}/api/training/audit-trail/export`, {
      headers: headers(ORG_B, ORG_B_USER),
    });
    expect(exportRes.status).toBe(200);
    const csv = await exportRes.text();
    expect(csv.trim().split("\n")).toHaveLength(1); // header only, no tenant A events
  });

  it("the hash chain verifies after the SOP/training flow", async () => {
    await makeEffectiveSop();
    const result = await verifyAuditChain(pool);
    expect(result.ok).toBe(true);
    expect(result.totalEvents).toBeGreaterThan(0);
  });
});
