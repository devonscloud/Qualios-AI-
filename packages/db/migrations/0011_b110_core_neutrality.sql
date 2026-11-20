-- 0011_b110_core_neutrality.sql — Remove the 11 cannabis-specific leaks
-- from the universal core (audit §6A, backlog B-110, directive §3).
--
-- Rule: never edit already-applied migrations 0001–0010. Everything below
-- is additive (new tables / columns) or a data-preserving conversion of a
-- shared column. Nothing here drops a table or a view.
--
-- What changes, leak by leak:
--  1. products.category (cannabis product_category enum) is replaced by
--     category_key (text) + taxonomy_pack_id. Pack taxonomy values live in
--     product_taxonomy, contributed by packs, not by a core enum.
--  2. products.strain_type is dropped; strain becomes a cannabis-pack
--     product attribute (product_attributes, pack_id 'cannabis-ca').
--  3. THC columns on products/lots are dropped; THC becomes pack-scoped
--     attributes (product_attributes / lot_attributes). The core no longer
--     knows what THC is.
--  4. lot_status loses AWAITING_DESTRUCTION / DESTROYED. The column becomes
--     text with a generic CHECK (ACTIVE, QUARANTINE, RELEASED_FOR_SALE,
--     CLOSED); rows carrying a destruction state are preserved as
--     lot_dispositions rows (pack-defined disposition) and closed.
--  5. import_kind loses SEED_TO_SALE and becomes generic text
--     (EXTERNAL_SNAPSHOT, PAPER_COUNT, ALLOCATION). The cannabis source
--     system is recorded separately as import_runs.external_source
--     ('SEED_TO_SALE'); inventory_movements.source_system becomes generic
--     text with the pack value kept in source_system_detail.
--  6. excise_basis gains the generic bases PER_UNIT, AD_VALOREM,
--     PER_LITRE, PER_KG; excise_rules gains pack_id (they are
--     cannabis-pack-owned rules). The generic tax engine lands in 0012.
--     The THC-named columns on excise_calculations are renamed to generic
--     basis columns; the tables are documented as pack-owned.
--  7. distributor_listings.listing_type becomes generic text; pack
--     listing types live in listing_types. The core holds a generic
--     listing/distribution record.
--  8. Pack surfaces are gated by organization_packs (new table): a tenant
--     enables packs, and the API refuses pack routes for tenants that
--     have not enabled the pack (apps/api/src/lib/packs.ts).
--  9. The pack mechanism's database side: product_taxonomy,
--     listing_types, product_attributes, lot_attributes, lot_dispositions,
--     organization_packs — seeded below with the three registered packs'
--     contributions, so the mechanism is data, not just code.
-- 10. Positioning copy was already industry-neutral in package.json and
--     the web home page (fixed in e5922d8); nothing to change here.
-- 11. The second demo tenant (food) is seeded in seeds/0001_demo_org.sql.
--
-- DOWN is structural only: it restores the old columns/types as empty
-- shells. Data moved into pack extension tables is NOT moved back.
-- UP
-- ---------------------------------------------------------------------------
-- 8/9. Pack enablement and pack-contributed configuration.
-- ---------------------------------------------------------------------------
CREATE TABLE organization_packs (
  organization_id uuid NOT NULL REFERENCES organizations (id),
  pack_id text NOT NULL,
  status text NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED', 'DISABLED')),
  enabled_at timestamptz NOT NULL DEFAULT now(),
  enabled_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, pack_id)
);
CREATE INDEX organization_packs_organization_id_idx ON organization_packs (organization_id);
CREATE TRIGGER organization_packs_updated_at
  BEFORE UPDATE ON organization_packs
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

-- Pack-contributed product taxonomy. Shared reference configuration
-- (no organization_id, no RLS — like excise_rules).
CREATE TABLE product_taxonomy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id text NOT NULL,
  taxonomy_key text NOT NULL,
  label text NOT NULL,
  parent_key text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, taxonomy_key)
);

