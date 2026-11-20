# QualiOS AI — Integrated Domain Model

**Date:** 20 November 2026
**Status:** Implemented in code (migrations 0011–0012) and contracts (`@qualios/domain`).
**Governing plan:** Complete Master Blueprint v1.0 + ChatGPT Master Product Correction & Build Directive (20 Nov 2026).
**Rule:** this model is published **before** new isolated features are built. A follow-up worker builds the P1 traceability / finance / end-to-end flows on these contracts — it does not redesign them.

## 0. Positioning (non-negotiable)

QualiOS is a commercial, multi-tenant, quality-assurance AI business operating system for sale to the public, for every industry. Herba Farms is the **pilot customer only**. The core is industry-neutral; industry behaviour lives in **packs** (`packages/industry-packs`, `organization_packs`). Nothing in this model names a cannabis concept in the core: THC, strain, seed-to-sale, destruction states, and SK/MB listing forms are cannabis-pack data (migration 0011, audit §6A / B-110).

## 1. Universal entity relationship model

Conventions: every tenant table carries `organization_id` and an RLS tenant-isolation policy. Money is integer cents. Quantities are integer minor units (milligrams for mass, whole units for counted stock). `created_at` / `updated_at` are maintained by the `qualios_set_updated_at()` trigger. Soft delete is `deleted_at` where the table has one.

### 1.1 Tenancy & identity (migration 0001, unchanged)

```
organizations 1—* sites, users (via memberships), roles
organizations 1—* memberships (user, role, site?, status)
organizations 1—* organization_packs (pack_id, status)   [0011]
```

`organization_packs` records which industry packs a tenant has enabled. Pack surfaces in the API are gated on it (`apps/api/src/lib/packs.ts`, `requirePack`).

### 1.2 Products, lots, batches, inventory (migration 0002, neutralized by 0011)

```
products (id, organization_id, name, brand, format, gtin_upc, gtin_scc,
          case_size, category_key, taxonomy_pack_id, status)
  category_key       — pack-contributed taxonomy value (product_taxonomy)
  taxonomy_pack_id   — which pack contributed the value
lots (id, organization_id, product_id, lot_number, source_lot_number,
      status, approved_for_sale)
  status             — generic only: ACTIVE, QUARANTINE, RELEASED_FOR_SALE, CLOSED
batches (id, organization_id, site_id, output_lot_id, output_product_id,
         planned_quantity, produced_quantity, status, started_at, completed_at)
batch_inputs (batch_id, input_lot_id, quantity_mg, quantity_units)
inventory_locations (id, organization_id, site_id, name, external_reference, stock_state)
inventory_movements (id, organization_id, lot_id, location_id, movement_type,
                     quantity_mg, quantity_units, source_system,
                     source_system_detail, source_reference, document_id,
                     recorded_at, entered_by, note)
  source_system        — generic: EXTERNAL_SYSTEM, PAPER_RECORD, MANUAL, QUALIOS
  source_system_detail — pack-registered source value (e.g. SEED_TO_SALE)
inventory_positions  — VIEW: derived from the movement ledger, never stored
```

Pack extension tables (0011) — the core never reads these keys:

```
product_taxonomy (pack_id, taxonomy_key, label, parent_key, sort_order)
listing_types (pack_id, type_key, label, description)
product_attributes (organization_id, product_id, pack_id, attribute_key,
                    value_text, value_int, value_numeric)
lot_attributes (organization_id, lot_id, pack_id, attribute_key, ...)
lot_dispositions (organization_id, lot_id, pack_id, disposition_key,
                  status, note, created_by)
```

### 1.3 Traceability (migration 0012, new)

```
traceability_links (id, organization_id, parent_lot_id, child_lot_id,
                    link_type, batch_id, quantity_mg, quantity_units,
                    note, created_by, created_at)
  link_type — CONSUMED_IN, PRODUCED_FROM, PACKAGED_FROM, SPLIT_FROM,
              MERGED_INTO, SHIPPED_AS, RECEIVED_AS
  UNIQUE (organization_id, parent_lot_id, child_lot_id, link_type)
  CHECK (parent_lot_id <> child_lot_id)
```

Direction is always **parent → child**: the parent lot was consumed, split, or transformed to produce the child. `batch_inputs` already records what went into a batch; `traceability_links` is the queryable genealogy across batches, packaging, splits, merges, and shipments — including links with no batch at all. A link that would create a cycle is refused at creation (`validateTraceLinks` in `@qualios/domain`, enforced again against stored links in `lib/traceability.ts`).

### 1.4 Documents, SOPs, training (migrations 0003, 0010, unchanged)

