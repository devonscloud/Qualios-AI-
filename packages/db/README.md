# packages/db — QualiOS database (scaffold)

PostgreSQL migrations in **plain SQL** (no ORM), a seed file, and a migrate/seed runner. Schema follows `QualiOS-Data-Model.md` (wedge entities).

## Migrations

| File                          | Contents                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_tenancy.sql`            | Extension, `updated_at` trigger, organizations, sites, users, roles, memberships, RLS policies                                        |
| `0002_products_inventory.sql` | Products, lots, batches, batch inputs, inventory locations, movement ledger, derived `inventory_positions` view, RLS                  |
| `0003_documents.sql`          | Documents, document versions, extractions, `inventory_movements.document_id` FK, RLS                                                  |
| `0004_reconciliation.sql`     | Reconciliations, reconciliation lines, discrepancies (with state machines as enums), RLS                                              |
| `0005_excise.sql`             | Versioned excise rules + excise calculations (working papers only — no filing), RLS                                                   |
| `0006_listings.sql`           | Distributor listings + lines (blank-not-guessed rule), RLS                                                                            |
| `0007_approvals_audit.sql`    | Approvals, append-only audit events (hash chain), AI interaction log, RLS                                                             |
| `0008_audit_chain.sql`        | Audit hash-chain hardening: `event_hash` + `seq` on audit_events, append-only UPDATE/DELETE triggers, `DOCUMENT_REVIEW` approval type |

Every migration file has an `-- UP` section and a `-- DOWN` section (everything after a line that is exactly `-- DOWN`). The runner applies only the up part, in filename order, tracking applied files in `schema_migrations`. Static structural checks live in `scripts/validate-migrations.mjs` (`npm run validate`); they run against the file list, so a new migration must be added to its EXPECTED map.

## Audit-event hash chain (migration 0008)

Every audit event carries `previous_hash` (the previous event's `event_hash` in the same organization, NULL for the first) and `event_hash` (SHA-256 of the canonical JSON of the event content, including `previous_hash`). `seq` is an identity column giving the strict insertion order used for verification. The application computes the hash at insert time (`src/audit.ts` — `recordAuditEvent`, called inside the same transaction as the write it records, under a per-organization advisory lock so concurrent appends cannot share a `previous_hash`).

Two layers protect the log:

1. **Database:** BEFORE UPDATE/DELETE triggers on `audit_events` raise an exception. (TRUNCATE is not blocked by a trigger — restricting TRUNCATE needs a separate privilege control on the app role; in local dev the role is a superuser, so this is a production-hardening item, not a claim.)
2. **Hash chain:** even a writer with direct database access who inserts a forged event cannot make it link correctly without reproducing the canonical hash — and verification detects it.

Verify the chain at any time:

```bash
DATABASE_URL=postgres://qualios:qualios@localhost:5432/qualios_dev npm run audit:verify
# AUDIT CHAIN OK — N event(s) across M organization(s); ...
# or, on the first broken event:
# AUDIT CHAIN BROKEN at event <id> (organization <org>, seq <seq>): <reason>
```

Limits: the payload is stored as jsonb, so values must survive a jsonb round-trip unchanged (plain JSON data only — no numbers beyond 2^53). The advisory lock key is a 64-bit hash of the organization UUID; a collision would only serialize two unrelated organizations.

Conventions (from the data model): UUID PKs, `organization_id` on every tenant record, `status`/`created_at`/`updated_at`/`created_by` on every record, soft deletion (`deleted_at`) on compliance records, money and quantities as **integer minor units** (cents, milligrams) — never floats. Row-level security policies use `current_setting('app.current_organization_id')` — application code must set it per session/transaction (ADR-004/ADR-008).

## Run

```bash
npm run migrate   # apply pending migrations (DATABASE_URL required)
npm run seed      # migrate + apply seeds/ (idempotent)
npm run typecheck
npm run validate  # static migration checks (scripts/validate-migrations.mjs)
npm run audit:verify  # recompute the audit hash chain (DATABASE_URL required)
```

## Row-level security — local dev caveat

RLS policies use `current_setting('app.current_organization_id')` — application code must set it per session/transaction (ADR-004/ADR-008). The API does this in `apps/api/src/lib/db.ts` (`withTenant`, via `set_config(..., true)`).

**Local dev caveat:** the local database role (`qualios`) is a superuser and owns the tables. PostgreSQL does not apply RLS to table owners or superusers, so in local dev RLS is not the enforcement that bites — application-layer scoping (every query filters by `organization_id`) is. RLS was verified for a non-superuser, non-owner role against a scratch database (see the Days 12–18 build notes): with the setting applied, a non-owner role sees only its own organization's rows, and cross-tenant INSERTs are blocked by the policy. Production must connect as a non-superuser, non-owner app role (and use FORCE RLS on tenant tables) for layer 2 to hold.

## Seed data

`seeds/0001_demo_org.sql` creates one **synthetic** demo tenant (fixed UUIDs matching the demo tenants in `apps/web`), a demo site, two demo users (Ops uploader `demo.ops@qualios.example` and QA approver `demo.qa@qualios.example`) with their roles/memberships, one demo product + lot + location. No real Herba Farms records. Real pilot data onboarding is a later sprint step and needs Devon's approval (sprint plan decision 4).
