# QualiOS AI — Architecture Decision Record

**Version:** 1.1 (directive revision) — 20 November 2026
**Status:** Planning only. "Confirmed" means the decision still stands and is reflected in code or in the new plan; "To revisit" means it needs a fresh decision; "Open" means Devon's call is needed.
**Governing plan:** Complete Master Blueprint v1.0, 20 November 2026, as corrected and expanded by the ChatGPT "Master Product Correction & Build Directive" (20 Nov 2026). Directive §9 deliverable (g): decision log — auth provider, hosting, data residency, IP ownership, naming/trademark risk, compliance validation, pricing. This revision adds OD-8–OD-13 and decisions D-06–D-10. **OD-1 is deliberately left as "evaluation underway"** — the Clerk evaluation itself is owned by another worker (`docs/architecture/AUTH_PROVIDER_EVALUATION.md`, not yet in the repo at the time of this revision) and is not written here.
**Carries forward:** `QualiOS-Architecture-Decision-Record.md` (13 ADRs, v0.1, 20 November 2026, goal workspace). The ADR numbers and titles are preserved; the context is restated for the universal platform — the wedge framing is superseded. Where an ADR conflicts with the new industry-neutral constraint, it is marked.
**Audit:** `QualiOS-Current-State-Audit-2026-11-20.md`.

## ADR-001 — Monorepo, modular packages — Confirmed

One repo, `apps/` + `packages/` + `workers/`, npm workspaces, TypeScript throughout. Module boundaries enforced by package: a package is used only through its exported interface. **Industry-neutrality note:** the package layout is neutral; the `industry-packs` package is where industry behaviour belongs, and it currently holds only a stub cannabis descriptor with no mechanism — the mechanism is backlog B-110/B-601.

## ADR-002 — Frontend: Next.js / React, responsive — Confirmed

Next.js web app serves both the public site and the web app (one codebase for now; split if the marketing surface diverges). Mobile is Android-first in the old ADR; under the new plan mobile is React Native/Expo (blueprint §7) — **to revisit** as part of the mobile-stack open decision (Phase 5).

## ADR-003 — Backend: TypeScript Node.js API, modular services — Confirmed

Express 5 API, TypeScript, routes split by resource, shared `lib/` for DB, storage, errors, files. Services stay modular inside the monolith; split only when scaling or compliance demands it (blueprint §7).

## ADR-004 — Database: PostgreSQL, tenant IDs on every record, row-level security — Confirmed

PostgreSQL 16. Every tenant table carries `organization_id`; RLS enabled on every tenant table with policies on `app.current_organization_id`. **Known trap (audit §2):** locally the API connects as a superuser/owner, so RLS does not bite in dev; production must use a non-owner app role with `FORCE RLS`. **Industry-neutrality note:** the schema violates this ADR's spirit in places — cannabis enums and columns sit in shared tables (audit §6A). The ADR stands; the schema must be brought into line with it (B-110).

## ADR-005 — Object storage: private S3-compatible buckets for originals — Confirmed

Storage abstraction is S3-shaped; objects are private, addressed by tenant-scoped keys, filenames sanitized, traversal validated. Local filesystem backend is the dev implementation; S3 is not wired and the factory refuses rather than silently storing objects nowhere. Local backend must never hold real customer data beyond local development.

## ADR-006 — Asynchronous jobs: queue + workers for OCR, AI review, imports — Confirmed, not built

Queue + workers for OCR, AI review, imports, scheduled reports, integration retries, with retries and dead-letter handling. The worker package is a stub that throws; no queue is configured. Lands with Phase 3 (B-304).

## ADR-007 — AI provider abstraction, no hard vendor dependency — Confirmed

All AI access goes through `@qualios/ai`. No provider is selected, no model is called, the gateway throws. **Open decision:** provider selection (Phase 3). No customer data goes to any AI provider until provider selection, DPA, and data-residency review are complete.

## ADR-008 — Tenant isolation: defence in depth — Confirmed

Three layers: application scoping (every query carries `organization_id`; tenant ids never from body/query), database RLS, and service-layer scoping (AI retrieval, search, exports, webhooks). Layers 1–2 are implemented with the caveats in the audit; layer 3 is designed, not built. Automated authorization tests are a release gate.

## ADR-009 — Prototype on Replit, production on managed cloud — TO CONFIRM

