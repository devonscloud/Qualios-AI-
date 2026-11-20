# QualiOS AI — Security

**Version:** 1.1 (directive revision) — 20 November 2026
**Status:** Planning and standing rules. This document states the security posture, the threats, and what is and is not yet protected. It is not a compliance guarantee and nothing here is legal advice.
**Governing plan:** Complete Master Blueprint v1.0, 20 November 2026 (§7, §8), as corrected and expanded by the ChatGPT "Master Product Correction & Build Directive" (20 Nov 2026). This revision adds threats T-13–T-16 for the directive's new scope (double-entry ledger, tax filings, CRM/customer data, assistant tool use) and the assistant/finance control requirements from directive §5/§7. Nothing new here is built — the controls are specified so the first finance, tax, CRM, or assistant increment ships with them, not after them.
**Carries forward:** `QualiOS-Threat-Model.md` (12 threats T-01–T-12, NIST AI RMF / OWASP LLM mappings) and the standing rules from `docs/compliance/README.md`. The threat model was written for the wedge; the threats below are restated for the universal platform — the threat names and severities are carried forward, the scope is widened.
**Audit:** `QualiOS-Current-State-Audit-2026-11-20.md`.

## 1. Standing rules (unchanged)

- AI assists, detects, drafts, and recommends. Regulated releases, formal signatures, legal filings, and professional attestations require authorized human approval. There is no code path that posts a correction, files anything, releases a batch, or signs on a person's behalf without a human approval event.
- AI answers about company records must include verifiable sources or explicitly say evidence is insufficient.
- Excise rules are configuration reviewed by a domain expert / accountant before use. The platform calculates working papers; it does not file.
- Every critical write and approval generates a searchable, attributable, immutable audit event.
- Tenant data is never exposed across organizations (ADR-008).
- Never describe an unfinished feature as working, and never claim "certified", "fully compliant", or "automatically approves batch release".

## 2. Threats and controls (carried forward from the threat model)

### T-01 — Cross-tenant data disclosure (HIGHEST RISK)

_Controls (implemented, partially):_ `organization_id` on every tenant table; RLS policies on all tenant tables; `withTenant()` per-transaction scoping; application queries scope by tenant; storage keys tenant-scoped and validated.
_Residual risk:_ RLS does not bite when the API connects as a superuser/owner (local dev today) — production must use a non-owner app role with `FORCE RLS`. No permission enforcement exists on routes yet. AI retrieval does not exist yet, so the retrieval layer is untested. **Gate:** tenant-isolation tests must pass before any commercial release; Phase 1 must add route-level permission checks.

### T-02 — Unauthorized or forged approvals

_Controls (implemented, partially):_ approvals are rows with approver, decision, and timestamp; document review enforces reviewer ≠ uploader; every approval writes a hash-chained audit event in the same transaction.
_Residual risk:_ the identity behind the uploader/reviewer check comes from an unverified header (auth stub). Once real auth lands, approvals must be bound to verified identities, with e-signature meaning defined (blueprint §10: approval delegation, separation of duties, dual control).

### T-03 — Prompt injection via uploaded documents

_Controls (designed, not built):_ no AI consumes uploaded documents today, so there is no injection surface yet. The design requires: untrusted document content treated as data, never instructions; tool calls permission-scoped; high-impact actions confirmed.
_Residual risk:_ the first RAG/extraction implementation creates this surface. It must ship with injection test cases (malicious instructions embedded in a document must not change assistant behaviour or exfiltrate data).

### T-04 — Hallucinated or uncited AI answers

_Controls (designed, not built):_ grounded-answer contract (`Citation`/`GroundedAnswer` types): citations to exact records and versions, or an explicit "evidence insufficient" statement; evaluation sets; confidence and unknowns shown.
_Residual risk:_ no AI exists to hallucinate yet. The evaluation set (B-301) must exist before the assistant is shown to any customer.

### T-05 — Permission leakage through AI retrieval

