# packages/db — QualiOS database (scaffold)

PostgreSQL migrations in **plain SQL** (no ORM), a seed file, and a migrate/seed runner. Schema follows `QualiOS-Data-Model.md` (wedge entities).

## Migrations

| File                          | Contents                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `0001_tenancy.sql`            | Extension, `updated_at` trigger, organizations, sites, users, roles, memberships, RLS policies                       |
| `0002_products_inventory.sql` | Products, lots, batches, batch inputs, inventory locations, movement ledger, derived `inventory_positions` view, RLS |
| `0003_documents.sql`          | Documents, document versions, extractions, `inventory_movements.document_id` FK, RLS                                 |
| `0004_reconciliation.sql`     | Reconciliations, reconciliation lines, discrepancies (with state machines as enums), RLS                             |
| `0005_excise.sql`             | Versioned excise rules + excise calculations (working papers only — no filing), RLS                                  |
| `0006_listings.sql`           | Distributor listings + lines (blank-not-guessed rule), RLS                                                           |
| `0007_approvals_audit.sql`    | Approvals, append-only audit events (hash chain), AI interaction log, RLS                                            |

Every migration file has an `-- UP` section and a `-- DOWN` section (everything after a line that is exactly `-- DOWN`). The runner applies only the up part, in filename order, tracking applied files in `schema_migrations`.

Conventions (from the data model): UUID PKs, `organization_id` on every tenant record, `status`/`created_at`/`updated_at`/`created_by` on every record, soft deletion (`deleted_at`) on compliance records, money and quantities as **integer minor units** (cents, milligrams) — never floats. Row-level security policies use `current_setting('app.current_organization_id')` — application code must set it per session/transaction (ADR-004/ADR-008).

## Run

```bash
npm run migrate   # apply pending migrations (DATABASE_URL required)
npm run seed      # migrate + apply seeds/ (idempotent)
npm run typecheck
```

## Seed data

`seeds/0001_demo_org.sql` creates one **synthetic** demo tenant (fixed UUIDs matching the demo tenants in `apps/web`), a demo site/user/role, one demo product + lot + location. No real Herba Farms records. Real pilot data onboarding is a later sprint step and needs Devon's approval (sprint plan decision 4).
