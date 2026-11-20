-- 0006_listings.sql — Distributor listings, generated from reconciled data (Data Model §6)
-- Rule: any field with no verified source is left blank and flagged, not guessed.
-- UP
CREATE TYPE listing_type AS ENUM ('SK_ALLOCATION', 'SK_LISTING', 'MB_ALLOCATION', 'MBLL_PLAF');
CREATE TYPE listing_status AS ENUM ('DRAFT', 'REVIEW', 'APPROVED', 'EXPORTED');

CREATE TABLE distributor_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  listing_type listing_type NOT NULL,
  period text NOT NULL,
  status listing_status NOT NULL DEFAULT 'DRAFT',
  document_id uuid REFERENCES documents (id),
  generated_by uuid NOT NULL REFERENCES users (id),
  approved_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX distributor_listings_organization_id_idx ON distributor_listings (organization_id);
CREATE TRIGGER distributor_listings_updated_at
  BEFORE UPDATE ON distributor_listings
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE listing_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES distributor_listings (id),
  product_id uuid NOT NULL REFERENCES products (id),
  lot_id uuid REFERENCES lots (id),
  -- Null = unverified: left blank on the form and flagged, never invented.
  quantity_units integer,
  price_cents integer,
  case_size integer,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listing_lines_listing_id_idx ON listing_lines (listing_id);

ALTER TABLE distributor_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY distributor_listings_tenant_isolation ON distributor_listings
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY listing_lines_tenant_isolation ON listing_lines
  USING (
    EXISTS (
      SELECT 1 FROM distributor_listings dl
      WHERE dl.id = listing_lines.listing_id
        AND dl.organization_id = current_setting('app.current_organization_id', true)::uuid
    )
  );

-- DOWN
DROP POLICY IF EXISTS listing_lines_tenant_isolation ON listing_lines;
DROP POLICY IF EXISTS distributor_listings_tenant_isolation ON distributor_listings;
DROP TABLE IF EXISTS listing_lines;
DROP TABLE IF EXISTS distributor_listings;
DROP TYPE IF EXISTS listing_status;
DROP TYPE IF EXISTS listing_type;
