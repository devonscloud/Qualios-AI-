-- 0002_products_inventory.sql — Products, lots, batches, inventory ledger (Data Model §2)
-- UP
CREATE TYPE product_category AS ENUM (
  'DRIED_FLOWER', 'PRE_ROLL', 'INFUSED_PRE_ROLL', 'EXTRACT', 'VAPE_CART', 'EDIBLE', 'OTHER'
);
CREATE TYPE strain_type AS ENUM ('INDICA', 'SATIVA', 'HYBRID', 'BLEND');
CREATE TYPE product_status AS ENUM ('ACTIVE', 'DISCONTINUED');
CREATE TYPE lot_status AS ENUM (
  'ACTIVE', 'QUARANTINE', 'RELEASED_FOR_SALE', 'AWAITING_DESTRUCTION', 'DESTROYED', 'CLOSED'
);
CREATE TYPE batch_status AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE stock_state AS ENUM ('BULK', 'PACKAGED', 'QUARANTINE', 'WASTE');
CREATE TYPE movement_type AS ENUM (
  'RECEIVE', 'TRANSFER_IN', 'TRANSFER_OUT', 'CONSUME', 'PRODUCE', 'PACKAGE',
  'ADJUST', 'DESTROY', 'SHIP', 'RETURN'
);
CREATE TYPE source_system AS ENUM ('SEED_TO_SALE', 'PAPER_RECORD', 'MANUAL', 'QUALIOS');

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name text NOT NULL,
  brand text,
  category product_category NOT NULL,
  format text,
  strain_type strain_type,
  thc_label_mg integer,
  thc_label_mg_per_g integer,
  -- GTINs stored as text to preserve leading zeros.
  gtin_upc text,
  gtin_scc text,
  case_size integer,
  status product_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX products_organization_id_idx ON products (organization_id);
CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  product_id uuid REFERENCES products (id),
  lot_number text NOT NULL,
  source_lot_number text,
  thc_tested_mg_per_g integer,
  thc_label_mg_per_g integer,
  status lot_status NOT NULL DEFAULT 'ACTIVE',
  approved_for_sale boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (organization_id, lot_number)
);
CREATE INDEX lots_organization_id_idx ON lots (organization_id);
CREATE INDEX lots_product_id_idx ON lots (product_id);
CREATE TRIGGER lots_updated_at
  BEFORE UPDATE ON lots
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  site_id uuid NOT NULL REFERENCES sites (id),
  output_lot_id uuid NOT NULL REFERENCES lots (id),
  output_product_id uuid NOT NULL REFERENCES products (id),
  -- Quantities in integer minor units (mg for flower/extracts).
  planned_quantity integer NOT NULL,
  produced_quantity integer,
  status batch_status NOT NULL DEFAULT 'PLANNED',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX batches_organization_id_idx ON batches (organization_id);
CREATE INDEX batches_output_lot_id_idx ON batches (output_lot_id);
CREATE TRIGGER batches_updated_at
  BEFORE UPDATE ON batches
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE batch_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches (id),
  input_lot_id uuid NOT NULL REFERENCES lots (id),
  quantity_mg integer NOT NULL,
  quantity_units integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, input_lot_id)
);
CREATE INDEX batch_inputs_batch_id_idx ON batch_inputs (batch_id);

CREATE TABLE inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  site_id uuid NOT NULL REFERENCES sites (id),
  name text NOT NULL,
  external_reference text,
  stock_state stock_state NOT NULL DEFAULT 'BULK',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX inventory_locations_organization_id_idx ON inventory_locations (organization_id);
CREATE INDEX inventory_locations_site_id_idx ON inventory_locations (site_id);
CREATE TRIGGER inventory_locations_updated_at
  BEFORE UPDATE ON inventory_locations
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  lot_id uuid NOT NULL REFERENCES lots (id),
  location_id uuid NOT NULL REFERENCES inventory_locations (id),
  movement_type movement_type NOT NULL,
  -- Signed: positive in, negative out. Integer minor units (mg).
  quantity_mg integer NOT NULL,
  quantity_units integer,
  source_system source_system NOT NULL,
  source_reference text,
  document_id uuid,
  recorded_at timestamptz NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  entered_by uuid REFERENCES users (id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_organization_id_idx ON inventory_movements (organization_id);
CREATE INDEX inventory_movements_lot_id_idx ON inventory_movements (lot_id);
CREATE INDEX inventory_movements_location_id_idx ON inventory_movements (location_id);
-- document_id FK is added in 0003 (documents table does not exist yet).
-- It is added there via ALTER TABLE to keep migration order simple.

-- Derived position: current quantity per (lot, location, stock_state), computed
-- from the movement ledger. Never stored as a separate mutable number, so the
-- ledger and the position cannot silently diverge (Data Model §2).
CREATE VIEW inventory_positions AS
SELECT
  m.organization_id,
  m.lot_id,
  m.location_id,
  l.stock_state,
  COALESCE(SUM(m.quantity_mg), 0)::bigint AS quantity_mg,
  COALESCE(SUM(m.quantity_units), 0)::bigint AS quantity_units
FROM inventory_movements m
JOIN inventory_locations l ON l.id = m.location_id
GROUP BY m.organization_id, m.lot_id, m.location_id, l.stock_state;

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY products_tenant_isolation ON products
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY lots_tenant_isolation ON lots
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY batches_tenant_isolation ON batches
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY batch_inputs_tenant_isolation ON batch_inputs
  USING (
    EXISTS (
      SELECT 1 FROM batches b
      WHERE b.id = batch_inputs.batch_id
        AND b.organization_id = current_setting('app.current_organization_id', true)::uuid
    )
  );
CREATE POLICY inventory_locations_tenant_isolation ON inventory_locations
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY inventory_movements_tenant_isolation ON inventory_movements
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);

-- DOWN
DROP POLICY IF EXISTS inventory_movements_tenant_isolation ON inventory_movements;
DROP POLICY IF EXISTS inventory_locations_tenant_isolation ON inventory_locations;
DROP POLICY IF EXISTS batch_inputs_tenant_isolation ON batch_inputs;
DROP POLICY IF EXISTS batches_tenant_isolation ON batches;
DROP POLICY IF EXISTS lots_tenant_isolation ON lots;
DROP POLICY IF EXISTS products_tenant_isolation ON products;
DROP VIEW IF EXISTS inventory_positions;
DROP TABLE IF EXISTS inventory_movements;
DROP TABLE IF EXISTS inventory_locations;
DROP TABLE IF EXISTS batch_inputs;
DROP TABLE IF EXISTS batches;
DROP TABLE IF EXISTS lots;
DROP TABLE IF EXISTS products;
DROP TYPE IF EXISTS source_system;
DROP TYPE IF EXISTS movement_type;
DROP TYPE IF EXISTS stock_state;
DROP TYPE IF EXISTS batch_status;
DROP TYPE IF EXISTS lot_status;
DROP TYPE IF EXISTS product_status;
DROP TYPE IF EXISTS strain_type;
DROP TYPE IF EXISTS product_category;
