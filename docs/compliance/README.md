# docs/compliance

Compliance notes for QualiOS AI.

Standing rules (blueprint §7, §10; ADR-012):

- AI assists, detects, drafts, and recommends. Regulated releases, formal signatures, legal filings, and professional attestations require authorized human approval. There is no code path that posts a correction, files anything, releases a batch, or signs on a person's behalf without a human approval event.
- AI answers about company records must include verifiable sources or explicitly say evidence is insufficient.
- Excise rules are configuration reviewed by a domain expert / accountant before use. The wedge calculates working papers; it does not file.
- Every critical write and approval generates a searchable, attributable, immutable audit event.
- Tenant data is never exposed across organizations (ADR-008).

This folder holds compliance notes and validation records as they are produced. Nothing here is legal advice or a compliance guarantee.