The old ADR said: prototype on Replit, production on managed cloud. **Status: to confirm.** There is no Replit project connected to this repo in the audit, and no managed-cloud hosting exists. Hosting is an **open decision** (Phase 1). Whatever is chosen, the rule stands: the prototype environment never holds real customer data, and staging/production are separate environments.

## ADR-010 — CI/CD via GitHub, staging/production separation — Confirmed, partially built

GitHub Actions CI exists (install, lint, typecheck, test against Postgres, migrate, verify audit chain, build API). No CD: no staging or production environment, no deployment pipeline, no rollback plan. Lands in Phase 1 (B-107).

## ADR-011 — Identity: managed auth with MFA; enterprise SSO is a roadmap item — Confirmed, not built

Managed auth provider with MFA; enterprise SSO is a Phase 6 item. **Current state: a header stub with no token verification; `verifyToken` throws; the API refuses to start in production.** **Open decision:** provider selection (Phase 1, B-101). This is the highest-priority open decision — nothing can be demonstrated to a real customer until it is made.

## ADR-012 — No autonomous regulated actions — Confirmed

AI assists, detects, drafts, and recommends. Regulated releases, formal signatures, legal filings, and professional attestations require authorized human approval. No code path posts a correction, files anything, releases a batch, or signs on a person's behalf. AI answers carry citations or state evidence is insufficient. This ADR is currently vacuous (no AI exists) and becomes load-bearing in Phase 3.

## ADR-013 — Integrations: REST API, OpenAPI, webhooks, scoped tokens — Confirmed, not built

Public API surface with OpenAPI, signed webhooks with retry queues and duplicate protection, idempotency keys, scoped tokens. Only file import (seed-to-sale CSV/XLSX — cannabis-pack behaviour) exists. Live connectors are a Phase 6 item; whether vendors expose live APIs is unconfirmed (old backlog Q-108, carried into B-603).

## Open decisions (need Devon's call)

| #     | Decision                                                                                                                                                     | Why it blocks                                                                                                                                                                                                                                                                                                                           | Phase |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| OD-1  | Managed auth provider (and MFA approach) — **evaluation underway — see docs/architecture/AUTH_PROVIDER_EVALUATION.md; decision needs Devon's Clerk account** | Nothing can be demonstrated to a real customer without real auth; the production-start refusal stays until this is made. The evaluation itself (Clerk vs alternatives on enterprise, pricing, and data requirements) is owned by another worker and is not written in this document.                                                    | 1     |
| OD-2  | Billing provider                                                                                                                                             | Subscriptions, trials, invoices, and payment handling cannot be built without it.                                                                                                                                                                                                                                                       | 1     |
| OD-3  | Hosting / managed cloud (confirm or replace ADR-009)                                                                                                         | No staging or production environment exists.                                                                                                                                                                                                                                                                                            | 1     |
| OD-4  | AI provider (and DPA / data-residency review)                                                                                                                | No assistant work can start; no customer data may go to a provider before this.                                                                                                                                                                                                                                                         | 3     |
| OD-5  | Mobile stack (confirm React Native/Expo)                                                                                                                     | Mobile apps cannot start.                                                                                                                                                                                                                                                                                                               | 5     |
| OD-6  | First industry pack(s) to validate beyond cannabis                                                                                                           | Phase 6 sequencing: which pack after cannabis, and which pilot customer proves it. The core is built industry-neutral regardless; this decides pack order only.                                                                                                                                                                         | 6     |
| OD-7  | Excise/tax rule review (domain expert / accountant)                                                                                                          | Excise calculation routes stay 501 until rules are reviewed; no excise number may be shown to a customer before this.                                                                                                                                                                                                                   | 6     |
| OD-8  | Hosting — managed cloud provider and region (refines OD-3)                                                                                                   | Staging/production, backups, and observability all depend on it; the choice also constrains data residency (OD-9) and cost.                                                                                                                                                                                                             | 1     |
| OD-9  | Data residency — where tenant data lives, and which regions are offered                                                                                      | The directive's finance, tax, and assistant scope makes residency load-bearing (AI provider data flows, tax records, retention/deletion); no customer data may go to an AI provider until provider selection, DPA, and residency review are complete. Needs Devon's call on the initial region(s) and whether residency is a paid tier. | 1     |
| OD-10 | IP ownership — QualiOS code, customer data, AI outputs, and pack content                                                                                     | Terms, DPA, and the assistant's memory/ownership rules cannot be written without it; the pilot (Herba) must not acquire ownership of the platform by being first. Needs legal review.                                                                                                                                                   | 1     |
| OD-11 | Naming / trademark risk — "QualiOS" vs Qualio (funded competitor, $64M raised, $22M revenue, same conceptual space)                                          | The name is one letter off a funded competitor in the same space; confusion and trademark risk must be assessed before the public site and any marketing spend. Needs Devon's call on whether to keep the name, and legal review.                                                                                                       | 1     |
| OD-12 | Compliance validation — who validates jurisdiction-specific compliance and e-signature requirements, and what evidence counts                                | The directive (§7) requires qualified-professional validation before marketing any capability as compliant; mappings need dated source references and change tracking. No claim of "certified" or "fully compliant" may be made before this. Needs Devon's call on the validator(s) and budget.                                         | 6     |
| OD-13 | Pricing — validate the blueprint §9 hypotheses (Starter $99 / Professional $299 / Business $799 / Enterprise custom CAD/mo)                                  | The public site, trials, and billing cannot be built on unvalidated prices; willingness-to-pay and AI service costs must be validated first. Needs Devon's call on the validation approach (pilot interviews, landing-page test, or advisor review).                                                                                    | 1     |

