-- 0005_excise.sql — Versioned excise rules and calculations (Data Model §5)
-- Rules are configuration, never hard-coded. They must be reviewed by a domain
-- expert / the customer's accountant before use for any filing or payment.
-- The wedge calculates working papers; it does not file.
-- UP
CREATE TYPE excise_basis AS ENUM ('PER_MG_THC');
CREATE TYPE excise_rule_status AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');
CREATE TYPE thc_basis AS ENUM ('LABEL', 'TESTED');
CREATE TYPE excise_calculation_status AS ENUM ('DRAFT', 'FINAL');

CREATE TABLE excise_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  basis excise_basis NOT NULL DEFAULT 'PER_MG_THC',
  -- Integer cents per mg THC.
  rate_cents_per_mg integer NOT NULL CHECK (rate_cents_per_mg >= 0),
  flat_per_unit_cents integer,
  reviewed_by uuid REFERENCES users (id),
  reviewed_at timestamptz,
  status excise_rule_status NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX excise_rules_jurisdiction_idx ON excise_rules (jurisdiction, effective_from);
CREATE TRIGGER excise_rules_updated_at
  BEFORE UPDATE ON excise_rules
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE excise_calculations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  lot_id uuid REFERENCES lots (id),
  product_id uuid REFERENCES products (id),
  jurisdiction text NOT NULL,
  thc_basis thc_basis NOT NULL,
  thc_mg integer NOT NULL,
  excise_rule_id uuid NOT NULL REFERENCES excise_rules (id),
  -- Integer cents.
  duty_cents integer NOT NULL,
  calculated_by uuid NOT NULL REFERENCES users (id),
  calculated_at timestamptz NOT NULL DEFAULT now(),
  status excise_calculation_status NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX excise_calculations_organization_id_idx ON excise_calculations (organization_id);
CREATE INDEX excise_calculations_rule_id_idx ON excise_calculations (excise_rule_id);
CREATE TRIGGER excise_calculations_updated_at
  BEFORE UPDATE ON excise_calculations
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

-- Excise rules are shared reference configuration, not tenant data: no RLS.
ALTER TABLE excise_calculations ENABLE ROW LEVEL SECURITY;
CREATE POLICY excise_calculations_tenant_isolation ON excise_calculations
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);

-- DOWN
DROP POLICY IF EXISTS excise_calculations_tenant_isolation ON excise_calculations;
DROP TABLE IF EXISTS excise_calculations;
DROP TABLE IF EXISTS excise_rules;
DROP TYPE IF EXISTS excise_calculation_status;
DROP TYPE IF EXISTS thc_basis;
DROP TYPE IF EXISTS excise_rule_status;
DROP TYPE IF EXISTS excise_basis;