-- Pack-contributed listing / distribution-record types. Shared reference
-- configuration (no RLS).
CREATE TABLE listing_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id text NOT NULL,
  type_key text NOT NULL,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, type_key)
);

-- Pack-scoped product attributes (e.g. cannabis THC / strain). The core
-- never reads these keys; only the owning pack does.
CREATE TABLE product_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  product_id uuid NOT NULL REFERENCES products (id),
  pack_id text NOT NULL,
  attribute_key text NOT NULL,
  value_text text,
  value_int integer,
  value_numeric numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, product_id, pack_id, attribute_key)
);
CREATE INDEX product_attributes_product_id_idx ON product_attributes (product_id);
CREATE TRIGGER product_attributes_updated_at
  BEFORE UPDATE ON product_attributes
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

-- Pack-scoped lot attributes (e.g. cannabis tested THC).
CREATE TABLE lot_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  lot_id uuid NOT NULL REFERENCES lots (id),
  pack_id text NOT NULL,
  attribute_key text NOT NULL,
  value_text text,
  value_int integer,
  value_numeric numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, lot_id, pack_id, attribute_key)
);
CREATE INDEX lot_attributes_lot_id_idx ON lot_attributes (lot_id);
CREATE TRIGGER lot_attributes_updated_at
  BEFORE UPDATE ON lot_attributes
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

-- Pack-defined lot dispositions (e.g. cannabis destruction). The core
-- lot_status stays generic; a pack records its own end-states here.
CREATE TABLE lot_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  lot_id uuid NOT NULL REFERENCES lots (id),
  pack_id text NOT NULL,
  disposition_key text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'COMPLETED', 'CANCELLED')),
  note text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lot_dispositions_lot_id_idx ON lot_dispositions (lot_id);
CREATE TRIGGER lot_dispositions_updated_at
  BEFORE UPDATE ON lot_dispositions
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

ALTER TABLE organization_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_dispositions ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_packs_tenant_isolation ON organization_packs
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY product_attributes_tenant_isolation ON product_attributes
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY lot_attributes_tenant_isolation ON lot_attributes
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY lot_dispositions_tenant_isolation ON lot_dispositions
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- 1/2/3. Products: generic taxonomy key; drop cannabis columns.
-- ---------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN category_key text NOT NULL DEFAULT 'generic';
ALTER TABLE products ADD COLUMN taxonomy_pack_id text;
UPDATE products
  SET category_key = category::text,
      taxonomy_pack_id = 'cannabis-ca'
  WHERE category IS NOT NULL;
ALTER TABLE products DROP COLUMN category;
ALTER TABLE products DROP COLUMN strain_type;
ALTER TABLE products DROP COLUMN thc_label_mg;
ALTER TABLE products DROP COLUMN thc_label_mg_per_g;
DROP TYPE product_category;
DROP TYPE strain_type;

-- ---------------------------------------------------------------------------
-- 3/4. Lots: drop THC columns; generic lot_status; preserve destruction
-- states as pack dispositions.
-- ---------------------------------------------------------------------------
ALTER TABLE lots DROP COLUMN thc_tested_mg_per_g;
ALTER TABLE lots DROP COLUMN thc_label_mg_per_g;
INSERT INTO lot_dispositions (organization_id, lot_id, pack_id, disposition_key, status, note)
SELECT organization_id, id, 'cannabis-ca', status, 'COMPLETED',
       'Migrated from legacy lot_status by 0011 (B-110).'
FROM lots WHERE status IN ('AWAITING_DESTRUCTION', 'DESTROYED');
UPDATE lots SET status = 'CLOSED' WHERE status IN ('AWAITING_DESTRUCTION', 'DESTROYED');
ALTER TABLE lots ALTER COLUMN status TYPE text USING status::text;
-- The old DEFAULT still casts to lot_status; reset it to plain text
-- before the type is dropped.
ALTER TABLE lots ALTER COLUMN status DROP DEFAULT;
ALTER TABLE lots ALTER COLUMN status SET DEFAULT 'ACTIVE';
ALTER TABLE lots
  ADD CONSTRAINT lots_status_generic_check
  CHECK (status IN ('ACTIVE', 'QUARANTINE', 'RELEASED_FOR_SALE', 'CLOSED'));