```
documents (id, organization_id, document_type, status, linked_lot_id,
           linked_batch_id, effective_version_id, effective_from,
           published_at, published_by, ...)
document_versions (document_id, version_number, storage_key, sha256, ...)
training_assignments (document_id, version_number, assignee_id, assigned_by,
                      due_at, status, completed_at, verified_by, verified_at)
training_completions (assignment_id, user_id, acknowledgement,
                      assessment_score, completed_at)
approvals (target_type, target_id, action, decision, actor_id, note)
audit_events (organization_id, seq, event_type, actor_id, target_type,
              target_id, payload, previous_hash, event_hash)  — hash-chained, append-only
```

### 1.5 Reconciliation (migrations 0004, 0009, neutralized by 0011)

```
import_runs (id, organization_id, site_id, import_kind, import_mode,
             external_source, file_name, mime_type, sha256, storage_key,
             mapping, status, rows_total, rows_accepted, rows_rejected, error)
  import_kind     — generic: EXTERNAL_SNAPSHOT, PAPER_COUNT, ALLOCATION
  external_source — pack-registered source system (e.g. SEED_TO_SALE)
import_rows (import_run_id, row_number, raw_data, status, error,
             movement_id, recorded_date, lot_number, quantity_mg, quantity_units)
reconciliations (id, organization_id, site_id, scope_type, scope_reference,
                 status, summary, external_snapshot_document_id,
                 external_import_run_id, run_by, started_at, completed_at)
reconciliation_lines (reconciliation_id, lot_id, product_id,
                      external_qty_mg, external_qty_units,
                      paper_record_qty_mg, paper_record_qty_units,
                      allocated_qty_mg, allocated_qty_units,
                      produced_qty_mg, produced_qty_units,
                      variance_mg, variance_units, match_status, discrepancy_id)
discrepancies (id, organization_id, reconciliation_id, lot_id, product_id,
               discrepancy_type, severity, description, quantity_mg,
               quantity_units, status, owner_id, resolution_note,
               resolved_by, approved_by, evidence, opened_at, closed_at)
```

The engine's generic pattern — internal ledger vs an external record set — stays in the core. Seed-to-sale file formats and mappings belong to the cannabis pack.

### 1.6 Financial ledger (migration 0012, new)

```
gl_accounts (id, organization_id, code, name, account_type, parent_account_id, status)
  account_type — ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE
  UNIQUE (organization_id, code)
journal_entries (id, organization_id, entry_date, source_module, source_type,
                 source_id, idempotency_key, memo, status, posted_at, created_by)
  status — DRAFT, POSTED, VOID
  UNIQUE (organization_id, idempotency_key)
  UNIQUE (organization_id, source_module, source_type, source_id)
journal_lines (id, journal_entry_id, account_id, debit_cents, credit_cents,
               lot_id, product_id, memo)
  CHECK (debit_cents >= 0 AND credit_cents >= 0)
  CHECK (NOT (debit_cents > 0 AND credit_cents > 0))   — one side per line
inventory_valuations (id, organization_id, lot_id, valuation_method,
                      unit_cost_cents, total_cents, as_of, journal_entry_id, created_by)
  valuation_method — FIFO, AVERAGE, STANDARD, ACTUAL
  UNIQUE (organization_id, lot_id, valuation_method, as_of)
```

**Ledger rules (enforced in `@qualios/domain` validation, `lib/ledger.ts`, and database triggers):**

1. **Balanced entries.** Total debits equal total credits, every line carries exactly one side, no negative amounts, at least one line. The API validates first; the `qualios_journal_entry_must_balance()` trigger re-checks when an entry is posted, so no caller can post an unbalanced entry.
2. **Idempotent posting.** The idempotency key is `source_module:source_type:source_id`. Replaying the same source returns the original entry instead of double-posting.
3. **No duplicate entry across modules.** The unique `(organization, source_module, source_type, source_id)` index guarantees one source record posts at most one entry per module. Different modules posting about the same business event must reference the same source triple — or be separate entries with their own source records.
4. **Posted entries are immutable.** The `qualios_journal_lines_immutable_when_posted()` trigger refuses any insert/update/delete on a POSTED entry's lines. Corrections post a new (reversing) entry; they never edit history.
5. **One source of truth per fact.** Inventory positions are derived from the movement ledger (never stored). Valuations and tax calculations point at the journal entry that booked them (`journal_entry_id`), they do not duplicate its amounts.

### 1.7 Tax (migration 0012 generic engine; migration 0005 cannabis-pack tables)

