-- 0012_domain_model.sql — Integrated domain model (directive §3–§4, B-110).
--
-- Shared, industry-neutral entities the directive requires before any new
-- isolated feature is built. Industry specifics are pack configuration
-- (pack ids, pack-registered basis keys), never core entities. The
-- TypeScript contracts live in @qualios/domain; the documented model,
-- event flows, and API contracts live in docs/architecture/DOMAIN_MODEL.md.
--
-- What this adds:
--  1. traceability_links — lot genealogy (parent -> child, with direction).
--     Backward trace follows child -> parent; forward trace parent -> child.
--     Batch inputs (0002) already record what went into a batch; these
--     links are the queryable genealogy across batches, packaging, splits,
--     merges, and shipments, including links with no batch at all.
--  2. gl_accounts / journal_entries / journal_lines — double-entry general
--     ledger. One source record posts at most one entry per module
--     (unique idempotency key + unique source triple), so no duplicate
--     entry can exist across modules. A trigger refuses to post an
--     unbalanced entry, and posted entries' lines are immutable.
--  3. inventory_valuations — the inventory-valuation hook: a valuation of
--     a lot may point at the journal entry that booked it.
--  4. tax_rules / tax_calculations — the generic versioned-rule tax
--     engine. A rule names jurisdiction, tax type, a pack-registered
--     basis, a rate, and effective dates. Calculations may point at the
--     journal entry that booked them. No calculation is offered until a
--     domain expert reviews the rules (ADR D-07); the engine is schema
--     and contract only in this migration.
--
-- All tenant tables carry organization_id and RLS policies. tax_rules is
-- shared reference configuration (no RLS), like excise_rules.
-- UP
-- ---------------------------------------------------------------------------
-- 1. Traceability links (lot genealogy).
-- ---------------------------------------------------------------------------
CREATE TABLE traceability_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  parent_lot_id uuid NOT NULL REFERENCES lots (id),
  child_lot_id uuid NOT NULL REFERENCES lots (id),
  link_type text NOT NULL CHECK (link_type IN (
    'CONSUMED_IN', 'PRODUCED_FROM', 'PACKAGED_FROM', 'SPLIT_FROM',
    'MERGED_INTO', 'SHIPPED_AS', 'RECEIVED_AS'
  )),
  batch_id uuid REFERENCES batches (id),
  quantity_mg integer,
  quantity_units integer,
  note text,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT traceability_links_no_self_link CHECK (parent_lot_id <> child_lot_id),
  UNIQUE (organization_id, parent_lot_id, child_lot_id, link_type)
);
CREATE INDEX traceability_links_parent_idx ON traceability_links (organization_id, parent_lot_id);
CREATE INDEX traceability_links_child_idx ON traceability_links (organization_id, child_lot_id);

-- ---------------------------------------------------------------------------
-- 2. Double-entry general ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE gl_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  code text NOT NULL,
  name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN (
    'ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'
  )),
  parent_account_id uuid REFERENCES gl_accounts (id),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
CREATE INDEX gl_accounts_organization_id_idx ON gl_accounts (organization_id);
CREATE TRIGGER gl_accounts_updated_at
  BEFORE UPDATE ON gl_accounts
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  entry_date date NOT NULL,
  source_module text NOT NULL,
  source_type text NOT NULL,
  source_id uuid,
  idempotency_key text NOT NULL,
  memo text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'VOID')),
  posted_at timestamptz,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, source_module, source_type, source_id)
);
CREATE INDEX journal_entries_organization_id_idx ON journal_entries (organization_id);
CREATE INDEX journal_entries_source_idx ON journal_entries (organization_id, source_module, source_type);
CREATE TRIGGER journal_entries_updated_at
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries (id),
  account_id uuid NOT NULL REFERENCES gl_accounts (id),
  debit_cents integer NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents integer NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  lot_id uuid REFERENCES lots (id),
  product_id uuid REFERENCES products (id),
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_lines_one_side_only CHECK (NOT (debit_cents > 0 AND credit_cents > 0))
);
CREATE INDEX journal_lines_entry_id_idx ON journal_lines (journal_entry_id);
CREATE INDEX journal_lines_account_id_idx ON journal_lines (account_id);

-- A POSTED entry must balance and must not be empty. The API validates
-- first (@qualios/domain validateJournalEntry); this trigger is the
-- database backstop so no caller can post an unbalanced entry. It fires
-- on INSERT as well as on status updates, so an entry can never be
-- created already POSTED without lines.
CREATE OR REPLACE FUNCTION qualios_journal_entry_must_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  total_debit bigint;
  total_credit bigint;
  line_count integer;
BEGIN
  IF NEW.status = 'POSTED' AND (OLD.status IS NULL OR OLD.status <> 'POSTED') THEN
    SELECT COALESCE(SUM(debit_cents), 0), COALESCE(SUM(credit_cents), 0), COUNT(*)
      INTO total_debit, total_credit, line_count
      FROM journal_lines WHERE journal_entry_id = NEW.id;
    IF line_count = 0 THEN
      RAISE EXCEPTION 'journal entry % has no lines', NEW.id;
    END IF;
    IF total_debit <> total_credit THEN
      RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %',
        NEW.id, total_debit, total_credit;
    END IF;
    IF total_debit = 0 THEN
      RAISE EXCEPTION 'journal entry % posts zero', NEW.id;
    END IF;
    NEW.posted_at = COALESCE(NEW.posted_at, now());
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_entries_balance_check
  BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION qualios_journal_entry_must_balance();

