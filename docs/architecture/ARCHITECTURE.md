# QualiOS AI — Architecture

**Version:** 1.1 (directive revision) — 20 November 2026
**Status:** Planning only. Describes the target architecture and what exists today; nothing here is built unless the Current-State Audit says it is.
**Governing plan:** Complete Master Blueprint v1.0, 20 November 2026 (§7), as corrected and expanded by the ChatGPT "Master Product Correction & Build Directive" (20 Nov 2026). Directive §9 deliverable (b): architecture diagram, universal entity-relationship model, event flows, and API contracts — including traceability, accounting, and tax ledgers. This revision adds §10–§12 (the integrated domain model and contract sketches, directive P0 gate). No new feature code was written in this revision, so the P0 gate is met in planning; it must be re-checked before any P1 prototype code lands.
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

### 6A. Personal assistant design (directive §5, §9 deliverable (d) — design detail)

The assistant is a core cross-platform feature: one role-aware assistant per authorized user, on web and mobile, with an optional daily briefing. **Nothing in this section is built** — the gateway throws and there is no retrieval, no tool, and no evaluation set.

- **Tools (allowlisted, permission-scoped).** Read tools: `search_documents` (tenant-scoped, cited), `find_lot` (genealogy + status), `production_status`, `inventory_position`, `training_status`, `financial_summary` (from posted ledger data only), `tax_deadlines` (from the obligation register). Draft tools: `draft_capa`, `draft_email`, `draft_report`, `assemble_audit_pack`, `prepare_meeting_notes`. Propose tools: `propose_task`, `propose_inspection`, `propose_adjustment` (a proposal is a draft record awaiting a human, never a posted change). Execute tools (gated): `create_task`, `schedule_inspection`, `route_approval` — and only with explicit human confirmation for anything consequential. There is deliberately **no** execute tool for: posting a correction, filing anything, releasing a batch, or signing on a person's behalf. Tool calls are idempotent (idempotency keys), rate-limited, and logged with their inputs, outputs, and the human decision.
- **Permissions.** Four tiers, separately grantable per role: **read** (search and answer), **draft** (create drafts the user can edit), **propose** (create records that need approval), **execute** (run a gated tool, with confirmation for consequential actions). The assistant's permissions are the intersection of the user's permissions, the role's permissions, and the plan's entitlements — never more. A tool call that exceeds the caller's permissions fails closed and is logged.
- **Retrieval.** Tenant-scoped indexing only; access controls are enforced **before** retrieval (the index is filtered by tenant, then by the caller's record-level permissions), never after generation. Retrieval returns exact records and document versions with freshness metadata; the answer cites them or states evidence is insufficient. No default training on customer data. Prompt injection in uploaded records is treated as data, never instructions: retrieved content cannot issue tool calls, change the assistant's instructions, or exfiltrate data (tests: malicious instructions embedded in a document must not change behaviour — SECURITY T-03).
- **Approval gates.** Financial transactions, regulated releases, electronic signatures, filings, and any other consequential action require explicit approval by an authorized human, recorded as an `approvals` row + audit event. The assistant routes the approval request; it does not approve its own work. Separation of duties applies (approver ≠ requester where the workflow requires it).
- **Citations.** Every grounded answer carries citations to exact records and document versions (record id, version, section/field where available) plus confidence and unknowns. An answer without a verifiable source says so explicitly. Fabricated signatures, approvals, or test results are never produced; compliance is never claimed without verified sources.
- **Memory.** User-controlled preferences, scoped task context, and optional organizational knowledge; retention limits, correction, and deletion controls, with visibility rules (a user's memory is never visible to another tenant, and personal memory is not shared across users unless the user opts in). No uncontrolled permanent memory.
- **Privacy.** Purpose limitation, data minimization, regional residency options (see DECISIONS OD-9), DPA/subprocessor transparency before any provider is used; no customer data goes to an AI provider until provider selection (OD-4), DPA, and residency review are complete.
- **Evaluations.** Before the assistant is shown to any customer: a grounded-QA evaluation set (cited answers, insufficient-evidence cases), a hallucination test set, a tool-misuse test set (excess-permission calls, consequential actions without approval), a prompt-injection test set, and a document-extraction accuracy set — all with pass thresholds recorded in the backlog (B-301/B-302) and re-run per release. Model/version, cost, and latency budgets are tracked per tenant.

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

## 10. Universal entity-relationship model (directive P0 — integrated domain model)

One model for every industry. The core entities are industry-neutral; industry behaviour is pack configuration and pack-scoped extension tables (see DATA_MODEL §10). Field-level detail lives in `docs/architecture/DATA_MODEL.md` (§12 for the new finance/tax/CRM/traceability entities); this section is the relationship map and the rules that bind the modules together.

```
                          ┌──────────────────┐
                          │  organizations   │ 1 tenant = 1 company workspace
                          │  (tenant root)   │
                          └────────┬─────────┘
        ┌────────────┬─────────────┼──────────────┬──────────────┬─────────────┐
        ▼            ▼             ▼              ▼              ▼             ▼
   ┌────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐
   │ users  │  │  sites   │  │ products  │  │documents │  │ customers │  │ chart of│
   │(via    │  │(facil-   │  │ lots      │  │ versions  │  │ contacts  │  │ accounts│
   │ member-│  │ ities)   │  │ batches   │  │ approvals │  │ oppor-    │  │(GL)     │
   │ ships) │  └────┬─────┘  └─────┬─────┘  └─────┬─────┘  │ tunities  │  └────┬────┘
   └───┬────┘       │              │              │        │ sales     │       │
       │            │         ┌────┴─────┐        │        │ orders    │  ┌────┴──────────┐
       │            │         ▼          ▼        │        │ contracts │  ▼               ▼
       │            │  ┌──────────┐ ┌────────┐   │        └─────┬─────┘ journal_    journal_
       │            │  │inventory_│ │batch_  │   │              │         entries     lines
       │            │  │movements │ │inputs  │   │              ▼               (balanced,
       │            │  │(ledger)  │ │(genea- │   │        ┌──────────┐  enforced)
       │            │  └────┬─────┘ │ logy)  │   │        │shipments │
       │            │       │       └────────┘   │        │(linked to│
       │            │       ▼                    │        │ lots)    │
       │            │  ┌──────────┐              │        └────┬─────┘
       │            │  │reconcil- │              │             │
       │            │  │iations → │              │        ┌────┴──────────┐
       │            │  │discrep-  │              │        ▼               ▼
       │            │  │ancies    │              │  tax_rules      tax_calculations
       │            │  └──────────┘              │  (versioned)    filings (prep only)
       │            │                            │  (pack-registered bases)
       │            ▼                            ▼
       │   ┌────────────────┐            ┌──────────────────┐
       │   │ training_      │            │  traceability_   │
       │   │ assignments →  │            │  events (one     │
       │   │ completions    │            │  linked event    │
       │   └────────────────┘            │  stream over     │
       │                                 │  lots/batches/   │
       │   ┌────────────────┐            │  movements/      │
       └──►│ audit_events   │◄───────────│  documents/      │
           │ (hash-chained, │   every    │  ledger entries) │
           │ append-only)   │   critical │                  │
           └────────────────┘   write    └──────────────────┘
           ┌────────────────┐
           │ ai_interactions│  (assistant calls: prompt/answer refs,
           │ + assistant    │   citations, model version, tool actions)
           │ tool action log│
           └────────────────┘
```

**Binding rules (the integration contract):**

1. **One tenant root.** Every tenant row carries `organization_id`; RLS + application scoping + service-layer scoping (ADR-008) apply to every entity in this diagram, including the GL, tax, CRM, and traceability tables. No module has its own tenant concept.
2. **Shared IDs, event-driven links.** A lot, batch, document, sales order, shipment, journal entry, and tax calculation that refer to the same real-world thing carry the same IDs and are linked by `traceability_events` (one append-only event stream: `event_type`, `entity refs`, `actor`, `payload`, `occurred_at`), not by duplicating data between modules. No duplicate entry across modules (directive §3).
3. **Positions and balances are derived, never edited.** Inventory positions derive from `inventory_movements`; GL balances derive from `journal_lines`; tax positions derive from `tax_calculations`. Nothing writes a balance directly.
4. **Ledgers are append-only with controlled correction.** Posted journal entries are immutable; corrections are reversing/adjusting entries. Tax calculations are working papers (`DRAFT`/`FINAL`); finalization needs a human approval event. Audit events are hash-chained and append-only (migration 0008).
5. **Rules are versioned configuration.** Tax/excise rules, pack rules, and FX rates carry `effective_from/to` and `DRAFT/ACTIVE/SUPERSEDED` status; a rule must be reviewed by a domain expert before use. Packs register rule bases; the core never names a tax basis.
6. **Packs extend, never fork.** Pack attributes live in pack-scoped tables keyed to core rows; pack taxonomy values, templates, and workflows are configuration loaded per tenant by enabled pack/entitlement. Core queries never join pack tables unless the tenant has that pack enabled.

## 11. Event flows (directive §3 lifecycle; §8 P1 prototypes)

**Flow A — Traceability proof of concept (P1, backlog B-710).** `RECEIVE lot (supplier, qty, UoM)` → event `lot.received` → `CONSUME lot into batch` (event `batch.input_consumed`, `batch_inputs` row) → `PRODUCE finished goods` (event `batch.produced`, `PRODUCE` movement) → `SHIP finished lot` (event `lot.shipped`, `SHIP` movement + shipment linked to sales order + customer) → `TRACE backward` (finished lot → batch → input lots → suppliers + tests) and `TRACE forward` (input lot → finished lots → shipments → customers). Each step writes an `audit_event` in the same transaction as the state change. The POC connects to reconciliation by running a reconciliation over the same lots and showing zero unexplained variance.

**Flow B — Finance posting prototype (P1, backlog B-702).** `Supplier receipt (goods received)` → `inventory valuation` (receipt valued at PO cost, `journal_lines`: Dr Inventory / Cr Accrued AP) → `supplier invoice` (Dr Accrued AP / Cr AP, invoice linked to receipt) → `production consumption` (Dr WIP/COGS / Cr Inventory, cost follows the lot) → `sales invoice` (Dr AR / Cr Revenue; Dr COGS / Cr Finished goods). Every posting is one balanced `journal_entry` with an idempotency key; a retried post with the same key returns the original entry and books nothing twice. Posting is transactional with the underlying operational event (receipt, consumption, shipment) — the ledger and the operation cannot diverge.

**Flow C — SOP → training → audit trail (built, first milestone).** Upload → version → review/approve (segregation of duties) → publish effective version → assign training on the effective version → complete (acknowledgement + score) → manager verify → dated CSV audit-trail export. Proven by 13 integration tests at `e5922d8`.

**Flow D — Tax working paper (P2, backlog B-706).** `Taxable event` (sale, production, receipt — each already an event in Flow A/B) → `tax_calculations` row computed from the active versioned rule for the jurisdiction + pack basis → `DRAFT` working paper → human review + approval event → `FINAL` working paper → filing package assembled (evidence mapped) → **a human files it outside QualiOS**. QualiOS never files. A rule change creates a new rule version; calculations record which rule version was used.

**Flow E — Assistant read-only answer (P1, backlog B-301).** User question → permission check (caller role + entitlements) → tenant-scoped retrieval over that tenant's documents/records only → grounded answer with citations to exact document versions (or "evidence insufficient") → `ai_interactions` log row (prompt/answer refs, citations, model version). No write tool is callable in the read-only phase. Action tools (B-306) arrive later behind the approval gates in §6.

## 12. API contracts (versioned; directive P0)

All contracts are **versioned** (`/api/v1/...`); a breaking change ships a new version, never a silent change to v1. Contracts below are sketches for implementation — **no code implements them yet** except where noted. Every endpoint requires tenant context (today the header stub; after B-101, a verified token) and enforces the caller's permissions (B-103 — not yet built, so every new route must add its permission check in the same change).

| Surface                        | Contract sketch                                                                                                                                                                                                                                                                                                                                                                                                           | Status                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Traceability                   | `GET /api/v1/traceability/lots/:id/backward`, `GET /api/v1/traceability/lots/:id/forward` — return the genealogy chain (lots, batches, movements, shipments, customers) with quantities, UoM, timestamps, statuses. `GET /api/v1/traceability/recalls` (mock recall: distribution list for a lot). `POST /api/v1/traceability/events` is internal only — events are written by the operational endpoints, never directly. | Not built (B-710). Raw material: `batch_inputs` + movement ledger.               |
| Accounting (GL)                | `POST /api/v1/accounting/journal-entries` (idempotency key header; balanced lines required; 422 on unbalanced) → `GET /api/v1/accounting/journal-entries/:id`, `GET /api/v1/accounting/accounts` (chart of accounts), `GET /api/v1/accounting/trial-balance`, `GET /api/v1/accounting/reports/pnl`, `.../balance-sheet`, `.../cash-flow` (all derived from posted lines, never stored balances).                          | Not built (B-701–B-704).                                                         |
| Tax                            | `GET /api/v1/tax/rules?jurisdiction=&effective=` (versioned rules), `POST /api/v1/tax/calculations` (compute a working paper from a taxable event + rule version) → `DRAFT`; `POST /api/v1/tax/calculations/:id/finalize` (human approval required) → `FINAL`; `GET /api/v1/tax/filings/:id/evidence` (evidence mapping for a filing package).                                                                            | Not built; excise routes today return 501 and are **not** this contract (B-706). |
| Quality / documents / training | Existing routes (`/api/documents`, `/api/training`, `/api/audit-events`) are the v1 surface in practice; they will be versioned as `/api/v1/...` when the versioning change lands (backlog B-103 note) without changing behaviour.                                                                                                                                                                                        | Built (unversioned paths).                                                       |
| Assistant                      | `POST /api/v1/assistant/ask` (read-only: question → cited answer or "evidence insufficient") → later `POST /api/v1/assistant/actions` (gated tools; each action returns an approval request when the tool is consequential). Every call writes `ai_interactions`.                                                                                                                                                         | Not built (B-301/B-306).                                                         |
| Commercial / platform          | `POST /api/v1/signup` (tenant creation), `POST /api/v1/invitations`, `GET /api/v1/billing/subscription` — defined when B-101/B-105 land; no contract is final until the auth and billing providers are chosen (OD-1, OD-2).                                                                                                                                                                                               | Not built.                                                                       |
| Webhooks / public API          | Signed webhooks with retry queues and duplicate protection; scoped tokens; OpenAPI spec published per version (ADR-013).                                                                                                                                                                                                                                                                                                  | Not built (B-603).                                                               |

**Contract rules:** idempotency keys on every mutating endpoint that posts money or moves stock; errors carry a stable machine-readable code plus a human message, never a stack trace; list endpoints paginate and are tenant-scoped by construction; no endpoint accepts a tenant id from the body or query string.
