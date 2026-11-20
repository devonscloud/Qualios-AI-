import { createHash, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { recordAuditEvent } from "@qualios/db";
import { importHeaderAliasesForPacks, sourceSystemsForPack } from "@qualios/industry-packs";
import { buildImportStorageKey } from "@qualios/storage";
import { parseTabularFile, TabularParseError } from "../lib/csv.js";
import { isTenantMember, isUuid, withTenant } from "../lib/db.js";
import { env } from "../lib/env.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { validateUpload } from "../lib/files.js";
import {
  applyMapping,
  autoMapFields,
  normalizeMovementType,
  parseRecordedDate,
  resolveRowQuantities,
  RowValidationError,
  validateExplicitMapping,
  validateMappingCoverage,
  type CanonicalField,
  type FieldMapping,
  type MovementType,
} from "../lib/imports.js";
import { getEnabledPackIds } from "../lib/packs.js";
import { getStorage } from "../lib/storage.js";

/**
 * External record import routes — a cannabis-pack surface (B-110).
 * The core concept is generic: an external record set (snapshot) or a
 * list of movements (ledger). The cannabis pack contributes the
 * seed-to-sale source system and its file header aliases; the core
 * import kinds are EXTERNAL_SNAPSHOT, PAPER_COUNT, and ALLOCATION.
 * This router is gated by requirePack("cannabis-ca") in app.ts.
 *
 *  POST /api/imports                  Upload a CSV/XLSX file and import it
 *  GET  /api/imports                  List import runs (tenant-scoped)
 *  GET  /api/imports/:id              One run + its rows (the import log)
 *  GET  /api/imports/:id/download     Download the stored original file
 *
 * Modes (see migration 0009):
 *  - SNAPSHOT (default): the file is an external record set. Rows are
 *    stored as import_rows and are what a reconciliation run compares the
 *    ledger against. No movements are written.
 *  - LEDGER: each accepted row writes one inventory_movement. Positions are
 *    still never edited directly — they are derived from the ledger.
 *
 * A row is never silently dropped: every row is recorded in import_rows as
 * ACCEPTED or REJECTED with a reason. A file that cannot be mapped to the
 * required fields (lot_number + a quantity) is rejected at the file level
 * and recorded as a FAILED run, so the attempt is auditable.
 */

export const importsRouter = Router();

const IMPORT_KINDS = ["EXTERNAL_SNAPSHOT", "PAPER_COUNT", "ALLOCATION"] as const;
type ImportKind = (typeof IMPORT_KINDS)[number];
const IMPORT_MODES = ["SNAPSHOT", "LEDGER"] as const;
type ImportMode = (typeof IMPORT_MODES)[number];

/** Only tabular files are importable (the generic allowlist also has PDFs/images). */
const IMPORTABLE_MIMES = [
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes },
});

/** Movement types that add stock vs remove it. ADJUST keeps its file sign. */
const POSITIVE_MOVEMENTS: readonly MovementType[] = ["RECEIVE", "TRANSFER_IN", "PRODUCE", "RETURN"];
const NEGATIVE_MOVEMENTS: readonly MovementType[] = ["CONSUME", "TRANSFER_OUT", "DESTROY", "SHIP"];

function sourceSystemFor(kind: ImportKind): string {
  if (kind === "EXTERNAL_SNAPSHOT") return "EXTERNAL_SYSTEM";
  if (kind === "PAPER_COUNT") return "PAPER_RECORD";
  return "MANUAL";
}

/**
 * Validate the caller-supplied external source system (e.g. SEED_TO_SALE
 * for the cannabis pack). It must be a source system registered by one of
 * the tenant's enabled packs; null means "not stated".
 */
async function parseExternalSource(organizationId: string, value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw badRequest("INVALID_FIELD", "source_system must be a string.");
  }
  const enabled = await getEnabledPackIds(organizationId);
  const allowed = enabled.flatMap((packId) =>
    sourceSystemsForPack(packId).map((source) => source.key),
  );
  if (!allowed.includes(value)) {
    throw badRequest(
      "INVALID_FIELD",
      `source_system "${value}" is not registered by any pack enabled for this organization.`,
    );
  }
  return value;
}

