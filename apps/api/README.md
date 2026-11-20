# apps/api — QualiOS API

TypeScript Node.js + Express API for the cannabis inventory wedge.

## Status

**Scaffold (Days 7–12) + documents (Days 12–14) + imports/reconciliation (Days 14–18).** Real: health endpoint, tenant-context middleware, document upload/version/review routes, audit-event read routes, seed-to-sale file import routes, reconciliation engine routes, discrepancy workflow routes. Stub: the tenant middleware reads `x-organization-id` headers and verifies **no token** — it must be replaced by managed auth with MFA (ADR-011) before any real tenant data is served. `src/index.ts` refuses to start in production while the stub is in place.

## Routes

| Route                                                                                                                                                                | Status                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /health`                                                                                                                                                        | Real — `{"service":"qualios-api","status":"ok"}`                                           |
| `POST /api/documents` (multipart `file`)                                                                                                                             | Real — upload, file validation, version 1, audit event                                     |
| `POST /api/documents/:id/versions` (multipart `file`)                                                                                                                | Real — new version, previous versions kept                                                 |
| `GET /api/documents/review-queue`                                                                                                                                    | Real — documents awaiting review                                                           |
| `GET /api/documents`, `GET /api/documents/:id`                                                                                                                       | Real — tenant-scoped list / detail + versions                                              |
| `GET /api/documents/:id/versions/:n/download`                                                                                                                        | Real — downloads the stored original, verbatim                                             |
| `POST /api/documents/:id/review` (`{decision, note?}`)                                                                                                               | Real — approve/reject; approver ≠ uploader; rejection needs a reason                       |
| `GET /api/audit-events`, `GET /api/audit-events/:id`                                                                                                                 | Real — tenant-scoped audit trail (`?target_type&target_id` filter)                         |
| `POST /api/imports` (multipart `file`), `GET /api/imports`, `GET /api/imports/:id`, `GET /api/imports/:id/download`                                                  | Real — CSV/XLSX import, field mapping, per-row accept/reject log, original stored verbatim |
| `GET /api/reconciliations`, `POST /api/reconciliations`, `GET /api/reconciliations/:id`, `POST /api/reconciliations/:id/run`                                         | Real — create DRAFT (scope validated), execute engine → REVIEW, lines + discrepancies      |
| `GET /api/discrepancies`, `GET /api/discrepancies/:id`, `PATCH /api/discrepancies/:id`, `POST /api/discrepancies/:id/resolve`, `POST /api/discrepancies/:id/approve` | Real — two-person workflow; proposer cannot approve; RESOLVED or EXPLAINED                 |
| `POST /api/excise/calculate`, `GET /api/excise/rules`                                                                                                                | 501 stub — rules need expert review first (ADR, D-07)                                      |

All `/api/*` routes require a valid `x-organization-id` UUID header (stub mechanism). Requests without one get 401 `TENANT_CONTEXT_MISSING`.

## Documents

- **Upload limits:** max 25 MB per file (`MAX_UPLOAD_MB`); allowed types PDF, JPEG, PNG, TIFF, CSV, XLSX, TXT. The API checks the declared MIME type and extension **and** sniffs the file's first bytes (magic bytes for PDF/PNG/JPEG/TIFF/XLSX, UTF-8 check for text) — a file whose content does not match its declared type is rejected with 400.
- **Storage:** originals go to `@qualios/storage` under tenant-scoped keys (`orgs/{org}/[sites/{site}/]documents/{doc}/v{n}/{file}`). The local filesystem backend stores them under `STORAGE_LOCAL_ROOT` (default `./.storage`, gitignored). The S3 backend is not wired (ADR-005).
- **Versions:** each upload of a new version creates a new `document_versions` row and a new stored object; previous versions are never overwritten. Uploading a new version resets the document status to `UPLOADED` (it needs review again).
- **Review:** `POST /:id/review` with `decision: APPROVED | REJECTED`. APPROVED → status `VERIFIED`; REJECTED → `REJECTED` (a `note` reason is required). The approver must differ from the uploader (segregation of duties, 403 otherwise). An already-decided document returns 409 — upload a new version to re-review. Every review writes an `approvals` row (`DOCUMENT_REVIEW`) and an audit event in the same transaction.
- **Audit:** every document write records an `audit_events` row (`DOCUMENT_UPLOADED`, `DOCUMENT_VERSION_UPLOADED`, `DOCUMENT_APPROVED`, `DOCUMENT_REJECTED`) with a per-organization hash chain. Verify with `npm run audit:verify --workspace=packages/db`. Writes additionally require the calling user to have an ACTIVE membership in the organization (403 `USER_NOT_IN_TENANT` otherwise); reads are tenant-scoped by the organization header.

## Imports & reconciliation (Days 14–18)

- **Import:** `POST /api/imports` accepts a CSV or XLSX file (max 25 MB) with `import_kind` (`SEED_TO_SALE` | `ALLOCATION` | `PAPER_COUNT`) and `import_mode` (`SNAPSHOT` | `LEDGER`). Columns map automatically by header name (aliases included — e.g. `Lot No` → `lot_number`, `Qty (kg)` → `quantity_kg`) or from an explicit JSON `mapping`. Quantities convert to integer milligrams/units exactly — never via floats. Every row is stored (`import_rows`, with the raw row kept for audit) as ACCEPTED or REJECTED with a reason; a bad row never disappears. A file with no mappable columns is rejected at the file level (422) and a FAILED run is recorded.
- **Modes:** SNAPSHOT stores the file as an external record set — no movements are written, because writing the external system's numbers into the ledger would erase the variance a reconciliation is meant to find. LEDGER writes one `inventory_movements` row per accepted row (PACKAGE is rejected in v0; ADJUST takes signed quantities); positions are still derived, never edited directly.
- **Engine:** `POST /api/reconciliations` creates a DRAFT run for a scope (LOT by lot number, PRODUCT by UUID, SITE by UUID or `ALL`, DATE_RANGE `YYYY-MM-DD..YYYY-MM-DD`) against an `external_import_run_id`; the scope is validated at creation. `POST /:id/run` executes once (a second execution returns 400) and lands the run in REVIEW. Each line compares ledger vs external (mg and units, allocated vs produced); discrepancies carry both sides' values in `evidence` and start OPEN. Types: PHANTOM_STOCK, SHORTAGE, LOT_MISMATCH (from rejected import rows for unknown lots), UNALLOCATED_PRODUCTION, BULK_VS_PACKAGED. No auto-resolution.
- **Discrepancies:** `POST /:id/resolve` proposes a resolution (a note is required); `POST /:id/approve` approves it as RESOLVED or EXPLAINED (`outcome`), by a second person — the proposer gets 403 `SEGREGATION_OF_DUTIES`. The approval is an `approvals` row (`DISCREPANCY_RESOLUTION`) plus an audit event, in one transaction. Direct PATCH to RESOLVED/EXPLAINED is refused (400 `USE_APPROVE_ENDPOINT`).
- **Five-case tests:** `src/reconciliation.test.ts` replays the PRD's five Herba cases with synthetic data (Q-051): Toad Venom phantom 1.338 kg → PHANTOM_STOCK HIGH; Sangria phantom 0.348 kg → PHANTOM_STOCK MEDIUM; ceramic tip shortages (192/244/70) + bulk-vs-packaged; Jixy unallocated 400 packs/flavour (1,600 total); SK/MB excise → asserted NOT built (501, no calculation). Unit tests for the CSV/XLSX parser, exact decimal conversion, and field mapping live in `src/lib/tabular.test.ts`.

## Run

```bash
npm run dev      # tsx watch src/index.ts → http://localhost:3001
npm run build    # tsc → dist/
npm start        # node dist/index.js
npm test         # vitest — smoke tests + document flow + import/reconciliation integration tests
                 # (DB-backed tests need DATABASE_URL; without it they skip)
npm run typecheck
```

Document tests use the database in `DATABASE_URL` (CI: `qualios_test`) and a temp storage directory; they create a fresh organization + users per run and leave the rows in the scratch database. The reconciliation tests do the same, in a separate scratch organization per run.