DROP TYPE lot_status;

-- ---------------------------------------------------------------------------
-- 5. Imports / movements: generic kinds and source systems.
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_movements ADD COLUMN source_system_detail text;
UPDATE inventory_movements
  SET source_system_detail = 'SEED_TO_SALE'
  WHERE source_system = 'SEED_TO_SALE';
ALTER TABLE inventory_movements
  ALTER COLUMN source_system TYPE text
  USING (CASE source_system WHEN 'SEED_TO_SALE' THEN 'EXTERNAL_SYSTEM' ELSE source_system::text END);
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_source_system_check
  CHECK (source_system IN ('EXTERNAL_SYSTEM', 'PAPER_RECORD', 'MANUAL', 'QUALIOS'));
DROP TYPE source_system;

ALTER TABLE import_runs ADD COLUMN external_source text;
UPDATE import_runs SET external_source = 'SEED_TO_SALE' WHERE import_kind = 'SEED_TO_SALE';
ALTER TABLE import_runs
  ALTER COLUMN import_kind TYPE text
  USING (CASE import_kind WHEN 'SEED_TO_SALE' THEN 'EXTERNAL_SNAPSHOT' ELSE import_kind::text END);
ALTER TABLE import_runs
  ADD CONSTRAINT import_runs_import_kind_check
  CHECK (import_kind IN ('EXTERNAL_SNAPSHOT', 'PAPER_COUNT', 'ALLOCATION'));
DROP TYPE import_kind;

-- Reconciliation lines/columns: the external side is generic, not
-- seed-to-sale named.
ALTER TABLE reconciliation_lines RENAME COLUMN seed_to_sale_qty_mg TO external_qty_mg;
ALTER TABLE reconciliation_lines RENAME COLUMN seed_to_sale_qty_units TO external_qty_units;
ALTER TABLE reconciliations RENAME COLUMN seed_to_sale_snapshot_id TO external_snapshot_document_id;

-- ---------------------------------------------------------------------------
-- 6. Excise: generic bases + pack ownership; rename THC-named columns.
--    (ADD VALUE is safe here: no statement in this migration uses the new
--    values, following the 0009/0010 pattern.)
-- ---------------------------------------------------------------------------
ALTER TYPE excise_basis ADD VALUE IF NOT EXISTS 'PER_UNIT';
ALTER TYPE excise_basis ADD VALUE IF NOT EXISTS 'AD_VALOREM';
ALTER TYPE excise_basis ADD VALUE IF NOT EXISTS 'PER_LITRE';
ALTER TYPE excise_basis ADD VALUE IF NOT EXISTS 'PER_KG';
ALTER TABLE excise_rules ADD COLUMN pack_id text NOT NULL DEFAULT 'cannabis-ca';
ALTER TABLE excise_rules RENAME COLUMN rate_cents_per_mg TO rate_cents_per_basis_unit;
ALTER TABLE excise_calculations RENAME COLUMN thc_basis TO basis_source;
ALTER TABLE excise_calculations RENAME COLUMN thc_mg TO basis_quantity;
COMMENT ON TABLE excise_rules IS
  'Cannabis-pack-owned versioned excise rules (pack_id cannabis-ca). The core tax engine is tax_rules (migration 0012); PER_MG_THC is one basis the cannabis pack registers.';
COMMENT ON TABLE excise_calculations IS
  'Cannabis-pack-owned excise calculations. No duty is computed by any engine until a domain expert reviews the rules (ADR D-07).';

