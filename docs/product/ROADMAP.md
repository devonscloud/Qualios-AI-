# QualiOS AI — Roadmap

**Version:** 1.1 (directive revision) — 20 November 2026
**Status:** Planning only. Dates are not committed; phases are sequenced, not scheduled. Nothing here is built unless the Current-State Audit says it is.
**Governing plan:** Complete Master Blueprint v1.0, 20 November 2026 (§11, §12), as corrected and expanded by the ChatGPT "Master Product Correction & Build Directive" (20 Nov 2026). This revision adds the directive's P0/P1/P2 priorities and records where they conflict with the blueprint's phase order (§"Directive priorities vs blueprint phases" below). **No conflict is resolved silently — the decision is Devon's.** Backlog B-701–B-712 (directive expansion items) and the milestone table live in `docs/product/MODULE_BACKLOG.md`.
**Supersedes:** `QualiOS-30-Day-Sprint-Plan.md` (v1.0 30-day sprint, goal workspace). Its day-numbering (Days 7–28) no longer maps to the plan and must not be used to schedule work. The work it tracked is re-phased below.
**Audit:** `QualiOS-Current-State-Audit-2026-11-20.md`.
**Backlog:** `docs/product/MODULE_BACKLOG.md` (stories B-101–B-607).
**Core rule (hard constraint, 20 Nov 2026):** every phase builds the **industry-neutral core** first. Industry-specific behaviour goes behind the industry-pack concept (blueprint §5): food/beverage/meat/agriculture, pharma/medical devices, cannabis/alcohol/tobacco, industrial fabrication/welding/construction, cosmetics/chemicals/automotive/aerospace/warehousing/logistics. No phase hard-codes a regulation as universally applicable, and no phase adds industry-specific logic to shared core code.

## Release gates (apply to every phase, blueprint §11)

No phase is "complete" because UI screens merely exist. A phase ships only with: working functionality, automated tests, security review, user acceptance criteria, documentation, and a release decision.

## Phase 0 — Repository audit & product specification (done, 20 Nov 2026)

