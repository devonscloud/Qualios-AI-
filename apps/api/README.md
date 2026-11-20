# apps/api — QualiOS API

TypeScript Node.js + Express API for the cannabis inventory wedge.

## Status

**Scaffold (Days 7–12) + documents (Days 12–14).** Real: health endpoint, tenant-context middleware, document upload/version/review routes, audit-event read routes. Stub: the tenant middleware reads `x-organization-id` headers and verifies **no token** — it must be replaced by managed auth with MFA (ADR-011) before any real tenant data is served. `src/index.ts` refuses to start in production while the stub is in place.

## Routes

| Route                                                                                         | Status                                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /health`                                                                                 | Real — `{"service":"qualios-api","status":"ok"}`                     |
| `POST /api/documents` (multipart `file`)                                                      | Real — upload, file validation, version 1, audit event               |
| `POST /api/documents/:id/versions` (multipart `file`)                                         | Real — new version, previous versions kept                           |
| `GET /api/documents/review-queue`                                                             | Real — documents awaiting review                                     |
| `GET /api/documents`, `GET /api/documents/:id`                                                | Real — tenant-scoped list / detail + versions                        |
| `GET /api/documents/:id/versions/:n/download`                                                 | Real — downloads the stored original, verbatim                       |
| `POST /api/documents/:id/review` (`{decision, note?}`)                                        | Real — approve/reject; approver ≠ uploader; rejection needs a reason |
| `GET /api/audit-events`, `GET /api/audit-events/:id`                                          | Real — tenant-scoped audit trail (`?target_type&target_id` filter)   |
| `GET /api/reconciliations`, `POST /api/reconciliations`, `GET /api/reconciliations/:id`       | 501 stub — engine lands Days 14–18                                   |
| `GET /api/discrepancies`, `GET /api/discrepancies/:id`, `POST /api/discrepancies/:id/resolve` | 501 stub — workflow lands Days 18–24                                 |
| `POST /api/excise/calculate`, `GET /api/excise/rules`                                         | 501 stub — rules need expert review first (ADR, D-07)                |

All `/api/*` routes require a valid `x-organization-id` UUID header (stub mechanism). Requests without one get 401 `TENANT_CONTEXT_MISSING`.

## Documents

- **Upload limits:** max 25 MB per file (`MAX_UPLOAD_MB`); allowed types PDF, JPEG, PNG, TIFF, CSV, XLSX, TXT. The API checks the declared MIME type and extension **and** sniffs the file's first bytes (magic bytes for PDF/PNG/JPEG/TIFF/XLSX, UTF-8 check for text) — a file whose content does not match its declared type is rejected with 400.
- **Storage:** originals go to `@qualios/storage` under tenant-scoped keys (`orgs/{org}/[sites/{site}/]documents/{doc}/v{n}/{file}`). The local filesystem backend stores them under `STORAGE_LOCAL_ROOT` (default `./.storage`, gitignored). The S3 backend is not wired (ADR-005).
- **Versions:** each upload of a new version creates a new `document_versions` row and a new stored object; previous versions are never overwritten. Uploading a new version resets the document status to `UPLOADED` (it needs review again).
- **Review:** `POST /:id/review` with `decision: APPROVED | REJECTED`. APPROVED → status `VERIFIED`; REJECTED → `REJECTED` (a `note` reason is required). The approver must differ from the uploader (segregation of duties, 403 otherwise). An already-decided document returns 409 — upload a new version to re-review. Every review writes an `approvals` row (`DOCUMENT_REVIEW`) and an audit event in the same transaction.
- **Audit:** every document write records an `audit_events` row (`DOCUMENT_UPLOADED`, `DOCUMENT_VERSION_UPLOADED`, `DOCUMENT_APPROVED`, `DOCUMENT_REJECTED`) with a per-organization hash chain. Verify with `npm run audit:verify --workspace=packages/db`. Writes additionally require the calling user to have an ACTIVE membership in the organization (403 `USER_NOT_IN_TENANT` otherwise); reads are tenant-scoped by the organization header.

## Run

```bash
npm run dev      # tsx watch src/index.ts → http://localhost:3001
npm run build    # tsc → dist/
npm start        # node dist/index.js
npm test         # vitest — smoke tests + document flow integration tests
                 # (document tests need DATABASE_URL; without it they skip)
npm run typecheck
```

Document tests use the database in `DATABASE_URL` (CI: `qualios_test`) and a temp storage directory; they create a fresh organization + users per run and leave the rows in the scratch database.