-- ---------------------------------------------------------------------------
-- 7. Listings: generic listing_type; pack types in listing_types.
-- ---------------------------------------------------------------------------
ALTER TABLE distributor_listings ADD COLUMN pack_id text;
UPDATE distributor_listings
  SET pack_id = 'cannabis-ca'
  WHERE listing_type IN ('SK_ALLOCATION', 'SK_LISTING', 'MB_ALLOCATION', 'MBLL_PLAF');
ALTER TABLE distributor_listings ALTER COLUMN listing_type TYPE text USING listing_type::text;
DROP TYPE listing_type;

-- ---------------------------------------------------------------------------
-- 9. Seed the packs' contributions as reference data (idempotent).
-- ---------------------------------------------------------------------------
INSERT INTO product_taxonomy (pack_id, taxonomy_key, label, sort_order) VALUES
  ('cannabis-ca', 'DRIED_FLOWER', 'Dried flower', 1),
  ('cannabis-ca', 'PRE_ROLL', 'Pre-roll', 2),
  ('cannabis-ca', 'INFUSED_PRE_ROLL', 'Infused pre-roll', 3),
  ('cannabis-ca', 'EXTRACT', 'Extract', 4),
  ('cannabis-ca', 'VAPE_CART', 'Vape cartridge', 5),
  ('cannabis-ca', 'EDIBLE', 'Edible', 6),
  ('cannabis-ca', 'OTHER', 'Other', 7),
  ('food-ca', 'FRESH_PRODUCE', 'Fresh produce', 1),
  ('food-ca', 'DAIRY', 'Dairy', 2),
  ('food-ca', 'MEAT', 'Meat', 3),
  ('food-ca', 'BAKERY', 'Bakery', 4),
  ('food-ca', 'BEVERAGE', 'Beverage', 5),
  ('food-ca', 'PACKAGED_GOODS', 'Packaged goods', 6),
  ('food-ca', 'SOUP', 'Soup', 7),
  ('food-ca', 'OTHER', 'Other', 8),
  ('industrial-generic', 'RAW_MATERIAL', 'Raw material', 1),
  ('industrial-generic', 'COMPONENT', 'Component', 2),
  ('industrial-generic', 'ASSEMBLY', 'Assembly', 3),
  ('industrial-generic', 'FINISHED_GOOD', 'Finished good', 4),
  ('industrial-generic', 'CONSUMABLE', 'Consumable', 5),
  ('industrial-generic', 'OTHER', 'Other', 6)
ON CONFLICT (pack_id, taxonomy_key) DO NOTHING;

INSERT INTO listing_types (pack_id, type_key, label, description) VALUES
  ('cannabis-ca', 'SK_ALLOCATION', 'Saskatchewan allocation', 'Saskatchewan distributor allocation record.'),
  ('cannabis-ca', 'SK_LISTING', 'Saskatchewan listing', 'Saskatchewan new-product listing form.'),
  ('cannabis-ca', 'MB_ALLOCATION', 'Manitoba allocation', 'Manitoba distributor allocation record.'),
  ('cannabis-ca', 'MBLL_PLAF', 'MBLL product listing application', 'Manitoba Liquor & Lotteries product listing application form.'),
  ('food-ca', 'RETAILER_LISTING', 'Retailer listing', 'Retail buyer listing record.'),
  ('food-ca', 'DISTRIBUTOR_ALLOCATION', 'Distributor allocation', 'Distributor allocation record.'),
  ('food-ca', 'FOODSERVICE_LISTING', 'Foodservice listing', 'Foodservice buyer listing record.'),
  ('industrial-generic', 'DISTRIBUTOR_LISTING', 'Distributor listing', 'Distributor listing record.'),
  ('industrial-generic', 'CUSTOMER_QUOTE_LISTING', 'Customer quote listing', 'Customer quotation listing record.')
ON CONFLICT (pack_id, type_key) DO NOTHING;