- Evidence-based current-state audit of the actual repo (this audit's companion document).
- Revised planning set: `PRODUCT_REQUIREMENTS.md`, `ARCHITECTURE.md`, `MODULE_BACKLOG.md`, `DATA_MODEL.md`, `SECURITY.md`, `ROADMAP.md` (this doc), `DECISIONS.md`.
- Industry-neutrality review of the existing code (audit §6A): 11 cannabis-specific leaks into the core catalogued, with fix direction.
- **Exit criteria met:** audit written; planning docs written; open decisions listed in DECISIONS.md.

## Phase 1 — SaaS foundation

**Goal:** a stranger can sign up, pay, and get an isolated tenant; the platform can be deployed and observed.

- Public website (positioning, features, industry pages, pricing, trial, lead capture, help, policies, contact) — written industry-neutral from the start.
- Secure registration, tenant creation, invites, roles with enforced permissions, company/facility settings.
- Managed auth with MFA (OPEN DECISION: provider); billing sandbox (OPEN DECISION: billing provider).
- Staging environment with rollback plan; backups and restore drills; observability (logs, metrics, health).
- Core-neutrality remediation begins (B-110): no new industry-specific concepts in core code; existing leaks scheduled for extraction.
- Dashboard (first version).
- **Exit criteria:** a new customer completes signup → trial → tenant creation end-to-end on staging; tenant-isolation tests pass; permission tests pass; production-start refusal lifted only because real auth is wired, not by removing the check.
- **Backlog:** B-101–B-110.

## Phase 2 — First complete QMS workflow (first milestone)

**Goal:** the smallest complete, sellable loop — SOP → training → audit trail — built generic, usable by any industry.

- SOP lifecycle: upload, version, approve, publish an effective version with an effective date; distribution and acknowledgement.
- Training: role matrices, assignment, assessment/acknowledgement, completion records, expiry, supervisor sign-off.
- Manager review of completion; dated audit-trail export of every step.
- Multi-tenant test of the whole workflow.
- **Exit criteria:** all 8 first-milestone acceptance criteria (§12) pass — see "First milestone" below.
- **Backlog:** B-201–B-207.

## Phase 3 — Assistant & document intelligence

**Goal:** the assistant answers from the tenant's own documents, with citations, and cannot see another tenant's data.

- Managed AI provider behind the gateway (OPEN DECISION: provider); permission-scoped RAG with citations; evaluation sets.
- Document extraction (OCR/AI) with confidence, field locations, and human verification queue.
- Async job queue with retries and dead-letter handling.
- Daily briefing; action assistant with confirmation for high-impact actions; AI interaction logging.
- Prompt-injection defence tests; no training on customer data by default.
- **Exit criteria:** cited answers pass the evaluation set; cross-tenant retrieval tests fail closed; injection tests pass; every assistant action is logged.
- **Backlog:** B-301–B-307.

## Phase 4 — Quality + operations

**Goal:** the full QMS and operations core — audits/CAPA, deviations, production, inventory, lab, traceability, equipment, safety, suppliers.

- Audits & CAPA, inspections, deviations/nonconformances/complaints, change control, risk, quality reviews.
- Production & batch: recipes/BOM, work orders, genealogy, electronic batch records.
- Inventory & reconciliation: the generic ledger-vs-snapshot pattern is core; **seed-to-sale is the cannabis pack's work** (B-404 + B-110 extraction).
- Testing & lab, traceability & recalls (incl. mock recalls), equipment & facilities, safety & environmental, supplier qualification.
- Workflow engine enforcing state machines server-side.
- Distributor listings as a cannabis-pack capability (B-411), with unverified fields blank and flagged.
- **Exit criteria:** each module passes its acceptance criteria with tests; genealogy traces forward and backward; a mock recall completes.
- **Backlog:** B-401–B-411.

## Phase 5 — Mobile & commercial launch

**Goal:** employees can do key work from Android/iOS, including offline; billing and support are production-grade; pilot rollout runs.

- Mobile apps (OPEN DECISION: mobile stack confirmation) with workflow parity for key tasks, barcode/QR scanning, camera uploads, signatures, notifications, offline capture with safe sync.
- Billing productionization, support ticketing, status page.
- Pilot rollout with pilot customers; genuine case studies only.
- **Exit criteria:** mobile parity tests pass; offline sync verified; pilot customers live; billing handles payment failure, upgrade/downgrade, cancellation, and data export.
- **Backlog:** B-501–B-505.

## Phase 6 — Industry and global expansion

**Goal:** every industry in blueprint §5 has a pack; the platform works globally.

- Industry packs as configurable rule sets, templates, and workflows on the shared core — cannabis (with excise/tax working papers from expert-reviewed rules; never auto-filed), food/HACCP, pharma/GMP, industrial, and others. Each pack is validated against real requirements with pilot evidence; no pack's rules are treated as universal.
- Tax/excise: generic versioned-rule engine with pack-registered bases (per-mg-THC is the cannabis pack's basis).
- Enterprise SSO, public APIs with scoped tokens, signed webhooks, advanced reporting, localization, accessibility.
- Optional human-auditor services with independence controls.
- **Exit criteria:** each pack ships with validation evidence; enterprise SSO and APIs pass security review; localization covers the target markets.
- **Backlog:** B-601–B-607.

## First milestone — testable acceptance criteria (blueprint §12)

The milestone is Phases 1–2 plus the assistant slice of Phase 3 (criterion 7). It is the first thing that must be demonstrable to a real customer.

1. A new customer can sign up, choose a plan or trial, and create an isolated company tenant.
2. An administrator can invite a user, assign a role and restrict access appropriately.
3. An administrator can upload an SOP, create a version, approve it and publish an effective version.
4. A manager can assign training on that SOP to an employee.
5. The employee can view the current SOP, complete an assessment/acknowledgement and record completion.
6. A manager can review completion and export a dated audit trail of every step.
7. The AI assistant can answer an authorized SOP question with a document citation and cannot retrieve another tenant's SOP.
8. Automated integration/security tests demonstrate permissions, persistence, history and tenant isolation.

**Status 20 Nov 2026: 4 of 8 fully met (3, 4, 5, 6); 1 partially met (8); 3 missing (1, 2, 7).** Criteria 3–6 were implemented 20 Nov 2026 (migration 0010; SOP publish, training assignment/completion/verification, manager review, dated CSV audit-trail export; 13 integration tests incl. two-tenant isolation). Criterion 8 is partially met: tenant isolation is now tested for the SOP/training workflow, but permission enforcement (B-103) still does not exist, so there are no permission tests. Caveat on 3–6: the flow runs under the header-stub tenant context — auth is still OPEN DECISION OD-1 and no role enforcement exists — so it is proven in dev, not yet demonstrable to a real customer. The SOP and training in this milestone are generic — the same flow serves a food-safety SOP, a pharma SOP, or a cannabis SOP; the industry difference is the pack's templates and content, not the workflow.

## Commercial model (blueprint §9 — hypotheses, unvalidated)

- Illustrative pricing (CAD/month): Starter $99, Professional $299, Business $799, Enterprise custom. Validate willingness to pay and service costs before committing.
- Revenue: subscriptions, seats/sites, AI usage tiers, premium modules, integrations, implementation, training, enterprise support, optional human audits.
- Lifecycle: lead → demo/trial → plan selection → checkout → tenant creation → guided setup → data migration → role configuration → activation → support → renewal/expansion.
- Track: activation, conversion, MRR/ARR, churn, retention, gross margin, support load, AI cost per tenant, uptime, customer outcomes.

## Directive priorities vs blueprint phases (conflicts recorded, not resolved)

The directive (§8) sets its own priorities: **P0** — audit matrix; resolve managed auth; complete B-110; publish the integrated domain model and interface contracts before new isolated features. **P1** — complete the end-to-end SOP flow; traceability proof of concept; finance posting prototype; permission-aware, citation-grounded assistant read-only first, then gated action tools. **P2** — audits/CAPA, advanced manufacturing, jurisdictional tax/excise packs, public website/billing, and mobile apps in dependency order.

| #   | Point                                                                                                        | Blueprint order                                                        | Directive order                                                       | Status in this revision                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C-1 | Traceability POC (receive → consume → finish → ship → trace backward/forward)                                | Phase 4, after assistant                                               | P1, immediately after the SOP flow                                    | Added as milestone M3 / backlog B-710. Flagged: depends on B-103 (permissions) and B-110 (pack extraction), which the directive's P1 does not mention; building it before auth lands repeats the SOP increment's caveat. |
| C-2 | Finance posting prototype (receipt + invoice → valuation/AP → consumption/COGS → sales invoice/AR, balanced) | Phase 6, and without a GL at all                                       | P1, same wave as the SOP flow                                         | Added as milestone M3 / backlog B-702, explicitly a prototype — the full GL stays a later phase (M6).                                                                                                                    |
| C-3 | Tax / excise packs                                                                                           | Phase 6, last                                                          | P2, with audits/CAPA, site/billing, mobile                            | Packs move to M5 (B-706–B-707) with the guardrail intact: no pack ships without qualified review, nothing auto-files.                                                                                                    |
| C-4 | Public website / billing vs mobile                                                                           | Mobile Phase 5; industry/tax Phase 6                                   | P2 groups site/billing **and** mobile together                        | Not adopted silently: the roadmap keeps mobile in Phase 5 and site/billing in Phase 1/5, because billing before auth (P0) is impossible. Devon to choose the grouping.                                                   |
| C-5 | Integrated domain model + API contracts before new features                                                  | Phase 0 required audit + specification; contracts were not a hard gate | P0 hard gate                                                          | Met in planning by this revision (ARCHITECTURE §10–§12, DATA_MODEL §12). Must be re-checked before any P1 prototype code lands.                                                                                          |
| C-6 | Assistant sequencing                                                                                         | Phase 3: RAG, then briefing, then actions                              | P1: read-only first, then gated action tools                          | Aligned in substance; the directive pulls the read-only assistant one phase earlier (M3, B-709), with the evaluation set as its gate.                                                                                    |
| C-7 | Auth vs everything                                                                                           | Phase 1 foundation                                                     | P0: resolve the choice, then signup/invites/MFA/roles/isolation tests | Aligned. OD-1 is evaluation-underway (see DECISIONS.md).                                                                                                                                                                 |

**What the directive does not change:** the first-milestone acceptance criteria (blueprint §12) and its P1 end-to-end flow (register → SOP → training → audit export) match them. The directive's P1 prototypes (traceability, finance, read-only assistant) run **in parallel with**, not instead of, the first milestone — but they depend on the same missing foundation (auth, permissions), so if M1 slips, M3 slips with it. **No 30-day promise** (directive §10): the platform is built incrementally toward the complete vision.

## What is NOT on the roadmap

- A cannabis-only product, a standalone assistant, or any single-industry build.
- Autonomous batch release, automatic filing, or any regulated action without human approval.
- Claims of certification or "fully compliant" status.
- Any phase declared complete on the strength of screens alone.
