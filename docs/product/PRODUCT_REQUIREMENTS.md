# QualiOS AI — Product Requirements

**Version:** 1.0 (new plan) — 20 November 2026
**Status:** Planning only. Nothing in this document is built unless the Current-State Audit says it is.
**Governing plan:** Complete Master Blueprint v1.0, 20 November 2026.
**Supersedes:** `QualiOS-PRD-Cannabis-Inventory-Wedge.md` (v1.0 wedge PRD, goal workspace). That PRD described a cannabis-inventory wedge as the product; it is superseded. Requirements from it that are still true are carried forward below and marked **[carried forward]**; everything else is new or re-phased.
**Audit:** `QualiOS-Current-State-Audit-2026-11-20.md` (goal workspace, `files/`).

## 1. Product definition (non-negotiable)

QualiOS AI is a **commercial, multi-tenant, global AI-powered quality-assurance platform** sold to the public — to licensed producers and other regulated businesses of any size. It is software and a website, not a single-company internal tool, not a chatbot-only project, and not a cannabis-only system.

- One universal platform with configurable industry, jurisdiction, role, facility, and subscription modules (blueprint §1).
- Customers self-register or are onboarded by sales, pay for subscriptions, invite employees, and use separate secure company workspaces.
- A shared cloud backend, APIs, identity, databases, workflow engine, event system, AI services, and document storage power the website and the mobile apps.
- **Herba Farms is the pilot customer only** — the place where things are proven first. Herba is never the customer the product is built for. The five Herba reconciliation cases are pilot test evidence, not product requirements.
- **Cannabis is one industry pack**, not the product. No regulation is hard-coded as universally applicable; industry packs are configurable rule sets, data models, templates, and workflows on a shared core (blueprint §5).
- **The core is industry-neutral.** Generic SOPs, generic training, generic workflows, generic inventory, generic documents. No cannabis-specific logic in the core: no cannabis-named entities, no cannabis-only assumptions in the data model, no hard-coded regulations. Industry-specific behaviour lives behind the industry-pack concept only. Packs: food/beverage/meat/agriculture, pharma/medical devices, cannabis/alcohol/tobacco, industrial fabrication/welding/construction, cosmetics/chemicals/automotive/aerospace/warehousing/logistics (blueprint §5). A pack contributes taxonomy values, rule bases, templates, and workflows through configuration — never by branching core code on an industry.
- Planned, implemented, tested, validated, and commercially released features are always kept separate. **Never describe an unfinished feature as working.**

## 2. Customer-facing surfaces (blueprint §2)

1. **Public website** — positioning, features, industry pages, demos, testimonials (only genuine), pricing, trials, lead capture, sales, help center, policies, billing, contact. _Missing; the current web home page is a scaffold._
2. **Web app** — dashboards, records, workflows, administration, analytics, configuration, document management, AI workspace. _Partially implemented: document upload/review and reconciliation pages exist as scaffolding over real APIs; no dashboard, admin, or analytics._
3. **Mobile apps (Android/iOS)** — assigned tasks, personal assistant, inspections, barcode/QR scanning, camera uploads, signatures, notifications, offline capture with safe synchronization. _Missing entirely._
4. **Personal AI assistant** — contextual, permission-aware, available across web and mobile: chat, optional voice, proactive alerts, approved actions. _Missing entirely; the gateway is a stub that throws._

## 3. Personas

| Persona                           | Needs                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Business owner / buyer            | Subscribe online, configure the company, see KPIs and cost drivers, trust the audit trail.                                  |
| Company administrator             | Invite users, assign roles, manage facilities, subscriptions, and settings.                                                 |
| QA manager / approver             | Approve SOPs and documents, assign training, verify completion, run audits, review CAPAs.                                   |
| Employee / operator               | View current SOPs, complete training and assessments, follow step-by-step guidance, log incidents, capture records offline. |
| Auditor (internal or external)    | Read-only, scoped access to records, evidence packs, and the audit trail.                                                   |
| Finance / compliance lead         | Excise and tax working papers, obligation registers, filing preparation — never auto-filed.                                 |
| Platform operator (QualiOS staff) | Admin console, support, billing operations, health and observability.                                                       |

