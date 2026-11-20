-- 0009_imports.sql — Seed-to-sale file imports + reconciliation engine support
-- (Data Model §4, PRD FR-01 / FR-04, backlog Q-020 / Q-021 / Q-022)
--
-- Two import modes, and the distinction matters:
--   SNAPSHOT — the file is an external record set (a seed-to-sale export, a
--     paper count sheet, an allocation). Its rows are stored as import_rows
--     and are what a reconciliation run compares the ledger against. No
--     movements are written: writing the external system's numbers into our
--     ledger would erase the very variance a reconciliation is meant to find.
--   LEDGER — the file is a list of movements to record (e.g. migrating paper
--     records into QualiOS). Each accepted row writes one inventory_movement
--     and the import row points at it. Positions are still never edited
--     directly; they are derived from the ledger (migration 0002 view).
--
-- Reconciliation lines gain unit columns: the wedge tracks unit-counted
-- stock (pre-roll packs) as well as milligram stock, and a line that can
-- only hold milligrams would force unit counts into the wrong unit.
-- Discrepancies gain an `evidence` jsonb column holding both sides of the
-- comparison, so a discrepancy is self-explanatory without joining back
-- through its run.
-- UP

-- The data model's discrepancy state machine ends RESOLVED/EXPLAINED; the
-- scaffold's enum (0004) only carried RESOLVED. EXPLAINED is the terminal
-- state for a variance that is understood but not "fixed" (e.g. a count
-- explained by a known event). ADD VALUE cannot be used until after this
-- migration's transaction commits; nothing in this file uses it.
ALTER TYPE discrepancy_status ADD VALUE IF NOT EXISTS 'EXPLAINED';

CREATE TYPE import_kind AS ENUM ('SEED_TO_SALE', 'PAPER_COUNT', 'ALLOCATION');
CREATE TYPE import_mode AS ENUM ('SNAPSHOT', 'LEDGER');
CREATE TYPE import_status AS ENUM ('COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');
CREATE TYPE import_row_status AS ENUM ('ACCEPTED', 'REJECTED');

CREATE TABLE import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  site_id uuid REFERENCES sites (id),
  import_kind import_kind NOT NULL,
  import_mode import_mode NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  -- The field mapping actually used (file header -> canonical field), so an
  -- import is reproducible and auditable after the fact.
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  status import_status NOT NULL DEFAULT 'COMPLETED',
  rows_total integer NOT NULL DEFAULT 0,
  rows_accepted integer NOT NULL DEFAULT 0,
  rows_rejected integer NOT NULL DEFAULT 0,
  -- File-level failure reason (parse error, unmappable required columns).
  -- Per-row failures are recorded on import_rows instead.
  error text,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_runs_organization_id_idx ON import_runs (organization_id);
CREATE TRIGGER import_runs_updated_at
  BEFORE UPDATE ON import_runs
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_run_id uuid NOT NULL REFERENCES import_runs (id),
  -- 1-based data-row number in the source file (header row excluded).
  row_number integer NOT NULL,
  -- The row exactly as parsed (keys = file headers). Kept for audit: a
  -- rejected row is never silently dropped, and an accepted row can always
  -- be traced back to what the file said.
  raw_data jsonb NOT NULL,
  status import_row_status NOT NULL,
  -- Rejection reason, null when accepted.
  error text,
  -- The ledger movement this row created (LEDGER mode only).
  movement_id uuid REFERENCES inventory_movements (id),
  -- Business date the row records, when the file supplies one.
  recorded_date timestamptz,
  -- Parsed values (null when the row was rejected before parsing, or when
  -- the row carries no value in that dimension). The engine aggregates
  -- over these; raw_data stays the audit record of what the file said.
  lot_number text,
  quantity_mg integer,
  quantity_units integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_rows_import_run_id_idx ON import_rows (import_run_id);

-- A reconciliation run compares the ledger against one external record set:
-- the import run named here. The existing seed_to_sale_snapshot_id (a
-- document FK) is kept for a future document-linked snapshot.
ALTER TABLE reconciliations
  ADD COLUMN external_import_run_id uuid REFERENCES import_runs (id);

-- Unit-counted quantities on reconciliation lines (see header note).
ALTER TABLE reconciliation_lines
  ADD COLUMN seed_to_sale_qty_units integer,
  ADD COLUMN paper_record_qty_units integer,
  ADD COLUMN allocated_qty_units integer,
  ADD COLUMN produced_qty_units integer,
  ADD COLUMN variance_units integer;

-- Evidence (both sides of the comparison) and unit quantities on
-- discrepancies, so a discrepancy row stands on its own.
ALTER TABLE discrepancies
  ADD COLUMN evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN quantity_units integer;

ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY import_runs_tenant_isolation ON import_runs
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY import_rows_tenant_isolation ON import_rows
  USING (
    EXISTS (
      SELECT 1 FROM import_runs r
      WHERE r.id = import_rows.import_run_id
        AND r.organization_id = current_setting('app.current_organization_id', true)::uuid
    )
  );

-- DOWN
DROP POLICY IF EXISTS import_rows_tenant_isolation ON import_rows;
DROP POLICY IF EXISTS import_runs_tenant_isolation ON import_runs;
ALTER TABLE discrepancies DROP COLUMN IF EXISTS quantity_units;
ALTER TABLE discrepancies DROP COLUMN IF EXISTS evidence;
ALTER TABLE reconciliation_lines DROP COLUMN IF EXISTS variance_units;
ALTER TABLE reconciliation_lines DROP COLUMN IF EXISTS produced_qty_units;
ALTER TABLE reconciliation_lines DROP COLUMN IF EXISTS allocated_qty_units;
ALTER TABLE reconciliation_lines DROP COLUMN IF EXISTS paper_record_qty_units;
ALTER TABLE reconciliation_lines DROP COLUMN IF EXISTS seed_to_sale_qty_units;
ALTER TABLE reconciliations DROP COLUMN IF EXISTS external_import_run_id;
DROP TABLE IF EXISTS import_rows;
DROP TABLE IF EXISTS import_runs;
DROP TYPE IF EXISTS import_row_status;
DROP TYPE IF EXISTS import_status;
DROP TYPE IF EXISTS import_mode;
DROP TYPE IF EXISTS import_kind;