-- Posted entries are immutable: no line may be added, changed, or removed
-- once its entry is POSTED. Corrections post a new (reversing) entry.
CREATE OR REPLACE FUNCTION qualios_journal_lines_immutable_when_posted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_status text;
BEGIN
  SELECT status INTO entry_status FROM journal_entries
    WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  IF entry_status = 'POSTED' THEN
    RAISE EXCEPTION 'journal entry % is POSTED; its lines are immutable', COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER journal_lines_immutable_when_posted_insert
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION qualios_journal_lines_immutable_when_posted();
CREATE TRIGGER journal_lines_immutable_when_posted_update
  BEFORE UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION qualios_journal_lines_immutable_when_posted();
CREATE TRIGGER journal_lines_immutable_when_posted_delete
  BEFORE DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION qualios_journal_lines_immutable_when_posted();

-- ---------------------------------------------------------------------------
-- 3. Inventory valuation hook.
-- ---------------------------------------------------------------------------
CREATE TABLE inventory_valuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  lot_id uuid NOT NULL REFERENCES lots (id),
  valuation_method text NOT NULL CHECK (valuation_method IN ('FIFO', 'AVERAGE', 'STANDARD', 'ACTUAL')),
  unit_cost_cents integer NOT NULL CHECK (unit_cost_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  as_of timestamptz NOT NULL,
  journal_entry_id uuid REFERENCES journal_entries (id),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, lot_id, valuation_method, as_of)
);
CREATE INDEX inventory_valuations_lot_id_idx ON inventory_valuations (lot_id);

-- ---------------------------------------------------------------------------
-- 4. Generic versioned-rule tax engine.
-- ---------------------------------------------------------------------------
CREATE TABLE tax_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction text NOT NULL,
  tax_type text NOT NULL CHECK (tax_type IN ('GST', 'HST', 'VAT', 'SALES_TAX', 'EXCISE', 'OTHER')),
  basis text NOT NULL,
  rate_numeric numeric NOT NULL CHECK (rate_numeric >= 0),
  rate_unit text,
  flat_amount_cents integer CHECK (flat_amount_cents IS NULL OR flat_amount_cents >= 0),
  effective_from date NOT NULL,
  effective_to date,
  pack_id text,
  reviewed_by uuid REFERENCES users (id),
  reviewed_at timestamptz,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_rules_effective_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX tax_rules_jurisdiction_idx ON tax_rules (jurisdiction, effective_from);
CREATE TRIGGER tax_rules_updated_at
  BEFORE UPDATE ON tax_rules
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE tax_calculations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  tax_rule_id uuid NOT NULL REFERENCES tax_rules (id),
  subject_type text NOT NULL,
  subject_id uuid,
  jurisdiction text NOT NULL,
  basis_snapshot text NOT NULL,
  taxable_amount_cents integer NOT NULL CHECK (taxable_amount_cents >= 0),
  tax_amount_cents integer NOT NULL CHECK (tax_amount_cents >= 0),
  calculated_by uuid NOT NULL REFERENCES users (id),
  calculated_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FINAL')),
  journal_entry_id uuid REFERENCES journal_entries (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tax_calculations_organization_id_idx ON tax_calculations (organization_id);
CREATE INDEX tax_calculations_rule_id_idx ON tax_calculations (tax_rule_id);
CREATE TRIGGER tax_calculations_updated_at
  BEFORE UPDATE ON tax_calculations
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

ALTER TABLE traceability_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_valuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_calculations ENABLE ROW LEVEL SECURITY;

CREATE POLICY traceability_links_tenant_isolation ON traceability_links
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY gl_accounts_tenant_isolation ON gl_accounts
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY journal_entries_tenant_isolation ON journal_entries
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY journal_lines_tenant_isolation ON journal_lines
  USING (
    EXISTS (
      SELECT 1 FROM journal_entries je
      WHERE je.id = journal_lines.journal_entry_id
        AND je.organization_id = current_setting('app.current_organization_id', true)::uuid
    )
  );
CREATE POLICY inventory_valuations_tenant_isolation ON inventory_valuations
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY tax_calculations_tenant_isolation ON tax_calculations
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);

-- DOWN
DROP POLICY IF EXISTS tax_calculations_tenant_isolation ON tax_calculations;
DROP POLICY IF EXISTS inventory_valuations_tenant_isolation ON inventory_valuations;
DROP POLICY IF EXISTS journal_lines_tenant_isolation ON journal_lines;
DROP POLICY IF EXISTS journal_entries_tenant_isolation ON journal_entries;
DROP POLICY IF EXISTS gl_accounts_tenant_isolation ON gl_accounts;
DROP POLICY IF EXISTS traceability_links_tenant_isolation ON traceability_links;
DROP TABLE IF EXISTS tax_calculations;
DROP TABLE IF EXISTS tax_rules;
DROP TABLE IF EXISTS inventory_valuations;
DROP TRIGGER IF EXISTS journal_lines_immutable_when_posted_delete ON journal_lines;
DROP TRIGGER IF EXISTS journal_lines_immutable_when_posted_update ON journal_lines;
DROP TRIGGER IF EXISTS journal_lines_immutable_when_posted_insert ON journal_lines;
DROP FUNCTION IF EXISTS qualios_journal_lines_immutable_when_posted();
DROP TRIGGER IF EXISTS journal_entries_balance_check ON journal_entries;
DROP FUNCTION IF EXISTS qualios_journal_entry_must_balance();
DROP TABLE IF EXISTS journal_lines;
DROP TABLE IF EXISTS journal_entries;
DROP TABLE IF EXISTS gl_accounts;
DROP TABLE IF EXISTS traceability_links;
