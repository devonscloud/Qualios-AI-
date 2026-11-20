-- 0004_reconciliation.sql — Reconciliations, lines, discrepancies (Data Model §4)
-- UP
CREATE TYPE reconciliation_scope_type AS ENUM ('LOT', 'PRODUCT', 'SITE', 'DATE_RANGE');
-- DRAFT → RUNNING → REVIEW → RESOLUTION_PENDING → APPROVED → CLOSED
CREATE TYPE reconciliation_status AS ENUM (
  'DRAFT', 'RUNNING', 'REVIEW', 'RESOLUTION_PENDING', 'APPROVED', 'CLOSED'
);
CREATE TYPE match_status AS ENUM ('MATCH', 'VARIANCE', 'MISSING_SOURCE');
CREATE TYPE discrepancy_type AS ENUM (
  'PHANTOM_STOCK', 'SHORTAGE', 'UNALLOCATED_PRODUCTION', 'LOT_MISMATCH',
  'BULK_VS_PACKAGED', 'UNEXPLAINED_MOVEMENT'
);
CREATE TYPE discrepancy_severity AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
-- OPEN → INVESTIGATING → RESOLUTION_PROPOSED → RESOLVED → CLOSED; ESCALATED at any point.
CREATE TYPE discrepancy_status AS ENUM (
  'OPEN', 'INVESTIGATING', 'RESOLUTION_PROPOSED', 'RESOLVED', 'ESCALATED', 'CLOSED'
);

CREATE TABLE reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  site_id uuid REFERENCES sites (id),
  scope_type reconciliation_scope_type NOT NULL,
  scope_reference text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  run_by uuid NOT NULL REFERENCES users (id),
  status reconciliation_status NOT NULL DEFAULT 'DRAFT',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  seed_to_sale_snapshot_id uuid REFERENCES documents (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX reconciliations_organization_id_idx ON reconciliations (organization_id);
CREATE TRIGGER reconciliations_updated_at
  BEFORE UPDATE ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE reconciliation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id uuid NOT NULL REFERENCES reconciliations (id),
  lot_id uuid REFERENCES lots (id),
  product_id uuid REFERENCES products (id),
  seed_to_sale_qty_mg integer,
  paper_record_qty_mg integer,
  allocated_qty_mg integer,
  produced_qty_mg integer,
  variance_mg integer,
  match_status match_status NOT NULL,
  discrepancy_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_lines_reconciliation_id_idx ON reconciliation_lines (reconciliation_id);
-- discrepancy_id FK is added below (discrepancies table does not exist yet).

CREATE TABLE discrepancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  reconciliation_id uuid REFERENCES reconciliations (id),
  lot_id uuid REFERENCES lots (id),
  product_id uuid REFERENCES products (id),
  discrepancy_type discrepancy_type NOT NULL,
  severity discrepancy_severity NOT NULL DEFAULT 'MEDIUM',
  description text NOT NULL,
  quantity_mg integer,
  status discrepancy_status NOT NULL DEFAULT 'OPEN',
  owner_id uuid REFERENCES users (id),
  resolution_note text,
  resolved_by uuid REFERENCES users (id),
  approved_by uuid REFERENCES users (id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX discrepancies_organization_id_idx ON discrepancies (organization_id);
CREATE INDEX discrepancies_reconciliation_id_idx ON discrepancies (reconciliation_id);
CREATE INDEX discrepancies_lot_id_idx ON discrepancies (lot_id);
CREATE INDEX discrepancies_status_idx ON discrepancies (status);
CREATE TRIGGER discrepancies_updated_at
  BEFORE UPDATE ON discrepancies
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

ALTER TABLE reconciliation_lines
  ADD CONSTRAINT reconciliation_lines_discrepancy_id_fk
  FOREIGN KEY (discrepancy_id) REFERENCES discrepancies (id);

ALTER TABLE reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE discrepancies ENABLE ROW LEVEL SECURITY;

CREATE POLICY reconciliations_tenant_isolation ON reconciliations
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY reconciliation_lines_tenant_isolation ON reconciliation_lines
  USING (
    EXISTS (
      SELECT 1 FROM reconciliations r
      WHERE r.id = reconciliation_lines.reconciliation_id
        AND r.organization_id = current_setting('app.current_organization_id', true)::uuid
    )
  );
CREATE POLICY discrepancies_tenant_isolation ON discrepancies
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);

-- DOWN
DROP POLICY IF EXISTS discrepancies_tenant_isolation ON discrepancies;
DROP POLICY IF EXISTS reconciliation_lines_tenant_isolation ON reconciliation_lines;
DROP POLICY IF EXISTS reconciliations_tenant_isolation ON reconciliations;
ALTER TABLE reconciliation_lines DROP CONSTRAINT IF EXISTS reconciliation_lines_discrepancy_id_fk;
DROP TABLE IF EXISTS discrepancies;
DROP TABLE IF EXISTS reconciliation_lines;
DROP TABLE IF EXISTS reconciliations;
DROP TYPE IF EXISTS discrepancy_status;
DROP TYPE IF EXISTS discrepancy_severity;
DROP TYPE IF EXISTS discrepancy_type;
DROP TYPE IF EXISTS match_status;
DROP TYPE IF EXISTS reconciliation_status;
DROP TYPE IF EXISTS reconciliation_scope_type;