interface ImportRunRow {
  id: string;
  organization_id: string;
  site_id: string | null;
  import_kind: string;
  import_mode: string;
  external_source: string | null;
  file_name: string;
  mime_type: string;
  sha256: string;
  storage_key: string;
  mapping: Record<string, unknown>;
  status: string;
  rows_total: number;
  rows_accepted: number;
  rows_rejected: number;
  error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface ImportRowRow {
  id: string;
  import_run_id: string;
  row_number: number;
  raw_data: Record<string, unknown>;
  status: string;
  error: string | null;
  movement_id: string | null;
  recorded_date: string | null;
  lot_number: string | null;
  quantity_mg: number | null;
  quantity_units: number | null;
  created_at: string;
}

function toRunSummary(row: ImportRunRow): Record<string, unknown> {
  return {
    id: row.id,
    organization_id: row.organization_id,
    site_id: row.site_id,
    import_kind: row.import_kind,
    import_mode: row.import_mode,
    external_source: row.external_source,
    file_name: row.file_name,
    mime_type: row.mime_type,
    sha256: row.sha256,
    mapping: row.mapping,
    status: row.status,
    rows_total: row.rows_total,
    rows_accepted: row.rows_accepted,
    rows_rejected: row.rows_rejected,
    error: row.error,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toRowSummary(row: ImportRowRow): Record<string, unknown> {
  return {
    id: row.id,
    import_run_id: row.import_run_id,
    row_number: row.row_number,
    raw_data: row.raw_data,
    status: row.status,
    error: row.error,
    movement_id: row.movement_id,
    recorded_date: row.recorded_date,
    lot_number: row.lot_number,
    quantity_mg: row.quantity_mg,
    quantity_units: row.quantity_units,
    created_at: row.created_at,
  };
}

function requireTenant(req: Request): {
  organizationId: string;
  userId: string;
  siteId: string | null;
} {
  const tenant = req.tenant;
  if (!tenant) throw new Error("tenant middleware did not run");
  return tenant;
}

function paramString(value: string | string[], field: string): string {
  if (Array.isArray(value)) {
    throw badRequest("INVALID_ID", `${field} must be a single value.`);
  }
  return value;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function parseImportKind(value: unknown): ImportKind {
  if (typeof value === "string" && (IMPORT_KINDS as readonly string[]).includes(value)) {
    return value as ImportKind;
  }
  throw badRequest("INVALID_FIELD", `import_kind must be one of: ${IMPORT_KINDS.join(", ")}.`);
}

function parseImportMode(value: unknown): ImportMode {
  if (value === undefined || value === null || value === "") return "SNAPSHOT";
  if (typeof value === "string" && (IMPORT_MODES as readonly string[]).includes(value)) {
    return value as ImportMode;
  }
  throw badRequest("INVALID_FIELD", `import_mode must be one of: ${IMPORT_MODES.join(", ")}.`);
}

function parseOptionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isUuid(value)) {
    throw badRequest("INVALID_FIELD", `${field} must be a UUID.`);
  }
  return value;
}

/**
 * Validate one parsed row against the tenant's data and, in LEDGER mode,
 * resolve it to a movement. Returns the import-row values to insert, or
 * the rejection reason. `lotCache`/`locationCache` avoid re-querying the
 * same lot/location for every row of a large file.
 */
async function processRow(
  client: {
    query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  },
  args: {
    organizationId: string;
    userId: string;
    importKind: ImportKind;
    importMode: ImportMode;
    /** Pack-registered external source (e.g. SEED_TO_SALE), or null. */
    externalSource: string | null;
    runId: string;
    rowNumber: number;
    values: Record<string, string>;
    mapping: FieldMapping;
    lotCache: Map<string, { id: string; product_id: string | null } | null>;
    locationCache: Map<string, string | null>;
  },
): Promise<{
  status: "ACCEPTED" | "REJECTED";
  error: string | null;
  movementId: string | null;
  recordedDate: Date | null;
  lotNumber: string | null;
  quantityMg: number | null;
  quantityUnits: number | null;
}> {
  const {
    organizationId,
    userId,
    importKind,
    importMode,
    externalSource,
    runId,
    rowNumber,
    values,
    mapping,
  } = args;
  const mapped = applyMapping(values, mapping);
  const lotNumber = mapped.lot_number ?? null;

  // Quantities resolve before the lot lookup, so a row rejected for an
  // unknown lot still carries its quantities for the LOT_MISMATCH check.
  let quantityMg: number | null = null;
  let quantityUnits: number | null = null;
  let movementType: MovementType | null = null;
  if (mapped.movement_type !== undefined) {
    try {
      movementType = normalizeMovementType(mapped.movement_type);
    } catch (error) {
      if (error instanceof RowValidationError) {
        return {
          status: "REJECTED",
          error: error.message,
          movementId: null,
          recordedDate: null,
          lotNumber,
          quantityMg: null,
          quantityUnits: null,
        };
      }
      throw error;
    }
  }
  try {
    const resolved = resolveRowQuantities(mapped, {
      allowNegative: movementType === "ADJUST",
    });
    quantityMg = resolved.quantityMg;
    quantityUnits = resolved.quantityUnits;
  } catch (error) {
    if (error instanceof RowValidationError) {
      return {
        status: "REJECTED",
        error: error.message,
        movementId: null,
        recordedDate: null,
        lotNumber,
        quantityMg: null,
        quantityUnits: null,
      };
    }
    throw error;
  }

  let recordedDate: Date | null = null;
  try {
    recordedDate = parseRecordedDate(mapped.recorded_date);
  } catch (error) {
    if (error instanceof RowValidationError) {
      return {
        status: "REJECTED",
        error: error.message,
        movementId: null,
        recordedDate: null,
        lotNumber,
        quantityMg,
        quantityUnits,
      };
    }
    throw error;
  }

  if (lotNumber === null) {
    return {
      status: "REJECTED",
      error: "Row has no lot_number value.",
      movementId: null,
      recordedDate,
      lotNumber,
      quantityMg,
      quantityUnits,
    };
  }
  if (!args.lotCache.has(lotNumber)) {
    const found = await client.query(
      `SELECT id, product_id FROM lots WHERE organization_id = $1 AND lot_number = $2`,
      [organizationId, lotNumber],
    );
    const row = found.rows[0] as { id: string; product_id: string | null } | undefined;
    args.lotCache.set(lotNumber, row ?? null);
  }
  const lot = args.lotCache.get(lotNumber) ?? null;
  if (lot === null) {
    return {
      status: "REJECTED",
      error: `LOT_NOT_FOUND: lot ${lotNumber} does not exist in this organization.`,
      movementId: null,
      recordedDate,
      lotNumber,
      quantityMg,
      quantityUnits,
    };
  }

  if (importMode === "SNAPSHOT") {
    return {
      status: "ACCEPTED",
      error: null,
      movementId: null,
      recordedDate,
      lotNumber,
      quantityMg,
      quantityUnits,
    };
  }

  // LEDGER mode: the row becomes one movement.
  if (movementType === null) {
    return {
      status: "REJECTED",
      error: "movement_type is required in LEDGER mode.",
      movementId: null,
      recordedDate,
      lotNumber,
      quantityMg,
      quantityUnits,
    };
  }
  if (movementType === "PACKAGE") {
    return {
      status: "REJECTED",
      error:
        "PACKAGE movements move stock between two locations and cannot be expressed as one import row; record packaging in the app for now.",
      movementId: null,
      recordedDate,
      lotNumber,
      quantityMg,
      quantityUnits,
    };
  }
  const locationName = mapped.location;
  if (locationName === undefined) {
    return {
      status: "REJECTED",
      error: "location is required in LEDGER mode.",
      movementId: null,
      recordedDate,
      lotNumber,
      quantityMg,
      quantityUnits,
    };
  }
  if (!args.locationCache.has(locationName)) {
    const found = await client.query(
      `SELECT id FROM inventory_locations
       WHERE organization_id = $1 AND (name = $2 OR external_reference = $2)`,
      [organizationId, locationName],
    );
    const row = found.rows[0] as { id: string } | undefined;
    args.locationCache.set(locationName, row?.id ?? null);
  }
  const locationId = args.locationCache.get(locationName) ?? null;
  if (locationId === null) {
    return {
      status: "REJECTED",
      error: `LOCATION_NOT_FOUND: location "${locationName}" does not exist in this organization.`,
      movementId: null,
      recordedDate,
      lotNumber,
      quantityMg,
      quantityUnits,
    };
  }

  const sign =
    movementType === "ADJUST"
      ? 1
      : POSITIVE_MOVEMENTS.includes(movementType)
        ? 1
        : NEGATIVE_MOVEMENTS.includes(movementType)
          ? -1
          : 1;
  const movementId = randomUUID();
  await client.query(
    `INSERT INTO inventory_movements
       (id, organization_id, lot_id, location_id, movement_type,
        quantity_mg, quantity_units, source_system, source_system_detail, source_reference,
        document_id, recorded_at, entered_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12, $13)`,
    [
      movementId,
      organizationId,
      lot.id,
      locationId,
      movementType,
      sign * (quantityMg ?? 0),
      quantityUnits === null ? null : sign * quantityUnits,
      sourceSystemFor(importKind),
      externalSource,
      mapped.source_reference ?? `IMPORT:${runId}:row${rowNumber}`,
      recordedDate === null ? new Date().toISOString() : recordedDate.toISOString(),
      userId,
      mapped.note ?? null,
    ],
  );
  return {
    status: "ACCEPTED",
    error: null,
    movementId,
    recordedDate,
    lotNumber,
    quantityMg,
    quantityUnits,
  };
}

/** Upload a file and import it. */
importsRouter.post("/", upload.single("file"), async (req: Request, res: Response) => {
  const { organizationId, userId, siteId: headerSiteId } = requireTenant(req);
  const file = req.file;
  if (!file) {
    throw badRequest("FILE_REQUIRED", "A file upload is required (multipart field 'file').");
  }
  const validationError = validateUpload(file.originalname, file.mimetype, file.buffer);
  if (validationError) {
    throw badRequest(validationError.code, validationError.message);
  }
  if (!(IMPORTABLE_MIMES as readonly string[]).includes(file.mimetype)) {
    throw badRequest(
      "FILE_TYPE_NOT_ALLOWED",
      `Imports accept CSV and XLSX only, not ${file.mimetype}.`,
    );
  }
  const importKind = parseImportKind(req.body.import_kind);
  const importMode = parseImportMode(req.body.import_mode);
  const externalSource = await parseExternalSource(organizationId, req.body.source_system);
  const siteId = parseOptionalUuid(req.body.site_id, "site_id") ?? headerSiteId;
  const runId = randomUUID();
  const hash = sha256Hex(file.buffer);
  const storageKey = buildImportStorageKey({
    organizationId,
    siteId,
    importRunId: runId,
    fileName: file.originalname,
  });
  const storage = getStorage();

  // Parse and map before touching the database or storage: a file that
  // cannot be parsed or mapped is recorded as a FAILED run, not silently
  // dropped and not half-applied.
  let tabular: ReturnType<typeof parseTabularFile>;
  try {
    tabular = parseTabularFile(file.buffer, file.mimetype);
  } catch (error) {
    if (error instanceof TabularParseError) {
      const failed = await withTenant(organizationId, async (client) => {
        if (!(await isTenantMember(client, organizationId, userId))) {
          throw forbidden(
            "USER_NOT_IN_TENANT",
            "The calling user is not a member of this organization.",
          );
        }
        const inserted = await client.query<ImportRunRow>(
          `INSERT INTO import_runs
             (id, organization_id, site_id, import_kind, import_mode, external_source, file_name,
              mime_type, sha256, storage_key, mapping, status, error, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb, 'FAILED', $11, $12)
           RETURNING *`,
          [
            runId,
            organizationId,
            siteId,
            importKind,
            importMode,
            externalSource,
            file.originalname,
            file.mimetype,
            hash,
            storageKey,
            error.message,
            userId,
          ],
        );
        return inserted.rows[0];
      });
      res.status(422).json({
        error: { code: "IMPORT_PARSE_FAILED", message: error.message },
        import_run: toRunSummary(failed),
      });
      return;
    }
    throw error;
  }

  let mapping: FieldMapping;
  const mappingErrors: string[] = [];
  const explicitMapping = req.body.mapping;
  if (explicitMapping !== undefined && explicitMapping !== null && explicitMapping !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(explicitMapping);
    } catch {
      throw badRequest("INVALID_FIELD", "mapping must be valid JSON.");
    }
    const validated = validateExplicitMapping(parsed, tabular.headers);
    mapping = validated.mapping;
    mappingErrors.push(...validated.errors);
  } else {
    // Pack-contributed header aliases (e.g. the cannabis pack's "Strain"
    // column) are consulted after the generic core map.
    const packAliases = importHeaderAliasesForPacks(
      await getEnabledPackIds(organizationId),
    ) as Record<string, CanonicalField>;
    const auto = autoMapFields(tabular.headers, packAliases);
    mapping = auto.mapping;
    mappingErrors.push(...auto.errors);
  }
  mappingErrors.push(...validateMappingCoverage(mapping));
  if (mappingErrors.length > 0) {
    const failed = await withTenant(organizationId, async (client) => {
      if (!(await isTenantMember(client, organizationId, userId))) {
        throw forbidden(
          "USER_NOT_IN_TENANT",
          "The calling user is not a member of this organization.",
        );
      }
      const inserted = await client.query<ImportRunRow>(
        `INSERT INTO import_runs
           (id, organization_id, site_id, import_kind, import_mode, external_source, file_name,
            mime_type, sha256, storage_key, mapping, status, error, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'FAILED', $12, $13)
         RETURNING *`,
        [
          runId,
          organizationId,
          siteId,
          importKind,
          importMode,
          externalSource,
          file.originalname,
          file.mimetype,
          hash,
          storageKey,
          JSON.stringify(mapping),
          mappingErrors.join(" "),
          userId,
        ],
      );
      return inserted.rows[0];
    });
    res.status(422).json({
      error: { code: "IMPORT_MAPPING_FAILED", message: mappingErrors.join(" ") },
      import_run: toRunSummary(failed),
    });
    return;
  }

  // Store the original file first; if the database write then fails, the
  // orphaned object is removed best-effort (no row ever points at it).
  await storage.put(storageKey, file.buffer, file.mimetype);
  try {
    const result = await withTenant(organizationId, async (client) => {
      if (!(await isTenantMember(client, organizationId, userId))) {
        throw forbidden(
          "USER_NOT_IN_TENANT",
          "The calling user is not a member of this organization.",
        );
      }
      if (siteId !== null) {
        const site = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM sites WHERE id = $1 AND organization_id = $2) AS exists`,
          [siteId, organizationId],
        );
        if (!site.rows[0]?.exists) {
          throw badRequest("SITE_NOT_FOUND", "site_id does not exist in this organization.");
        }
      }
      await client.query(
        `INSERT INTO import_runs
           (id, organization_id, site_id, import_kind, import_mode, external_source, file_name,
            mime_type, sha256, storage_key, mapping, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'COMPLETED', $12)`,
        [
          runId,
          organizationId,
          siteId,
          importKind,
          importMode,
          externalSource,
          file.originalname,
          file.mimetype,
          hash,
          storageKey,
          JSON.stringify(mapping),
          userId,
        ],
      );
      const lotCache = new Map<string, { id: string; product_id: string | null } | null>();
      const locationCache = new Map<string, string | null>();
      const rejected: Record<string, unknown>[] = [];
      let accepted = 0;
      for (const row of tabular.rows) {
        const outcome = await processRow(client, {
          organizationId,
          userId,
          importKind,
          importMode,
          externalSource,
          runId,
          rowNumber: row.rowNumber,
          values: row.values,
          mapping,
          lotCache,
          locationCache,
        });
        await client.query(
          `INSERT INTO import_rows
             (import_run_id, row_number, raw_data, status, error, movement_id,
              recorded_date, lot_number, quantity_mg, quantity_units)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)`,
          [
            runId,
            row.rowNumber,
            JSON.stringify(row.values),
            outcome.status,
            outcome.error,
            outcome.movementId,
            outcome.recordedDate === null ? null : outcome.recordedDate.toISOString(),
            outcome.lotNumber,
            outcome.quantityMg,
            outcome.quantityUnits,
          ],
        );
        if (outcome.status === "ACCEPTED") {
          accepted += 1;
        } else {
          rejected.push({
            row_number: row.rowNumber,
            error: outcome.error,
            raw_data: row.values,
          });
        }
      }
      const total = tabular.rows.length;
      const status = rejected.length === 0 ? "COMPLETED" : "COMPLETED_WITH_ERRORS";
      const updated = await client.query<ImportRunRow>(
        `UPDATE import_runs SET status = $2, rows_total = $3, rows_accepted = $4,
           rows_rejected = $5 WHERE id = $1 AND organization_id = $6 RETURNING *`,
        [runId, status, total, accepted, rejected.length, organizationId],
      );
      await recordAuditEvent(client, {
        organizationId,
        actorId: userId,
        eventType: "IMPORT_COMPLETED",
        targetType: "import_run",
        targetId: runId,
        payload: {
          file_name: file.originalname,
          import_kind: importKind,
          import_mode: importMode,
          external_source: externalSource,
          rows_total: total,
          rows_accepted: accepted,
          rows_rejected: rejected.length,
          sha256: hash,
        },
        modelVersion: null,
        createdAt: new Date(),
      });
      return { run: updated.rows[0], rejected, accepted };
    });
    res.status(201).json({
      import_run: toRunSummary(result.run),
      rows_accepted: result.accepted,
      rejected_rows: result.rejected,
    });
  } catch (error) {
    await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
});

/** List import runs for this tenant, newest first. */
importsRouter.get("/", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  const { rows } = await withTenant(organizationId, async (client) =>
    client.query<ImportRunRow>(
      `SELECT * FROM import_runs WHERE organization_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [organizationId, limit, offset],
    ),
  );
  res.status(200).json({ import_runs: rows.map(toRunSummary), limit, offset });
});

/** One import run with its rows (the import log). */
importsRouter.get("/:id", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const importRunId = paramString(req.params.id, "import run id");
  if (!isUuid(importRunId)) {
    throw badRequest("INVALID_ID", "Import run id must be a UUID.");
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  const statusFilter =
    typeof req.query.status === "string" && ["ACCEPTED", "REJECTED"].includes(req.query.status)
      ? req.query.status
      : null;
  const result = await withTenant(organizationId, async (client) => {
    const run = await client.query<ImportRunRow>(
      `SELECT * FROM import_runs WHERE id = $1 AND organization_id = $2`,
      [importRunId, organizationId],
    );
    if (run.rows.length === 0) {
      throw notFound("IMPORT_RUN_NOT_FOUND", "No import run with this id in this organization.");
    }
    const params: unknown[] = [importRunId];
    let rowSql = `SELECT * FROM import_rows WHERE import_run_id = $1`;
    if (statusFilter !== null) {
      params.push(statusFilter);
      rowSql += ` AND status = $${params.length}`;
    }
    rowSql += ` ORDER BY row_number ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const rows = await client.query<ImportRowRow>(rowSql, params);
    return { run: run.rows[0], rows: rows.rows };
  });
  res.status(200).json({
    import_run: toRunSummary(result.run),
    rows: result.rows.map(toRowSummary),
    limit,
    offset,
  });
});

/** Download the stored original file for an import run. */
importsRouter.get("/:id/download", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const importRunId = paramString(req.params.id, "import run id");
  if (!isUuid(importRunId)) {
    throw badRequest("INVALID_ID", "Import run id must be a UUID.");
  }
  const found = await withTenant(organizationId, async (client) => {
    const { rows } = await client.query<{
      storage_key: string;
      file_name: string;
      mime_type: string;
    }>(
      `SELECT storage_key, file_name, mime_type FROM import_runs
       WHERE id = $1 AND organization_id = $2`,
      [importRunId, organizationId],
    );
    return rows[0] ?? null;
  });
  if (!found) {
    throw notFound("IMPORT_RUN_NOT_FOUND", "No import run with this id in this organization.");
  }
  const data = await getStorage().get(found.storage_key);
  res.setHeader("Content-Type", found.mime_type);
  res.setHeader("Content-Length", String(data.length));
  res.setHeader("Content-Disposition", `attachment; filename="${found.file_name}"`);
  res.status(200).send(data);
});