## 4. Functional requirements

### 4.1 Platform & identity (Phase 1)

- **FR-PLAT-01** — A new customer can self-register, choose a plan or trial, and create an isolated company tenant. _(Missing.)_
- **FR-PLAT-02** — An administrator can invite a user by email; the invitee joins only that tenant, with an assigned role. _(Missing.)_
- **FR-PLAT-03** — Roles carry permissions; every API route enforces the caller's permissions, not just membership. _(Schema exists; enforcement missing.)_
- **FR-PLAT-04** — Organizations, facilities/sites, and multi-site hierarchies are configurable per tenant. _(Schema exists; no UI or API for configuration.)_
- **FR-PLAT-05** — Authentication is a managed provider with MFA; enterprise SSO is a later phase. _(Stub only — OPEN DECISION: provider selection.)_
- **FR-PLAT-06** — Subscriptions, seats/sites, AI usage tiers, invoices, taxes, payment failure, upgrade/downgrade, cancellation, and data export on termination. _(Missing — OPEN DECISION: billing provider.)_
- **FR-PLAT-07** — Tenant isolation is enforced at database, query, and service layers, with automated authorization tests. _(Data layer implemented; app-layer permission enforcement and full test coverage missing.)_
- **FR-PLAT-08** — Feature flags and entitlements gate modules and AI usage per plan. _(Missing.)_

### 4.2 Document control & SOPs (Phase 2 — first milestone)

- **FR-DOC-01 [carried forward]** — Upload a document; each version is immutable and separately stored; a new version never overwrites a previous one. _(Implemented for generic documents.)_
- **FR-DOC-02 [carried forward]** — Review queue with approve/reject; reviewer must differ from uploader (segregation of duties). _(Implemented for generic documents.)_
- **FR-DOC-03** — SOP lifecycle: draft → review → approve → publish an effective version with an effective date; superseded versions remain retrievable; archival and retention rules apply. _(Implemented 20 Nov 2026, migration 0010: SOP type, publish endpoint with effective date, superseded versions retrievable; archival/retention rules still missing.)_
- **FR-DOC-04** — Distribution and acknowledgement: publish reaches the assigned roles/sites; acknowledgement is recorded per user. _(Missing.)_
- **FR-DOC-05** — Every document write and approval produces a hash-chained, append-only audit event in the same transaction. _(Implemented.)_
- **FR-DOC-06** — Document templates, controlled taxonomies, and duplicate detection. _(Missing.)_
- **FR-DOC-07** — Paper + digital + hybrid capture: PDFs, scanned forms, photos, spreadsheets, handwritten records; immutable originals with provenance; OCR/AI extraction shows confidence and source field locations; uncertain fields queue for human verification; corrections preserve who made them. _(Originals + provenance implemented; extraction/OCR missing.)_

### 4.3 Training & competency (Phase 2 — first milestone)

- **FR-TRN-01** — Role-based training matrices: which SOPs and courses each role must complete. _(Missing.)_
- **FR-TRN-02** — A manager assigns training on an SOP to an employee. _(Implemented 20 Nov 2026: assignment on the effective version only, with assignee, due date, and audit event.)_
- **FR-TRN-03** — The employee views the current SOP, completes an assessment or acknowledgement, and completion is recorded with date, version, and identity. _(Implemented 20 Nov 2026: assignee-only completion, explicit acknowledgement required, optional 0–100 assessment score, recorded against the assigned version.)_
- **FR-TRN-04** — Refresher/retraining, expiry, qualifications, and supervisor sign-off. _(Partially implemented 20 Nov 2026: re-assignment after completion is allowed for refresher; manager verification is supervisor sign-off. Expiry and qualifications tables still missing.)_
- **FR-TRN-05** — A manager reviews completion and exports a dated audit trail of every step. _(Implemented 20 Nov 2026: review list with counts; dated CSV export of the full SOP/training trail in hash-chain order.)_

### 4.4 AI assistant & document intelligence (Phase 3)