_Controls (designed, not built):_ tenant-scoped indexing; retrieval filtered by the caller's permissions and entitlements; no retrieval outside the tenant.
_Residual risk:_ untested by definition until retrieval exists. Cross-tenant retrieval tests are part of the first-milestone criteria (§12, item 7) and must fail closed.

### T-06 — Audit log tampering

_Controls (implemented):_ append-only `audit_events` with per-organization SHA-256 hash chain and sequence; DB triggers reject UPDATE/DELETE; verification CLI (`verify-audit-chain`).
_Residual risk:_ TRUNCATE is not blocked by a trigger and requires privilege control; backups could be tampered with if not protected; no monitoring/alerting on chain-verification failure yet. Chain verification must become a scheduled check, not a manual command.

### T-07 — Data exfiltration via AI provider

_Controls (designed, not built):_ provider abstraction so the vendor can be swapped; no default training on customer data; DPA and subprocessor transparency required before any provider is used.
_Residual risk:_ no provider selected; no DPA exists. **Gate:** no customer data may be sent to any AI provider until provider selection, DPA, and data-residency review are complete.

### T-08 — Insecure prototype handling production data

_Controls (implemented):_ the API refuses to start in production while auth is a stub; local storage backend is documented as dev-only; demo seed is synthetic only.
_Residual risk:_ the refusal is a code check, not an infrastructure boundary. Staging/production must be separate environments with real secrets management before any real tenant data exists. No real Herba or customer data may be loaded into the current scaffold.

### T-09 — Weak authentication / session hijack

_Controls (designed, not built):_ managed auth provider with MFA (ADR-011); enterprise SSO is a later phase.
_Residual risk:_ **current state is a header stub — there is no authentication at all.** This is the highest-priority gap (Phase 1, B-101). Session handling, token lifetimes, revocation, and MFA enrollment must be specified when the provider is selected (OPEN DECISION).

### T-10 — Supply-chain / dependency compromise

_Controls (implemented, partially):_ lockfile committed; CI installs with `npm ci`; dependencies are pinned by the lockfile.
_Residual risk:_ no dependency vulnerability scanning in CI, no SBOM, no update policy. Add scanning before commercial release.

### T-11 — Data loss / ransomware / failed restore

_Controls (none):_ no backups, no restore drills, no disaster-recovery targets, no incident response plan.
_Residual risk:_ total for any deployed data. Backups + restore drills are a Phase 1 deliverable (B-107) before staging holds anything that matters.

### T-12 — Regulatory over-claim

_Controls (process):_ honesty rules in §1; excise rules require expert review; no "certified/fully compliant" language.
_Residual risk:_ marketing copy (Phase 1 public site) is where this risk materializes. Every claim on the public site must trace to a tested feature; testimonials must be genuine; regulatory mappings require qualified review, dated source references, change tracking, and jurisdiction-specific applicability (blueprint §8). Mappings are pack content: a cannabis mapping never applies to a food tenant, and no pack's rules are treated as universal.

### T-13 — Ledger tampering / unbalanced or duplicate posting (NEW — directive finance module)

_Controls (designed, not built):_ balanced-entry enforcement at the database layer (a journal entry cannot post unless debits equal credits); posted entries immutable (UPDATE/DELETE blocked by trigger; corrections are reversing entries); idempotency keys on every posting endpoint (a retried post returns the original entry); every posting writes an audit event in the same transaction; balances derived from posted lines, never stored or edited.
_Residual risk:_ the GL does not exist yet, so the controls are untested. **Gate:** the first finance increment (B-702 prototype) must ship with the balance trigger, the immutability trigger, and an idempotency test (double-post attempt books once) — a ledger without these is not shippable even as a prototype.

### T-14 — False tax filing / unreviewed tax rule (NEW — directive tax module)