```
tax_rules (id, jurisdiction, tax_type, basis, rate_numeric, rate_unit,
           flat_amount_cents, effective_from, effective_to, pack_id,
           reviewed_by, reviewed_at, status)
  tax_type — GST, HST, VAT, SALES_TAX, EXCISE, OTHER
  basis    — pack-registered key (PER_UNIT, AD_VALOREM, PER_LITRE, PER_KG,
             PER_MG_THC, ...). No basis is hard-coded as universal.
  status   — DRAFT, ACTIVE, SUPERSEDED
tax_calculations (id, organization_id, tax_rule_id, subject_type, subject_id,
                  jurisdiction, basis_snapshot, taxable_amount_cents,
                  tax_amount_cents, calculated_by, calculated_at, status,
                  journal_entry_id)
  status — DRAFT, FINAL
```

`tax_rules` is shared reference configuration (no RLS), like `excise_rules`. The cannabis pack's `excise_rules` / `excise_calculations` (migration 0005) are pack-owned tables (`pack_id = 'cannabis-ca'`); the generic engine above is the core's tax model. **No calculation is offered until a domain expert reviews the rules (ADR D-07)** — the engine is schema and contract only until then.

### 1.8 Listings (migration 0006, neutralized by 0011)

```
distributor_listings (id, organization_id, listing_type, pack_id, period,
                      status, document_id, generated_by, approved_by)
  listing_type — pack-configured text (listing_types table), not a core enum
listing_lines (listing_id, product_id, lot_id, quantity_units, price_cents,
               case_size, source)
```

### 1.9 Entity relationship summary (text diagram)

```
organizations ──< sites ──< inventory_locations ──< inventory_movements >── lots
organizations ──< products ──< lots ──< traceability_links (parent/child)
lots ──< batches (output) ──< batch_inputs >── lots (inputs)
lots ──< inventory_movements, lot_attributes, lot_dispositions
organizations ──< documents ──< document_versions; documents ──< training_assignments ──< training_completions
organizations ──< import_runs ──< import_rows; import_runs ──< reconciliations ──< reconciliation_lines, discrepancies
organizations ──< gl_accounts ──< journal_lines >── journal_entries
organizations ──< inventory_valuations ── journal_entries
organizations ──< tax_calculations >── tax_rules; tax_calculations ── journal_entries
organizations ──< distributor_listings ──< listing_lines
organizations ──< organization_packs (pack enablement)
organizations ──< audit_events (hash-chained, append-only)
```

Cross-module links are shared IDs, never duplicated records: a journal line may reference a lot/product; a tax calculation references its rule and its entry; a valuation references its lot and its entry; a document may link a lot/batch; an import row may point at the movement it created.

## 2. Event flows

### 2.1 Universal traceability chain (directive §3)

```
supplier → purchasing → receiving → raw material → inventory
  → production → inspection / lab → finished goods → packaging
  → warehousing → shipment → customer → sales / accounting / tax → recall
```

Each stage transition is recorded as one or more of: an `inventory_movements` row (quantity + location + source), a `traceability_links` row (genealogy), a `batches` / `batch_inputs` row (production), a `documents` row (evidence: COA, packing slip, invoice), and — where money moves — a `journal_entries` row (see §2.2). No stage re-enters data another stage already holds: the lot id is the shared key, and quantities are derived from the movement ledger.

**Backward trace** (recall: "where did this lot come from?") follows `traceability_links` child → parent to the raw-material / supplier lots. **Forward trace** ("where did this lot go?") follows parent → child to finished goods, shipments, and customers. Both are recursive queries in `lib/traceability.ts`, depth-capped at 50 as a backstop (cycles are refused at creation).

Industry wordings differ by pack (seed-to-sale, farm-to-table, ingredient-to-batch-to-distribution, raw-material-to-finished-assembly) — the chain and the tables do not.

### 2.2 Finance posting flow (P1 builds the routes; the helper exists now)

```
supplier receipt / invoice
  → inventory valuation (inventory_valuations, method FIFO/AVERAGE/...)
  → AP + inventory (journal entry: Dr Inventory / Cr Accounts Payable)
production consumption
  → COGS (journal entry: Dr COGS / Cr Inventory; lot_id on the lines)
sales invoice
  → AR + revenue (journal entry: Dr Accounts Receivable / Cr Revenue)
  → tax (tax_calculations → journal entry: Dr Tax Payable / Cr Cash on payment)
```

Each step posts through `postJournalEntry` (`lib/ledger.ts`): validate balanced → check the idempotency key → insert DRAFT + lines → flip to POSTED in the same transaction. The same source record replayed (retry, duplicate webhook, double-click) returns the original entry.

### 2.3 Quality flow (implemented)

