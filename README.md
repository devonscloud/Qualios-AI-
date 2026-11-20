# QualiOS AI

**Status: SCAFFOLD + DOCUMENTS + RECONCILIATION (v0.1.0, 20 November 2026). Nothing described here is a finished product. The monorepo structure, login/tenant scaffolding, database migrations, the document upload → version → review → audit flow (sprint Days 12–14), and the seed-to-sale import → movement ledger → reconciliation engine → discrepancy workflow (sprint Days 14–18) exist; OCR, the AI assistant, and the excise engine are not built yet.**

QualiOS AI is an AI-assisted operating system for regulated manufacturing and quality-intensive businesses — quality management, production, compliance, training, auditing, document control, traceability, excise/tax administration, reporting, and a grounded AI assistant in one connected system.

The first industry pack is **Canadian cannabis**, and the first wedge is **inventory/batch reconciliation + excise**, dogfooded on Herba Farms Ltd. before it is sold to any other licensed producer.

> **Name note:** "QualiOS" is one letter off Qualio, an existing funded compliance company in the same conceptual space. Trademark clearance is required before any public use of the name. See the planning docs.

## Planning documents

The product plan lives outside this repo for now (goal workspace):

- `QualiOS-PRD-Cannabis-Inventory-Wedge.md` — product requirements for the wedge
- `QualiOS-Architecture-Decision-Record.md` — 13 ADRs (stack, tenancy, guardrails)
- `QualiOS-Data-Model.md` — wedge entities and state machines
- `QualiOS-Threat-Model.md` — 12 threats, NIST AI RMF / OWASP LLM mappings
- `QualiOS-Issue-Backlog.md` — P0/P1/P2 backlog
- `QualiOS-30-Day-Sprint-Plan.md` — the 30-day sprint this scaffold is part of

Architecture decisions (from the ADR):

- **Frontend:** Next.js / React, responsive, Android-first mobile upload
- **Backend:** TypeScript Node.js API, modular services, strict tenant-aware authorization
- **Database:** PostgreSQL, `organization_id` on every tenant record, row-level security
- **Object storage:** private S3-compatible buckets for originals (not configured yet)
- **AI:** provider abstraction — no hard vendor dependency (not wired yet)
- **Auth:** managed provider with MFA (not selected yet — see ADR-011)
- **Invariant (ADR-012):** no autonomous regulated actions. AI assists, drafts, and recommends; a human approves every regulated release, signature, filing, or correction.

## Repo layout (blueprint §14)

```
apps/web                      Next.js app — login + tenant/site selection (UI only), document upload + review queue + document detail, reconciliation runs (list / new / detail)
apps/api                      TypeScript Node.js API — health + tenant middleware + document/audit routes (real) + import, reconciliation, and discrepancy routes (real) + excise route stub
workers/document-processing   Async job worker (STUB — OCR/AI review land here later)
packages/db                   PostgreSQL migrations (plain SQL) + seed data + migrate runner + audit-event hash chain
packages/storage              Object storage abstraction (S3-shaped interface; local filesystem backend real, S3 not wired)
packages/auth                 Tenant context, roles, permissions (STUB — provider not selected)
packages/ui                   Shared React components (STUB — one Button so far)
packages/workflows            Workflow engine types (STUB)
packages/rules                Versioned rule types, e.g. excise rules (STUB)
packages/ai                   AI provider abstraction (STUB — provider not selected)
packages/industry-packs       Industry packs; cannabis/ is the first (STUB)
packages/integrations         External system connectors (STUB — file import is the wedge path)
docs/product                  Product docs index
docs/architecture             Architecture docs index
docs/compliance               Compliance notes index
tests/e2e                     End-to-end tests (placeholder — needs a running stack)
infra                         Local dev infrastructure (docker-compose for Postgres)
```

Anything marked STUB is a placeholder with a README saying so. Nothing is presented as built when it is not.

## Run locally

Prerequisites: Node.js 20+, npm 10+, PostgreSQL 16 (or `docker compose up db` — see `infra/`).