## Decisions made in this revision (20 Nov 2026)

- **D-01 — The old v1.0 blueprint is superseded.** The Complete Master Blueprint (6 pages, 20 Nov 2026) is the governing plan. The cannabis wedge is not the product; the reconciliation engine is the cannabis pack's Phase 4 work.
- **D-02 — Industry-neutral core (hard constraint).** Generic SOPs, generic training, generic workflows. No cannabis-specific logic in the core; industry behaviour lives behind the industry-pack concept. The 11 leaks found in the audit (§6A) are catalogued with fix direction; remediation is backlog B-110.
- **D-03 — First milestone is blueprint §12.** Signup → tenant → SOP publish → training → audit-trail export → assistant SOP Q&A with citation → tenant-isolation tests. The old 30-day sprint's day-numbering is retired.
- **D-04 — Planning docs live in the repo.** The seven docs (`docs/product/`, `docs/architecture/`, `docs/compliance/`) are the plan of record. The old goal-workspace docs are retained for history and marked superseded, not deleted.
- **D-05 — Nothing is pushed from this work.** Local commits only, per instructions. CI status on GitHub was not checked and is not claimed.

## Decisions made in this revision (20 Nov 2026 — directive revision)

- **D-06 — The ChatGPT directive is adopted as a correction/expansion layer.** The Complete Master Blueprint remains the governing plan; the directive expands it (audit §9.11) and re-prioritizes parts of it (audit §9.12). Conflicts are recorded in the audit and the roadmap, not resolved by the worker — the sequencing call is Devon's.
- **D-07 — Finance GL is a new core module, not an integration.** The directive lists the double-entry GL as a QualiOS module; it is modelled as core entities (`chart_of_accounts`, `journal_entries`, `journal_lines`) with DB-enforced balance, immutability, and idempotency. Accounting/ERP integrations remain a separate, later item.
- **D-08 — Traceability is the unifying engine.** One core lifecycle of linked events over shared entities (lots, batches, movements, documents, ledger entries), with pack-configured stage names and rules — not a separate service and not per-industry duplicate tables. Sales, accounting, and tax are lifecycle stages, not afterthoughts.
- **D-09 — Tax filing boundary unchanged.** QualiOS prepares working papers and evidence; it never files. "Qualified review before filings" means qualified review of the rules **and** of each filing package before a human files it.
- **D-10 — Assistant "execute" means propose-for-approval.** The directive's execute permission tier is read as permission to propose an execution for explicit human approval (ADR-012), never autonomous execution of a consequential action. The read-only assistant ships before any action tool, and the evaluation set gates both.
- **D-11 — Honesty language carries into the new scope.** The directive's definition of done (§10) is adopted verbatim: a feature is complete only with real persistent data, access controls, working UI/API, documented behaviour, automated tests, and demonstrated end-to-end use. No 30-day promise for the whole platform.