Upload document → new version → review (approve/reject, segregation of duties: reviewer ≠ uploader) → publish effective version (SOP) → assign training on that version → employee completes (acknowledgement / assessment) → manager verifies → every step lands in the hash-chained audit log. See `docs/architecture/DATA_MODEL.md` §3–§4.

### 2.4 Reconciliation flow (implemented, cannabis-pack surface)

Upload external record file (snapshot/ledger) → import rows recorded (accepted/rejected, never silently dropped) → create DRAFT reconciliation (scope + external import run) → run engine (ledger vs external set, lot by lot) → lines + OPEN discrepancies with evidence → human resolve (propose) → second-person approve (segregation of duties) → close. Nothing auto-resolves; a clean run still needs a human to close it.

### 2.5 Tax flow (schema + contract; calculation stubbed until expert review)

Register a versioned rule (`tax_rules`, pack-registered basis, effective dates, reviewer) → calculate against a subject (lot / invoice / shipment) → `tax_calculations` (DRAFT) → qualified review → FINAL → post to the ledger (`journal_entry_id`) → filing preparation with evidence. The cannabis `PER_MG_THC` basis is one registered basis; other packs register their own.

## 3. Ledger rules (normative)

See §1.6 rules 1–5. In short: balanced, idempotent, no duplicates across modules, posted entries immutable, one source of truth per fact. Any future posting path (routes, workers, imports) must go through `postJournalEntry` or replicate its checks — never insert into `journal_entries` / `journal_lines` directly.

## 4. API contracts

Contracts are versioned (`/api/v1/...`). The traceability routes are implemented now, mounted unversioned as `/api/traceability/*` for consistency with the existing routes; the P1 worker moves the versioned paths into place (or mounts both — the contract below is the target). Finance posting exists as a library helper (`lib/ledger.ts`); its routes land with P1. Tax calculation and the assistant are stubs until expert review / provider selection.

### 4.1 Traceability — implemented

| Method | Path                                        | Request                | Response                                     | Errors                                                                |
| ------ | ------------------------------------------- | ---------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| POST   | `/api/v1/traceability/links`                | `CreateTraceLinkInput` | `{ link: TraceabilityLink }`                 | `VALIDATION_ERROR`, `LOT_NOT_FOUND`, `BATCH_NOT_FOUND`, `TRACE_CYCLE` |
| GET    | `/api/v1/traceability/lots/:lotId/backward` | —                      | `TraceResult` (ancestors, depth 0 = the lot) | `LOT_NOT_FOUND`                                                       |
| GET    | `/api/v1/traceability/lots/:lotId/forward`  | —                      | `TraceResult` (descendants)                  | `LOT_NOT_FOUND`                                                       |
| GET    | `/api/v1/traceability/lots/:lotId/links`    | —                      | `{ lot_id, links: TraceabilityLink[] }`      | `LOT_NOT_FOUND`                                                       |

`CreateTraceLinkInput`: `{ parentLotId, childLotId, linkType, batchId?, quantityMg?, quantityUnits?, note? }`. `linkType` is one of `CONSUMED_IN, PRODUCED_FROM, PACKAGED_FROM, SPLIT_FROM, MERGED_INTO, SHIPPED_AS, RECEIVED_AS`. All routes are tenant-scoped and membership-checked on write; traceability is core (no pack gate).

### 4.2 Quality — implemented (existing routes)

| Method   | Path                                                                                                          | Notes                                              |
| -------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| POST/GET | `/api/documents`, `/api/documents/:id/review`, `/api/documents/:id/publish`                                   | Upload, version, review, publish effective version |
| POST/GET | `/api/training/assignments`, `/api/training/assignments/:id/complete`, `/api/training/assignments/:id/verify` | Assign, complete, verify                           |
| GET      | `/api/audit-events`, `/api/audit-events/:id`                                                                  | Hash-chained audit trail (export is a P1 item)     |

### 4.3 Financial ledgers — helper implemented, routes P1