_Controls (designed, not built):_ tax rules are versioned configuration requiring domain-expert review before use; calculations record the exact rule version used; calculations are `DRAFT` until a human approval event finalizes them; filing packages are preparation records only — QualiOS never files, and `FILED_EXTERNALLY` is set only by the human who filed.
_Residual risk:_ a wrong rule version silently produces a wrong working paper. **Gate:** no tax pack ships without qualified review of its rules, dated source references, and jurisdiction-specific applicability (blueprint §8); the excise routes stay 501 until then.

### T-15 — Customer / CRM data exposure (NEW — directive business-administration module)

_Controls (designed, not built):_ CRM entities carry `organization_id` and RLS like every tenant table; customer portals are separate, scoped access (a portal user sees only their own customer's records); no CRM data in AI retrieval unless the caller is authorized for that customer.
_Residual risk:_ CRM does not exist yet. **Gate:** portal access must be tested like tenant isolation (a portal user for customer A cannot see customer B) before any portal ships.

### T-16 — Assistant tool misuse / unauthorized consequential action (NEW — directive §5)

_Controls (designed, not built):_ tool allowlist with four permission tiers (read / draft / propose / execute); the assistant's permissions are the intersection of the user's, the role's, and the plan's entitlements; consequential actions (financial transactions, regulated releases, signatures, filings) require explicit human approval recorded as an `approvals` row + audit event; no tool posts a correction, files anything, releases a batch, or signs on a person's behalf; every tool call is logged (`assistant_tool_calls`) with inputs, outputs, and the human decision; evaluation sets (tool misuse, hallucination, prompt injection) must pass before the assistant is shown to any customer.
_Residual risk:_ no AI exists yet, so the controls are untested by definition. **Gate:** the read-only assistant (B-301) ships before any action tool (B-306), and B-306 does not ship without the approval-gate tests passing.

## 3. Security program (target, blueprint §8)

- Threat modeling (this document, updated per phase), penetration testing before commercial release, vulnerability management, access reviews, audit logs, customer security documentation.
- Privacy by design: data minimization, consent where needed, purpose limitation, regional residency options, retention/deletion policies, DPA and subprocessor transparency.
- Regulated electronic records/signatures: assess applicable requirements by jurisdiction and use case (e.g. 21 CFR Part 11 where relevant); validation evidence is required before claims.
- Customer terms, privacy policy, acceptable use, service levels, IP ownership, AI disclosures, professional-service boundaries, and insurance receive legal review before commercial launch.
- Encryption in transit and at rest; secrets management; backups and restore drills; disaster-recovery targets; incident response; security monitoring.
- Security review is a release gate for every phase (blueprint §11).

## 4. What is protected today (verified)

- Tenant scoping at the application layer and RLS at the database layer (with the superuser caveat in T-01).
- Append-only, hash-chained audit log with verification.
- Segregation of duties on document review (identity unverified — see T-02).
- Storage keys validated against traversal; uploaded filenames sanitized.
- Production start refused while auth is a stub.
- Honest stubs: auth, AI, excise, worker, and integrations all throw or return 501 rather than pretending to work.

## 5. What is NOT protected today

- There is no authentication, no MFA, no sessions, no SSO.
- No route enforces a role or permission.
- No backups, monitoring, alerting, or incident response.
- No dependency scanning, no SBOM.
- No DPA, no subprocessor list, no retention/deletion implementation.
- No AI, so no AI-specific defences exist yet — they must be built with the assistant, not after it.
- **New scope, same rule:** no finance ledger, no tax filing path, no CRM, and no assistant tool exists yet — so T-13–T-16 have no code to attack and no code to defend. Each must ship with its controls in its first increment (balance/immutability/idempotency for the ledger; expert-reviewed rules and human-finalized working papers for tax; portal isolation tests for CRM; permission tiers, approval gates, and evaluation sets for the assistant). The directive's scope makes data residency (OD-9), DPA/subprocessor transparency, and retention/deletion load-bearing rather than optional — they gate the first assistant and finance increments, not the commercial launch.
