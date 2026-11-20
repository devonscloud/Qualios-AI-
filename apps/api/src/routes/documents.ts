import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { recordAuditEvent } from "@qualios/db";
import { buildStorageKey } from "@qualios/storage";
import { isTenantMember, isUuid, withTenant } from "../lib/db.js";
import { env } from "../lib/env.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { validateUpload } from "../lib/files.js";
import { getStorage } from "../lib/storage.js";

/**
 * Document routes — Sprint Days 12–14 (PRD FR-02, Data Model §3).
 *
 *  POST   /api/documents                              Upload a new document (version 1)
 *  POST   /api/documents/:id/versions                 Upload a new version of a document
 *  GET    /api/documents/review-queue                 Documents awaiting review
 *  GET    /api/documents                              List documents (tenant-scoped)
 *  GET    /api/documents/:id                          Document + versions
 *  GET    /api/documents/:id/versions/:n/download     Download one stored version
 *  POST   /api/documents/:id/review                   Approve or reject (reviewer dashboard)
 *
 * Every write is tenant-scoped (ADR-008 layer 1: organization_id on every
 * query) and writes an audit event in the same transaction (Data Model §7).
 * A new version never overwrites a previous one: each version is a separate
 * stored object and a separate document_versions row, and the documents row
 * points at the latest version. Uploading a new version resets the document
 * status to UPLOADED, because the new content has not been reviewed.
 *
 * Segregation of duties (Threat Model T-02): the reviewer must differ from
 * the uploader. Enforced here; note the tenant middleware is still a stub
 * (ADR-011), so the user id comes from a header and is only as trustworthy
 * as the caller — the check is real, the identity behind it is not yet.
 */

export const documentsRouter = Router();

const DOCUMENT_TYPES = [
  "BATCH_RECORD",
  "PACKING_SLIP",
  "COA",
  "TRANSFER_RECORD",
  "INVOICE",
  "LISTING_FORM",
  "OTHER",
] as const;
type DocumentType = (typeof DOCUMENT_TYPES)[number];

const REVIEWABLE_STATUSES = ["UPLOADED", "AWAITING_VERIFICATION"] as const;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes },
});

interface DocumentRow {
  id: string;
  organization_id: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  storage_key: string;
  file_name: string;
  mime_type: string;
  sha256: string;
  document_type: string;
  linked_lot_id: string | null;
  linked_batch_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  version_count: string;
  latest_version: string | null;
}

interface VersionRow {
  id: string;
  document_id: string;
  version_number: number;
  storage_key: string;
  created_by: string;
  created_at: string;
  change_note: string | null;
}

function toDocumentSummary(row: DocumentRow): Record<string, unknown> {
  return {
    id: row.id,
    organization_id: row.organization_id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    sha256: row.sha256,
    document_type: row.document_type,
    linked_lot_id: row.linked_lot_id,
    linked_batch_id: row.linked_batch_id,
    status: row.status,
    uploaded_by: row.uploaded_by,
    uploaded_by_name: row.uploaded_by_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version_count: Number(row.version_count),
    latest_version: row.latest_version === null ? null : Number(row.latest_version),
  };
}

function toVersionSummary(row: VersionRow): Record<string, unknown> {
  return {
    id: row.id,
    document_id: row.document_id,
    version_number: row.version_number,
    storage_key: row.storage_key,
    created_by: row.created_by,
    created_at: row.created_at,
    change_note: row.change_note,
  };
}

const DOCUMENT_SELECT = `
  d.id, d.organization_id, d.uploaded_by, u.display_name AS uploaded_by_name,
  d.storage_key, d.file_name, d.mime_type, d.sha256, d.document_type,
  d.linked_lot_id, d.linked_batch_id, d.status, d.created_at, d.updated_at,
  (SELECT count(*) FROM document_versions v WHERE v.document_id = d.id) AS version_count,
  (SELECT max(v.version_number) FROM document_versions v WHERE v.document_id = d.id) AS latest_version
  FROM documents d
  LEFT JOIN users u ON u.id = d.uploaded_by
`;