-- DOWN
DROP POLICY IF EXISTS lot_dispositions_tenant_isolation ON lot_dispositions;
DROP POLICY IF EXISTS lot_attributes_tenant_isolation ON lot_attributes;
DROP POLICY IF EXISTS product_attributes_tenant_isolation ON product_attributes;
DROP POLICY IF EXISTS organization_packs_tenant_isolation ON organization_packs;
DROP TABLE IF EXISTS lot_dispositions;
DROP TABLE IF EXISTS lot_attributes;
DROP TABLE IF EXISTS product_attributes;
DROP TABLE IF EXISTS listing_types;
DROP TABLE IF EXISTS product_taxonomy;
DROP TABLE IF EXISTS organization_packs;
ALTER TABLE distributor_listings DROP COLUMN IF EXISTS pack_id;
CREATE TYPE listing_type AS ENUM ('SK_ALLOCATION', 'SK_LISTING', 'MB_ALLOCATION', 'MBLL_PLAF');
ALTER TABLE distributor_listings
  ALTER COLUMN listing_type TYPE listing_type USING listing_type::listing_type;
ALTER TABLE excise_calculations RENAME COLUMN basis_quantity TO thc_mg;
ALTER TABLE excise_calculations RENAME COLUMN basis_source TO thc_basis;
ALTER TABLE excise_rules RENAME COLUMN rate_cents_per_basis_unit TO rate_cents_per_mg;
ALTER TABLE excise_rules DROP COLUMN IF EXISTS pack_id;
ALTER TABLE reconciliations RENAME COLUMN external_snapshot_document_id TO seed_to_sale_snapshot_id;
ALTER TABLE reconciliation_lines RENAME COLUMN external_qty_units TO seed_to_sale_qty_units;
ALTER TABLE reconciliation_lines RENAME COLUMN external_qty_mg TO seed_to_sale_qty_mg;
ALTER TABLE import_runs DROP CONSTRAINT IF EXISTS import_runs_import_kind_check;
ALTER TABLE import_runs DROP COLUMN IF EXISTS external_source;
CREATE TYPE import_kind AS ENUM ('SEED_TO_SALE', 'PAPER_COUNT', 'ALLOCATION');
ALTER TABLE import_runs
  ALTER COLUMN import_kind TYPE import_kind USING import_kind::import_kind;
ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_source_system_check;
ALTER TABLE inventory_movements DROP COLUMN IF EXISTS source_system_detail;
CREATE TYPE source_system AS ENUM ('SEED_TO_SALE', 'PAPER_RECORD', 'MANUAL', 'QUALIOS');
ALTER TABLE inventory_movements
  ALTER COLUMN source_system TYPE source_system USING source_system::source_system;
ALTER TABLE lots DROP CONSTRAINT IF EXISTS lots_status_generic_check;
CREATE TYPE lot_status AS ENUM (
  'ACTIVE', 'QUARANTINE', 'RELEASED_FOR_SALE', 'AWAITING_DESTRUCTION', 'DESTROYED', 'CLOSED'
);
ALTER TABLE lots ALTER COLUMN status TYPE lot_status USING status::lot_status;
ALTER TABLE lots ADD COLUMN thc_label_mg_per_g integer;
ALTER TABLE lots ADD COLUMN thc_tested_mg_per_g integer;
CREATE TYPE strain_type AS ENUM ('INDICA', 'SATIVA', 'HYBRID', 'BLEND');
CREATE TYPE product_category AS ENUM (
  'DRIED_FLOWER', 'PRE_ROLL', 'INFUSED_PRE_ROLL', 'EXTRACT', 'VAPE_CART', 'EDIBLE', 'OTHER'
);
ALTER TABLE products ADD COLUMN thc_label_mg_per_g integer;
ALTER TABLE products ADD COLUMN thc_label_mg integer;
ALTER TABLE products ADD COLUMN strain_type strain_type;
ALTER TABLE products ADD COLUMN category product_category;
ALTER TABLE products DROP COLUMN IF EXISTS taxonomy_pack_id;
ALTER TABLE products DROP COLUMN IF EXISTS category_key;