- **FR-AI-01** — The assistant answers questions using only tenant-authorized company documents and approved external sources, citing exact records and document versions, showing confidence and unknowns. _(Missing; types only.)_
- **FR-AI-02** — The assistant cannot retrieve another tenant's documents; cross-tenant retrieval is blocked and tested. _(Missing.)_
- **FR-AI-03** — Daily briefing: personalised to-do list, overdue actions, upcoming audits, training expiries, production risks, approvals, calendar events, priority alerts. _(Missing.)_
- **FR-AI-04** — Action assistant: draft CAPAs, create tasks, schedule inspections, assemble audit packs, prepare meeting notes, generate reports, route approval requests — each action permission-scoped, confirmed for high-impact actions, idempotent, and logged. _(Missing.)_
- **FR-AI-05** — Quality/production/compliance/executive/employee assistant behaviours per blueprint §3 (batch review summaries, work-order status, obligation registers, KPI summaries). _(Missing.)_
- **FR-AI-06** — The assistant never fabricates signatures, approvals, or test results; never guarantees legal compliance; regulated releases, formal certification, safety-critical decisions, legal conclusions, and financial filings remain subject to authorized human review. _(Designed in ADR-012; no AI exists yet to violate it.)_
- **FR-AI-07** — AI suggestions, supporting evidence, model/version, human review, actions taken, and exceptions are logged (`ai_interactions`). _(Table exists; nothing writes to it.)_
- **FR-AI-08** — Prompt-injection resistance for uploaded records; no training on customer data by default; user-controlled memory, retention limits, correction, and deletion. _(Missing.)_
- **FR-AI-09** — Model quality evaluations, hallucination testing, bias checks, prompt-injection defence, cost/latency budgets, human escalation. _(Missing.)_

### 4.5 Quality & operations (Phase 4)

- **FR-QMS-01** — Quality manual, policies, inspections, deviations, nonconformances, complaints, change control, risk, quality reviews, approval workflows. _(Missing.)_
- **FR-QMS-02** — Audits & CAPA: internal/supplier audits, checklists, scheduling, findings, evidence, root cause, corrective/preventive actions, effectiveness verification. _(Missing.)_
- **FR-QMS-03** — Production & batch: recipes/BOM, work orders, batch/lot genealogy, production logs, line clearance, in-process checks, yields, electronic batch records. _(Batch/lot tables exist as scaffolding; no workflows.)_
- **FR-QMS-04 [carried forward, re-scoped]** — Inventory & reconciliation (core pattern + pack specifics): materials, receiving, quarantine/release, locations, stock movement, cycle counts, expiry, procurement, supplier qualification, shipping; a generic reconciliation pattern — an internal movement ledger compared against an external record set, with variance detection and a discrepancy lifecycle with evidence. _(The ledger, the comparison engine, and the discrepancy lifecycle are implemented — reconciliation engine v0.)_ The **seed-to-sale import is cannabis-pack behaviour, not core**: the cannabis pack supplies the seed-to-sale file formats, mappings, and source-system values. The core knows only "external snapshot" and "ledger import".
- **FR-QMS-05** — Testing & lab: specifications, sampling, lab requests, results, COAs, out-of-specification investigations, release recommendations. _(Missing.)_
- **FR-QMS-06** — Traceability & recalls: backward/forward genealogy, distribution records, mock recalls, recall cases, customer notification workflows. _(Raw material exists in batch inputs + movement ledger; no genealogy or recall workflow.)_
- **FR-QMS-07** — Equipment & facilities: asset register, maintenance, calibration, qualifications, downtime, sanitation, environmental monitoring, sensor interfaces. _(Missing.)_
- **FR-QMS-08** — Safety & environmental: hazards, incidents, near misses, safety training, inspections, emergency plans, waste and environmental logs. _(Missing.)_

### 4.6 Regulatory, tax & finance (Phase 6)

- **FR-REG-01 [carried forward]** — Jurisdiction-specific rules as versioned configuration, reviewed by a domain expert/accountant before use. Tax and excise rules are configuration supplied by the relevant industry/jurisdiction pack, never hard-coded in the core. The core provides a generic versioned-rule engine (jurisdiction, basis, rate, effective dates); each pack registers its own bases (per-mg-THC is the cannabis pack's basis, not the core's). _(Schema exists; rules unreviewed; calculation routes return 501.)_
- **FR-REG-02 [carried forward]** — Excise/tax working papers only. QualiOS calculates; it does not file. _(No calculation has ever run.)_
- **FR-REG-03** — Obligation registers, compliance calendars, filing preparation, evidence mapping. _(Missing.)_
- **FR-FIN-01** — Customer/supplier master data, quotes, orders, invoicing, purchase orders, costing, expenses, accounting/ERP integrations. _(Missing; the distributor-listing schema that exists is cannabis-pack-specific — Saskatchewan/Manitoba listing types — and belongs to the cannabis pack, not the core.)_