```bash
# 1. Install (npm workspaces). The prepare scripts build packages/db and
#    packages/storage dist/ so apps/api can import them; run `npm run build`
#    again after changing any workspace package source.
npm install

# 2. Configure environment
cp .env.example .env
# edit DATABASE_URL etc. — never commit a real .env

# 3. Start Postgres (Docker) and apply migrations
docker compose -f infra/docker-compose.yml up -d db
npm run db:migrate

# 4. Run the API (http://localhost:3001) and web app (http://localhost:3000)
npm run dev:api
npm run dev:web
```

## Verify

```bash
npm run lint        # ESLint across the monorepo
npm run typecheck   # TypeScript across all workspaces
npm test            # Vitest — API smoke tests + document flow + import/reconciliation integration tests
                    # (DB-backed tests need DATABASE_URL; without it they skip)
npm run validate --workspace=packages/db   # static migration checks
npm run audit:verify --workspace=packages/db   # recompute the audit hash chain (DATABASE_URL required)
npm run build:api   # Compile apps/api
npm run build:web   # Next.js production build of apps/web
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, migration apply against a real PostgreSQL service, and the API build on every push/PR to `main`.

## What is real vs stub (Days 7–12 scope, plus Days 12–14 documents, plus Days 14–18 reconciliation)

| Area                                                       | State                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Monorepo layout, workspaces, lint/test/CI                  | Real                                                                                                                      |
| `apps/web` login + tenant/site selection pages             | Real UI, no backend wiring                                                                                                |
| `apps/web` document upload, review queue, document detail  | Real — calls the API (demo tenant/user headers)                                                                           |
| `apps/web` reconciliation runs (list / new / detail)       | Real — calls the API (demo tenant/user headers); new-run page uploads + runs                                              |
| `apps/api` health endpoint, tenant middleware, route stubs | Real (middleware is a STUB: no token verification yet)                                                                    |
| `apps/api` document routes (upload, versions, review)      | Real — multipart upload, file validation, tenant-scoped queries, audit events                                             |
| `apps/api` audit-event read routes                         | Real — list + single event, tenant-scoped                                                                                 |
| `apps/api` import routes (CSV/XLSX, mapping, row log)      | Real — SNAPSHOT vs LEDGER modes, rejected rows recorded, never silently dropped                                           |
| `apps/api` reconciliation engine v0                        | Real — scope LOT/PRODUCT/SITE/DATE_RANGE; PHANTOM_STOCK, SHORTAGE, LOT_MISMATCH, UNALLOCATED_PRODUCTION, BULK_VS_PACKAGED |
| `apps/api` discrepancy workflow                            | Real — propose (note) → approve by a second person (RESOLVED or EXPLAINED); no auto-resolution                            |
| `packages/db` migrations for all wedge entities            | Real SQL, applied + verified against PostgreSQL (9 migrations, incl. 0009 imports)                                        |
| `packages/db` audit hash chain + verify command            | Real — append-only triggers, per-org hash chain, `npm run audit:verify`                                                   |
| `packages/db` seed data                                    | Real — synthetic demo tenant only (now two demo users: Ops uploader + QA approver)                                        |
| `packages/storage` local filesystem backend                | Real — tenant-scoped keys, dev only (documents + import files)                                                            |
| `packages/storage` S3 backend                              | Not wired — factory throws (ADR-005)                                                                                      |
| Auth provider, MFA, RBAC enforcement                       | STUB — provider not selected (ADR-011)                                                                                    |
| OCR, AI assistant, excise engine, billing, listings        | Not built — later sprint steps                                                                                            |

**Honest limits to know about:**

- The local dev database role (`qualios`) is a superuser and owns the tables, so PostgreSQL row-level security does not apply to the API's own connections in local dev. Application-layer scoping (every query filters by `organization_id`) is the enforcement that bites locally; production must use a non-superuser, non-owner app role for RLS to hold. See `packages/db/README.md`.
- The tenant middleware is header-based with no token verification. Reads are tenant-scoped by the organization header; writes additionally require an ACTIVE membership for the user id in the header. Real identity comes with the managed auth provider (ADR-011).

## Contributing

- Do not commit secrets. Use `.env` (gitignored); `.env.example` documents the variables.
- Do not claim unbuilt modules are complete.
- Do not delete code, spend money, change production infrastructure, or send external communications without explicit approval.
- Ask for missing regulatory/product decisions instead of inventing them (see blueprint §18).
