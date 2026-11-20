# QualiOS AI — Architecture

**Version:** 1.0 (new plan) — 20 November 2026
**Status:** Planning only. Describes the target architecture and what exists today; nothing here is built unless the Current-State Audit says it is.
**Governing plan:** Complete Master Blueprint v1.0, 20 November 2026 (§7).
**Decisions:** the 13 ADRs live in `docs/architecture/DECISIONS.md`. This document is the architecture narrative; DECISIONS.md is the record.

## 1. Shape: modular monolith first

Start with a **modular monolith with well-defined module boundaries** (blueprint §7, ADR-001). Split services only when scaling or compliance demands it. The current repo already has this shape:

```
apps/
  api/        Express + TypeScript API (routes, lib, middleware)
  web/        Next.js web app (public site + web app, one codebase for now)
packages/
  auth/       identity types + token verification (STUB — throws)
  ai/         AI gateway abstraction (STUB — throws)
  db/         PostgreSQL access, migrations 0001–0009, audit chain, seeds
  storage/    object storage abstraction (local backend real; S3 throws)
  rules/      versioned rule types (excise; types only, computes nothing)
  workflows/  state-machine types (types only; engine not built)
  integrations/ file-import types (STUB — throws)
  industry-packs/ industry-pack descriptors (cannabis-ca STUB only)
  ui/         shared UI package
workers/
  document-processing/ async job worker (STUB — throws; no queue configured)
infra/
  docker-compose.yml  local PostgreSQL 16 (dev only)
tests/e2e/    (README only)
```

Module boundaries are enforced by package: a package may only be used through its exported interface. The AI provider, the auth provider, and the storage backend are all swappable behind abstractions (ADR-005, ADR-007, ADR-011) — no product code may call a vendor SDK directly.

## 1A. Industry neutrality: the core knows no industry (hard constraint, 20 Nov 2026)

The core is industry-neutral. Generic SOPs, generic training, generic workflows, generic inventory, generic documents. **No cannabis-specific logic in the core** — no cannabis-named entities, no cannabis-only assumptions in the data model, no hard-coded regulations as universally applicable.

Industry packs (blueprint §5: food/beverage/meat/agriculture, pharma/medical devices, cannabis/alcohol/tobacco, industrial fabrication/welding/construction, cosmetics/chemicals/automotive/aerospace/warehousing/logistics) are **configurable rule sets, templates, and workflows on the shared core** — not separate products. A pack contributes, through configuration and pack-scoped tables, without changing core code:

- taxonomy values (e.g. product categories, document types, lot states),
- rule bases (e.g. tax/excise bases — per-mg-THC is the cannabis pack's basis, not the core's),
- templates (SOP templates, forms, checklists, listing formats),
- workflows and validations (e.g. seed-to-sale import mappings, quarantine/release rules),
- regulatory mappings with dated source references.

**Current violations (audit §6A):** the core `products` table carries a cannabis category enum, a strain-type enum, and THC columns; the core `excise_basis` enum has only `PER_MG_THC`; the core `listing_type` enum is Saskatchewan/Manitoba cannabis distributor forms; `import_kind`/`source_system` name seed-to-sale in the core; and there is no pack mechanism at all — only a stub cannabis descriptor. The remediation (backlog B-110) moves these into pack-scoped configuration and extracts the generic patterns (ledger-vs-snapshot reconciliation, versioned rule engine, generic listing records) into the core. **Rule from now on: no new industry-specific enum, column, or route concept in shared code — new industry behaviour goes behind the pack mechanism.**

The cannabis reconciliation engine already built is the cannabis pack's Phase 4 work: its generic pattern (movement ledger, external-snapshot comparison, discrepancy lifecycle) belongs in the core; its seed-to-sale specifics belong in the pack.

## 2. Suggested stack (blueprint §7 — validate against team skills and cost)

| Layer             | Choice                                               | Status                                                                               |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Web               | Next.js / TypeScript / React                         | Implemented (scaffold)                                                               |
| Mobile            | React Native / Expo                                  | **Missing** — OPEN DECISION: mobile stack confirmation                               |
| API               | TypeScript Node.js (Express 5)                       | Implemented                                                                          |
| Database          | PostgreSQL 16                                        | Implemented (local dev; no staging/prod)                                             |
| Identity          | Managed provider with MFA                            | **Missing** — OPEN DECISION: provider selection                                      |
| Object storage    | Encrypted S3-compatible storage                      | Local filesystem backend only; S3 not wired                                          |
| Queue / event bus | Queue + workers for OCR, AI review, imports, reports | **Missing** — worker stub throws; no queue configured                                |
| Deployment        | Managed cloud                                        | **Missing** — OPEN DECISION: hosting; Replit is prototype-only (ADR-009, to confirm) |
| Billing           | Provider TBD                                         | **Missing** — OPEN DECISION: billing provider                                        |

## 3. Tenancy and isolation (defence in depth, ADR-008)

Three layers, all required; no layer is optional:

1. **Application layer (implemented, partially).** Every API route requires tenant context (`apps/api/src/middleware/tenant.ts` — currently a header stub, to be replaced by token verification). Every query includes `organization_id = $orgId` explicitly. Tenant ids are never accepted from request bodies or query strings. `isTenantMember()` gates writes on ACTIVE membership.
2. **Database layer (implemented, with a deployment trap).** RLS is enabled on every tenant table with policies on `app.current_organization_id`, set per transaction by `withTenant()` (`apps/api/src/lib/db.ts`). **Trap:** locally the API connects as the superuser/owner role, so PostgreSQL does not apply RLS to it. Production must connect as a non-owner app role with `FORCE RLS` on tenant tables, or layer 2 silently does nothing.
3. **Service layer (designed, not built).** AI retrieval, search, exports, and webhooks must all be tenant-scoped at the service layer, with automated authorization tests. This is the layer that will matter most for the assistant (blueprint §3 safety: prevent cross-tenant retrieval).