### 4.7 Analytics, automation, enterprise (Phases 4–6)

- **FR-AN-01** — Dashboards, KPI definitions, configurable reports, scheduled exports, alerts, workflow builder, escalation, anomaly detection. _(Missing.)_
- **FR-AN-02** — Public APIs, webhooks (signed, with retry and idempotency), connectors, data import/export, observability. _(Designed in ADR-013; not built. File import exists for seed-to-sale only.)_
- **FR-AN-03** — Multi-site hierarchy, multilingual UI, accessibility (WCAG-aligned), time zones, currencies, units, date formats, country-specific addresses. _(Missing.)_
- **FR-AN-04** — Permissions for contractors, external auditors, temporary workers, supplier and customer portals; approval delegation, separation of duties, dual control, e-signature meaning. _(Missing.)_
- **FR-AN-05** — Sandbox/test environments, demo tenants with synthetic data, versioned configuration, customer change management. _(Demo seed exists; sandbox environments do not.)_
- **FR-AN-06** — Service health, support ticketing, incident communications, onboarding checklists, status page, product feedback. _(Missing.)_
- **FR-AN-07** — Optional human auditor marketplace/services (Phase 6). _(Missing.)_

## 5. Non-functional requirements

- **NFR-01** — Tenant isolation: no tenant can read or write another tenant's data through any surface (API, AI retrieval, export, search). Automated tests prove it per release.
- **NFR-02** — Auditability: every critical write and approval is an attributable, immutable, hash-chained audit event; the chain is verifiable.
- **NFR-03** — Security: encryption in transit and at rest; secrets management; least privilege; scoped service accounts; vulnerability management; penetration testing before commercial release.
- **NFR-04** — Privacy by design: data minimization, purpose limitation, regional residency options, retention/deletion policies, DPA and subprocessor transparency.
- **NFR-05** — Reliability: backups and restore drills, disaster-recovery targets, incident response, offline capture with safe sync (mobile), partial-outage behaviour.
- **NFR-06** — Accessibility and localization as in FR-AN-03; no feature ships without accessible text alternatives for voice/multimodal input.
- **NFR-07** — Performance and cost: AI cost metered per tenant; cost/latency budgets for assistant calls; no phase is "complete" because UI screens merely exist — working functionality, automated tests, security review, user acceptance criteria, documentation, and a release decision are all required.

## 6. Out of scope / non-goals

- A cannabis-only product, or any single-industry build.
- A standalone assistant or chatbot.
- Automatic batch release, automatic filing, or any autonomous regulated action.
- Claims of certification or "fully compliant" status.
- Building on projections or unaudited figures as if they were verified — the same honesty rule applies to product claims as to financials.

## 7. First-milestone acceptance criteria (blueprint §12)

1. A new customer can sign up, choose a plan or trial, and create an isolated company tenant.
2. An administrator can invite a user, assign a role and restrict access appropriately.
3. An administrator can upload an SOP, create a version, approve it and publish an effective version.
4. A manager can assign training on that SOP to an employee.
5. The employee can view the current SOP, complete an assessment/acknowledgement and record completion.
6. A manager can review completion and export a dated audit trail of every step.
7. The AI assistant can answer an authorized SOP question with a document citation and cannot retrieve another tenant's SOP.
8. Automated integration/security tests demonstrate permissions, persistence, history and tenant isolation.

Current status against each criterion is in `docs/product/ROADMAP.md` ("First milestone"): 4 of 8 fully met (3, 4, 5, 6) as of 20 November 2026; criteria 1, 2, 7 still missing and 8 partially met. The audit's 20 Nov 2026 verdict (0 of 8) is superseded for criteria 3–6 by this increment.