function requireTenant(req: Request): {
  organizationId: string;
  userId: string;
  siteId: string | null;
} {
  const tenant = req.tenant;
  if (!tenant) throw new Error("tenant middleware did not run");
  return tenant;
}

/** Express 5 types route params as string | string[]; a repeated param is a client error. */
function paramString(value: string | string[], field: string): string {
  if (Array.isArray(value)) {
    throw badRequest("INVALID_ID", `${field} must be a single value.`);
  }
  return value;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function parseOptionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isUuid(value)) {
    throw badRequest("INVALID_FIELD", `${field} must be a UUID.`);
  }
  return value;
}

function parseDocumentType(value: unknown): DocumentType {
  if (value === undefined || value === null || value === "") return "OTHER";
  if (typeof value === "string" && (DOCUMENT_TYPES as readonly string[]).includes(value)) {
    return value as DocumentType;
  }
  throw badRequest("INVALID_FIELD", `document_type must be one of: ${DOCUMENT_TYPES.join(", ")}.`);
}

async function assertLinkedRecordExists(
  client: { query: (text: string, values: unknown[]) => Promise<{ rows: { exists: boolean }[] }> },
  organizationId: string,
  table: "lots" | "batches",
  id: string,
  field: string,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2) AS exists`,
    [id, organizationId],
  );
  if (!rows[0]?.exists) {
    throw badRequest("LINKED_RECORD_NOT_FOUND", `${field} does not exist in this organization.`);
  }
}

/** Upload a new document (version 1). */
documentsRouter.post("/", upload.single("file"), async (req: Request, res: Response) => {
  const { organizationId, userId, siteId } = requireTenant(req);
  const file = req.file;
  if (!file) {
    throw badRequest("FILE_REQUIRED", "A file upload is required (multipart field 'file').");
  }
  const validationError = validateUpload(file.originalname, file.mimetype, file.buffer);
  if (validationError) {
    throw badRequest(validationError.code, validationError.message);
  }
  const documentType = parseDocumentType(req.body.document_type);
  const linkedLotId = parseOptionalUuid(req.body.linked_lot_id, "linked_lot_id");
  const linkedBatchId = parseOptionalUuid(req.body.linked_batch_id, "linked_batch_id");
  const changeNote =
    typeof req.body.change_note === "string" && req.body.change_note !== ""
      ? req.body.change_note
      : null;

  const documentId = randomUUID();
  const storageKey = buildStorageKey({
    organizationId,
    siteId,
    documentId,
    versionNumber: 1,
    fileName: file.originalname,
  });
  const hash = sha256Hex(file.buffer);
  const storage = getStorage();

  // Store the object first; if the database write then fails, the orphaned
  // object is removed best-effort (no row ever points at it).
  await storage.put(storageKey, file.buffer, file.mimetype);
  try {
    const created = await withTenant(organizationId, async (client) => {
      if (!(await isTenantMember(client, organizationId, userId))) {
        throw forbidden(
          "USER_NOT_IN_TENANT",
          "The calling user is not a member of this organization.",
        );
      }
      if (linkedLotId) {
        await assertLinkedRecordExists(
          client,
          organizationId,
          "lots",
          linkedLotId,
          "linked_lot_id",
        );
      }
      if (linkedBatchId) {
        await assertLinkedRecordExists(
          client,
          organizationId,
          "batches",
          linkedBatchId,
          "linked_batch_id",
        );
      }
      await client.query(
        `INSERT INTO documents
           (id, organization_id, uploaded_by, storage_key, file_name, mime_type, sha256,
            document_type, linked_lot_id, linked_batch_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'UPLOADED')`,
        [
          documentId,
          organizationId,
          userId,
          storageKey,
          file.originalname,
          file.mimetype,
          hash,
          documentType,
          linkedLotId,
          linkedBatchId,
        ],
      );
      await client.query(
        `INSERT INTO document_versions
           (document_id, version_number, storage_key, created_by, change_note)
         VALUES ($1, 1, $2, $3, $4)`,
        [documentId, storageKey, userId, changeNote],
      );
      await recordAuditEvent(client, {
        organizationId,
        actorId: userId,
        eventType: "DOCUMENT_UPLOADED",
        targetType: "document",
        targetId: documentId,
        payload: {
          file_name: file.originalname,
          mime_type: file.mimetype,
          sha256: hash,
          document_type: documentType,
          version_number: 1,
        },
        modelVersion: null,
        createdAt: new Date(),
      });
      // Re-read last, after the version row exists, so version_count and
      // latest_version in the response are correct.
      const inserted = await client.query<DocumentRow>(
        `SELECT ${DOCUMENT_SELECT} WHERE d.id = $1 AND d.organization_id = $2`,
        [documentId, organizationId],
      );
      return inserted.rows[0];
    });
    res.status(201).json({ document: toDocumentSummary(created) });
  } catch (error) {
    await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
});

/** Upload a new version of an existing document. Previous versions are kept. */
documentsRouter.post(
  "/:id/versions",
  upload.single("file"),
  async (req: Request, res: Response) => {
    const { organizationId, userId, siteId } = requireTenant(req);
    const documentId = paramString(req.params.id, "document id");
    if (!isUuid(documentId)) {
      throw badRequest("INVALID_ID", "Document id must be a UUID.");
    }
    const file = req.file;
    if (!file) {
      throw badRequest("FILE_REQUIRED", "A file upload is required (multipart field 'file').");
    }
    const validationError = validateUpload(file.originalname, file.mimetype, file.buffer);
    if (validationError) {
      throw badRequest(validationError.code, validationError.message);
    }
    const changeNote =
      typeof req.body.change_note === "string" && req.body.change_note !== ""
        ? req.body.change_note
        : null;
    const hash = sha256Hex(file.buffer);
    const storage = getStorage();

    let storageKey: string | null = null;
    try {
      const result = await withTenant(organizationId, async (client) => {
        if (!(await isTenantMember(client, organizationId, userId))) {
          throw forbidden(
            "USER_NOT_IN_TENANT",
            "The calling user is not a member of this organization.",
          );
        }
        const doc = await client.query<{ id: string; file_name: string }>(
          "SELECT id, file_name FROM documents WHERE id = $1 AND organization_id = $2 FOR UPDATE",
          [documentId, organizationId],
        );
        if (doc.rows.length === 0) {
          throw notFound("DOCUMENT_NOT_FOUND", "No document with this id in this organization.");
        }
        const maxVersion = await client.query<{ max: string | null }>(
          "SELECT max(version_number) AS max FROM document_versions WHERE document_id = $1",
          [documentId],
        );
        const nextVersion =
          (maxVersion.rows[0]?.max === null ? 0 : Number(maxVersion.rows[0]?.max)) + 1;
        storageKey = buildStorageKey({
          organizationId,
          siteId,
          documentId,
          versionNumber: nextVersion,
          fileName: file.originalname,
        });
        // The row lock above serializes version uploads for this document, so
        // two concurrent uploads cannot both claim the same version number.
        await storage.put(storageKey, file.buffer, file.mimetype);
        await client.query(
          `INSERT INTO document_versions
           (document_id, version_number, storage_key, created_by, change_note)
         VALUES ($1, $2, $3, $4, $5)`,
          [documentId, nextVersion, storageKey, userId, changeNote],
        );
        await client.query(
          `UPDATE documents SET
           storage_key = $2, file_name = $3, mime_type = $4, sha256 = $5, status = 'UPLOADED'
         WHERE id = $1 AND organization_id = $6`,
          [documentId, storageKey, file.originalname, file.mimetype, hash, organizationId],
        );
        const updated = await client.query<DocumentRow>(
          `SELECT ${DOCUMENT_SELECT} WHERE d.id = $1 AND d.organization_id = $2`,
          [documentId, organizationId],
        );
        await recordAuditEvent(client, {
          organizationId,
          actorId: userId,
          eventType: "DOCUMENT_VERSION_UPLOADED",
          targetType: "document",
          targetId: documentId,
          payload: {
            file_name: file.originalname,
            mime_type: file.mimetype,
            sha256: hash,
            version_number: nextVersion,
            change_note: changeNote,
          },
          modelVersion: null,
          createdAt: new Date(),
        });
        return { document: updated.rows[0], versionNumber: nextVersion };
      });
      res.status(200).json({
        document: toDocumentSummary(result.document),
        version_number: result.versionNumber,
      });
    } catch (error) {
      if (storageKey !== null) {
        await storage.delete(storageKey).catch(() => undefined);
      }
      throw error;
    }
  },
);

/** Reviewer dashboard data: documents awaiting a review decision. */
documentsRouter.get("/review-queue", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const { rows } = await withTenant(organizationId, async (client) =>
    client.query<DocumentRow>(
      `SELECT ${DOCUMENT_SELECT} WHERE d.organization_id = $1 AND d.status = ANY ($2)
       ORDER BY d.created_at DESC LIMIT 100`,
      [organizationId, [...REVIEWABLE_STATUSES]],
    ),
  );
  res.status(200).json({ documents: rows.map(toDocumentSummary) });
});

/** List documents for this tenant, newest first. */
documentsRouter.get("/", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  const { rows } = await withTenant(organizationId, async (client) =>
    client.query<DocumentRow>(
      `SELECT ${DOCUMENT_SELECT} WHERE d.organization_id = $1
       ORDER BY d.created_at DESC LIMIT $2 OFFSET $3`,
      [organizationId, limit, offset],
    ),
  );
  res.status(200).json({ documents: rows.map(toDocumentSummary), limit, offset });
});

/** One document with its full version history. */
documentsRouter.get("/:id", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const documentId = paramString(req.params.id, "document id");
  if (!isUuid(documentId)) {
    throw badRequest("INVALID_ID", "Document id must be a UUID.");
  }
  const { document, versions } = await withTenant(organizationId, async (client) => {
    const doc = await client.query<DocumentRow>(
      `SELECT ${DOCUMENT_SELECT} WHERE d.id = $1 AND d.organization_id = $2`,
      [documentId, organizationId],
    );
    if (doc.rows.length === 0) {
      throw notFound("DOCUMENT_NOT_FOUND", "No document with this id in this organization.");
    }
    const vers = await client.query<VersionRow>(
      `SELECT id, document_id, version_number, storage_key, created_by, created_at, change_note
       FROM document_versions WHERE document_id = $1 ORDER BY version_number ASC`,
      [documentId],
    );
    return { document: doc.rows[0], versions: vers.rows };
  });
  res.status(200).json({
    document: toDocumentSummary(document),
    versions: versions.map(toVersionSummary),
  });
});

/** Download one stored version (the original file, verbatim). */
documentsRouter.get(
  "/:id/versions/:versionNumber/download",
  async (req: Request, res: Response) => {
    const { organizationId } = requireTenant(req);
    const documentId = paramString(req.params.id, "document id");
    const versionNumber = Number(paramString(req.params.versionNumber, "version number"));
    if (!isUuid(documentId) || !Number.isInteger(versionNumber) || versionNumber < 1) {
      throw badRequest("INVALID_ID", "Document id must be a UUID and version a positive integer.");
    }
    const found = await withTenant(organizationId, async (client) => {
      const { rows } = await client.query<{
        storage_key: string;
        file_name: string;
        mime_type: string;
      }>(
        `SELECT v.storage_key, d.file_name, d.mime_type
       FROM document_versions v
       JOIN documents d ON d.id = v.document_id
       WHERE v.document_id = $1 AND v.version_number = $2 AND d.organization_id = $3`,
        [documentId, versionNumber, organizationId],
      );
      return rows[0] ?? null;
    });
    if (!found) {
      throw notFound("VERSION_NOT_FOUND", "No such version in this organization.");
    }
    const data = await getStorage().get(found.storage_key);
    res.setHeader("Content-Type", found.mime_type);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Content-Disposition", `attachment; filename="${found.file_name}"`);
    res.status(200).send(data);
  },
);

/**
 * Review a document: APPROVED sets status VERIFIED, REJECTED sets REJECTED.
 * A note is required for a rejection. The approver must differ from the
 * uploader (segregation of duties, T-02). A document that is already
 * VERIFIED or REJECTED cannot be re-reviewed — upload a new version instead.
 */
documentsRouter.post("/:id/review", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const documentId = paramString(req.params.id, "document id");
  if (!isUuid(documentId)) {
    throw badRequest("INVALID_ID", "Document id must be a UUID.");
  }
  const decision = req.body?.decision;
  if (decision !== "APPROVED" && decision !== "REJECTED") {
    throw badRequest("INVALID_FIELD", "decision must be APPROVED or REJECTED.");
  }
  const note = typeof req.body?.note === "string" ? req.body.note : null;
  if (decision === "REJECTED" && (note === null || note.trim() === "")) {
    throw badRequest("INVALID_FIELD", "A note (reason) is required when rejecting a document.");
  }

  const result = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    const doc = await client.query<{
      id: string;
      uploaded_by: string;
      status: string;
    }>(
      "SELECT id, uploaded_by, status FROM documents WHERE id = $1 AND organization_id = $2 FOR UPDATE",
      [documentId, organizationId],
    );
    if (doc.rows.length === 0) {
      throw notFound("DOCUMENT_NOT_FOUND", "No document with this id in this organization.");
    }
    const current = doc.rows[0];
    if (!(REVIEWABLE_STATUSES as readonly string[]).includes(current.status)) {
      throw conflict(
        "DOCUMENT_NOT_REVIEWABLE",
        `Document is ${current.status} and cannot be reviewed. Upload a new version to re-review it.`,
      );
    }
    if (current.uploaded_by === userId) {
      throw forbidden(
        "SEGREGATION_OF_DUTIES",
        "The uploader cannot review their own document; a different reviewer must decide.",
      );
    }
    const newStatus = decision === "APPROVED" ? "VERIFIED" : "REJECTED";
    const approval = await client.query<{ id: string; decided_at: string }>(
      `INSERT INTO approvals
         (organization_id, action_type, target_id, target_type, approver_id, decision, note)
       VALUES ($1, 'DOCUMENT_REVIEW', $2, 'document', $3, $4, $5)
       RETURNING id, decided_at`,
      [organizationId, documentId, userId, decision, note],
    );
    await client.query(`UPDATE documents SET status = $2 WHERE id = $1 AND organization_id = $3`, [
      documentId,
      newStatus,
      organizationId,
    ]);
    const updated = await client.query<DocumentRow>(
      `SELECT ${DOCUMENT_SELECT} WHERE d.id = $1 AND d.organization_id = $2`,
      [documentId, organizationId],
    );
    await recordAuditEvent(client, {
      organizationId,
      actorId: userId,
      eventType: decision === "APPROVED" ? "DOCUMENT_APPROVED" : "DOCUMENT_REJECTED",
      targetType: "document",
      targetId: documentId,
      payload: {
        decision,
        note,
        approval_id: approval.rows[0].id,
        new_status: newStatus,
      },
      modelVersion: null,
      createdAt: new Date(),
    });
    return { document: updated.rows[0], approvalId: approval.rows[0].id };
  });
  res.status(200).json({
    document: toDocumentSummary(result.document),
    approval_id: result.approvalId,
  });
});