Additional rules: least privilege; scoped service accounts; storage keys are tenant-scoped and validated (`orgs/{orgId}/…`, `packages/storage/src/index.ts`); secrets in a secrets manager, never in code.

## 4. Core services (target)

- **Document / version service** — upload, immutable versions, review/approval, effective dates, distribution, acknowledgements, archival, retention. _Generic upload/version/review implemented; SOP semantics missing._
- **Workflow engine** — state machines with enforced transitions and audit events on every transition. _Types only (`packages/workflows`); the enforcing engine was never built. `canTransition` is a pure helper nothing calls._
- **Notifications** — email/in-app, digests, quiet hours, escalation, human handoff. _Missing._
- **Search / retrieval** — tenant-scoped indexing for RAG, with citations, freshness controls, and evaluation sets. _Missing._
- **AI orchestration** — gateway with tool allowlists, permission-scoped functions, confirmation for high-impact actions, idempotency, action logs, rollback where feasible, rate limits. _Gateway stub only._
- **Integration gateway** — public APIs, webhooks (signed, retry queues, duplicate protection), connectors, import validation, rate limits. _Designed (ADR-013); file import only._
- **Billing / entitlements** — plans, seats, AI usage metering, invoices, taxes, payment failure handling. _Missing._
- **Observability** — structured logs, metrics, tracing, cost tracking, health/status. _Missing beyond a `/health` liveness endpoint._

## 5. Data

PostgreSQL is the system of record (ADR-004). Conventions (see `docs/architecture/DATA_MODEL.md`):

- Every tenant table carries `organization_id`; every row carries `created_at`/`updated_at` (DB-maintained trigger) and soft-delete `deleted_at` where applicable.
- Money is integer cents; quantities that must not lose precision are integers (mg, cents) — never floats.
- Rules (tax, excise, etc.) are versioned configuration rows, never hard-coded; a rule must be reviewed by a domain expert before use. Rule bases are registered by industry packs; the core rule engine knows no specific tax.
- Core entities are industry-neutral: no industry-specific columns or enums in shared tables. Pack-specific attributes live in pack-scoped tables or configurable taxonomies (see §1A and audit §6A).
- Positions are derived from the movement ledger, never edited directly.
- Audit events are append-only, hash-chained per organization, with a per-table sequence; UPDATE/DELETE blocked by triggers.
- Migrations are numbered, transactional, and validated (`packages/db/scripts/validate-migrations.mjs`); CI applies them to a real Postgres.

## 6. AI architecture (blueprint §3, §7)

- All AI access goes through `@qualios/ai` (ADR-007). No provider is selected; no model is called today.
- Retrieval-augmented generation with **tenant-scoped indexing**, citations to exact records and versions, freshness controls, evaluation sets. No default training on customer data.
- The assistant operates inside the user's permissions and subscription entitlements, through controlled retrieval — not uncontrolled permanent memory. Memory/preferences are user-controlled, with retention limits, correction, and deletion.
- Guardrails (ADR-012): AI assists, detects, drafts, recommends. It never posts a correction, files anything, releases a batch, or signs on a person's behalf. Every grounded answer carries citations or states evidence is insufficient. Prompt injection in uploaded records must be resisted; cross-tenant retrieval prevented; unauthorized access blocked; signatures, approvals, and test results never fabricated.
- Every AI suggestion, its evidence, model/version, human review, action taken, and exception is logged (`ai_interactions` table exists; nothing writes to it yet).

## 7. Security and compliance posture (see `docs/compliance/SECURITY.md`)

- Encryption in transit and at rest; secrets management; backups and restore drills; disaster-recovery targets; incident response; security monitoring.
- Threat modeling (12 threats, T-01–T-12, carried forward from the old threat model), penetration testing, vulnerability management, access reviews, audit logs, customer security documentation.
- Regulated electronic records/signatures: assess applicable requirements by jurisdiction and use case (e.g. 21 CFR Part 11 where relevant); validation evidence is required before any claim.
- Avoid unverified claims such as "certified", "fully compliant", or "automatically approves batch release".

## 8. Delivery

- **CI/CD:** GitHub Actions (`.github/workflows/ci.yml`) — install, lint, typecheck, test against a Postgres service, apply migrations, verify the audit chain, build the API. Runs on push/PR to `main`.
- **Environments:** local dev (docker-compose Postgres) exists. Staging and production do not. No deployment pipeline, no rollback plan, no feature-flag system yet.
- **Release gates (blueprint §11):** every phase requires working functionality, automated tests, security review, user acceptance criteria, documentation, and a release decision. No phase is "complete" because UI screens merely exist.
- **Current guardrail:** `apps/api/src/index.ts` refuses to start in production while the tenant middleware is a header stub. That refusal stays until real auth is wired.

## 9. What changes first (Phase 1)

1. Select the managed auth provider (OPEN DECISION) and replace the header stub with real token verification; keep the production-start refusal until then.
2. Add registration + tenant creation, invites, and role/permission enforcement on every route.
3. Select the billing provider (OPEN DECISION) and add a billing sandbox.
4. Select hosting (OPEN DECISION) and stand up staging; production stays blocked until auth, billing sandbox, and tenant-isolation tests pass.
5. Fix the test gap found in the audit: gate the two DB-dependent smoke tests in `src/index.test.ts` on database availability like the other suites, so a run without Postgres is honestly green-or-skipped rather than red.
6. Start the core-neutrality remediation (backlog B-110): move cannabis-specific enums/columns out of shared tables into pack-scoped configuration; no new industry-specific concepts in core code.