| Method | Path                                   | Request             | Response                                      | Errors                                                      |
| ------ | -------------------------------------- | ------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/v1/finance/journal-entries`      | `JournalEntryInput` | `{ entry: JournalEntry, duplicate: boolean }` | `VALIDATION_ERROR`, `UNBALANCED_ENTRY`, `ACCOUNT_NOT_FOUND` |
| GET    | `/api/v1/finance/accounts`             | —                   | `{ accounts: GlAccount[] }`                   | —                                                           |
| GET    | `/api/v1/finance/inventory-valuations` | `?lot_id=`          | `{ valuations: InventoryValuation[] }`        | —                                                           |

`JournalEntryInput`: `{ entryDate, sourceModule, sourceType, sourceId, memo?, lines: [{ accountId, debitCents, creditCents, lotId?, productId?, memo? }] }`. The response's `duplicate: true` means the source was already posted — the returned entry is the original, not a second posting.

### 4.4 Tax — contract only (stub until expert review)

| Method | Path                    | Request                               | Response                          | Errors            |
| ------ | ----------------------- | ------------------------------------- | --------------------------------- | ----------------- |
| GET    | `/api/v1/tax/rules`     | `?jurisdiction=&tax_type=`            | `{ rules: TaxRule[] }`            | —                 |
| POST   | `/api/v1/tax/calculate` | `{ ruleId, subjectType, subjectId? }` | `{ calculation: TaxCalculation }` | `NOT_IMPLEMENTED` |

A calculation must cite the rule version and effective dates it used (`basis_snapshot`); a rule with no reviewer (`reviewed_by` null) must never produce a FINAL calculation.

### 4.5 Assistant — contract only (read-only first)

| Method | Path                    | Request                 | Response                 | Errors            |
| ------ | ----------------------- | ----------------------- | ------------------------ | ----------------- |
| POST   | `/api/v1/assistant/ask` | `AssistantQueryRequest` | `AssistantQueryResponse` | `NOT_IMPLEMENTED` |

`AssistantQueryRequest`: `{ question, scope? }` (`scope`: `sop | lot | finance | tax | training`). `AssistantQueryResponse`: `{ answer, citations: [{ kind, reference, excerpt }], confidence: 0–1, unanswered: boolean }`. Rules: retrieval is tenant-scoped and permission-checked before retrieval; every factual claim carries a citation to a document version or record; below the confidence threshold the assistant says it does not know; it never claims compliance without verified sources.

Actions are **proposals, not executions** (`AssistantActionProposal`: `{ tool, arguments, status: PROPOSED | APPROVED | REJECTED | EXECUTED | FAILED, approvedBy, result }`). Financial transactions, regulated releases, electronic signatures, and filings require an explicit human approval record before the action runs; every proposal, approval, and outcome is logged.

## 5. Industry packs (B-110)

A pack contributes, without core code changes: taxonomy values, listing types, tax bases, lot dispositions, import header aliases, product attribute keys, and source systems (`@qualios/industry-packs`). Registered packs: `cannabis-ca` (IN_PROGRESS), `food-ca` (IN_PROGRESS), `industrial-generic` (STUB). Tenants enable packs in `organization_packs`; pack surfaces (imports, reconciliations, discrepancies, excise) are gated by `requirePack` and answer `403 PACK_NOT_ENABLED` otherwise. The core must never gain an industry-specific column or enum again — new industry behaviour goes in a pack (extension tables + registry), and the change is rejected in review if it does not.

## 6. What is NOT built (honest status)

- Finance routes (journal entry posting API, accounts UI, valuations UI) — helper + schema + contract only; P1.
- Tax calculation engine — schema + contract only; needs domain-expert review (ADR D-07).
- Assistant (retrieval, citations, actions) — contract only; needs provider selection and the read-only build (P1).
- Traceability UI, recall workflow, mock recalls — P1.
- Versioned `/api/v1/...` mounting — contract target; current routes are unversioned `/api/...`.
- Billing, public site, mobile, real auth — separate P0/P1 work (see `docs/architecture/DECISIONS.md` open decisions; do not build here).

## 7. Handoff: exact next implementable tasks (for the P1 worker)

1. **Traceability proof of concept** on this model: receive a lot → consume in a batch → finish goods → ship → trace backward/forward; connect the links to the reconciliation engine (a link's quantities vs the movement ledger). Add the trace UI. Tests: the existing `packs-traceability-ledger.test.ts` suite is the base — extend it, do not replace it.
2. **Finance posting prototype**: mount `POST /api/v1/finance/journal-entries` (and the GET routes in §4.3) on `postJournalEntry`; wire supplier receipt/invoice → inventory valuation/AP → production consumption/COGS → sales invoice/AR with balanced entries, using the idempotency keys in §1.6. Do not add a second posting path.
3. **End-to-end flow**: register company → upload/version/approve SOP → assign training → complete/verify → export audit evidence, across two tenants (Herba + Prairie Foods) to prove tenant isolation on the new tables.
4. **Tax rules admin (read-only first)**: `GET /api/v1/tax/rules` over `tax_rules`; keep `calculate` stubbed until a domain expert reviews a rule.
5. **Assistant read-only**: permission-scoped retrieval over documents/records with citations per §4.5; no action tools until the approval flow in §4.5 exists.
