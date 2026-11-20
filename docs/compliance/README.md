# docs/compliance

Compliance notes for QualiOS AI.

- `SECURITY.md` — security posture: standing rules, the 12 threats (T-01–T-12) carried forward from the old threat model and restated for the universal platform, the security program target, and what is and is not protected today.

Standing rules (blueprint §7, §10; ADR-012):

- AI assists, detects, drafts, and recommends. Regulated releases, formal signatures, legal filings, and professional attestations require authorized human approval. There is no code path that posts a correction, files anything, releases a batch, or signs on a person's behalf without a human approval event.
- AI answers about company records must include verifiable sources or explicitly say evidence is insufficient.
- Excise/tax rules are configuration supplied by the relevant industry/jurisdiction pack and reviewed by a domain expert / accountant before use. The platform calculates working papers; it does not file.
- Every critical write and approval generates a searchable, attributable, immutable audit event.
- Tenant data is never exposed across organizations (ADR-008).
- Regulatory mappings are pack content: a cannabis mapping never applies to a food tenant, and no pack's rules are treated as universal.

This folder holds compliance notes and validation records as they are produced. Nothing here is legal advice or a compliance guarantee. The current-state audit (`QualiOS-Current-State-Audit-2026-11-20.md`, in the project workspace `files/`) is the evidence base.
