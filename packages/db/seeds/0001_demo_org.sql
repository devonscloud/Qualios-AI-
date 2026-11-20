-- 0001_demo_org.sql — SYNTHETIC demo data only. No real Herba Farms records.
-- Fixed UUIDs match the demo tenants in apps/web (select-tenant page).
-- Idempotent: safe to re-run (ON CONFLICT DO NOTHING).

INSERT INTO organizations (id, name, licence_number, country, currency, status)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'Herba Farms Ltd. — Demo Tenant (synthetic)',
  'LIC-0000000000-2026-DEMO',
  'CA', 'CAD', 'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO sites (id, organization_id, name, address, timezone, status)
VALUES (
  '11111111-1111-4111-8111-111111111112',
  '11111111-1111-4111-8111-111111111111',
  'Regina Processing Facility (demo)',
  'Demo Address, Regina, SK',
  'America/Regina',
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, email, display_name, mfa_enrolled, status)
VALUES (
  '11111111-1111-4111-8111-111111111113',
  'demo.qa@qualios.example',
  'Demo QA Approver',
  false,
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO roles (id, organization_id, name, permissions)
VALUES (
  '11111111-1111-4111-8111-111111111114',
  '11111111-1111-4111-8111-111111111111',
  'QA_APPROVER',
  '["reconciliation.run", "discrepancy.resolve", "discrepancy.approve", "excise.calculate", "listing.generate"]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- Second demo user: the operations uploader. The demo flow is: Ops uploads a
-- document, QA approves it. Two different users are required so the
-- segregation-of-duties check (approver != uploader) can be exercised.
INSERT INTO users (id, email, display_name, mfa_enrolled, status)
VALUES (
  '11111111-1111-4111-8111-111111111119',
  'demo.ops@qualios.example',
  'Demo Ops Uploader',
  false,
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO roles (id, organization_id, name, permissions)
VALUES (
  '11111111-1111-4111-8111-111111111120',
  '11111111-1111-4111-8111-111111111111',
  'PRODUCTION',
  '["document.upload"]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships (id, user_id, organization_id, site_id, role_id, status)
VALUES (
  '11111111-1111-4111-8111-111111111115',
  '11111111-1111-4111-8111-111111111113',
  '11111111-1111-4111-8111-111111111111',
  NULL,
  '11111111-1111-4111-8111-111111111114',
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships (id, user_id, organization_id, site_id, role_id, status)
VALUES (
  '11111111-1111-4111-8111-111111111121',
  '11111111-1111-4111-8111-111111111119',
  '11111111-1111-4111-8111-111111111111',
  NULL,
  '11111111-1111-4111-8111-111111111120',
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

-- Core products keep generic fields only (B-110). The cannabis
-- attributes of the demo product live in product_attributes /
-- lot_attributes, owned by the cannabis pack — the core never stores THC.
INSERT INTO products (id, organization_id, name, brand, category_key, taxonomy_pack_id, format, gtin_upc, case_size, status)
VALUES (
  '11111111-1111-4111-8111-111111111116',
  '11111111-1111-4111-8111-111111111111',
  'Demo Flower 14g (synthetic)',
  'Herba Farms',
  'DRIED_FLOWER',
  'cannabis-ca',
  '14g',
  '628069701524',
  6,
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

-- Cannabis-pack attributes for the demo product (pack-scoped, not core).
INSERT INTO product_attributes (organization_id, product_id, pack_id, attribute_key, value_text, value_int)
VALUES
  ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111116', 'cannabis-ca', 'strain_type', 'INDICA', NULL),
  ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111116', 'cannabis-ca', 'thc_label_mg', NULL, 4200),
  ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111116', 'cannabis-ca', 'thc_label_mg_per_g', NULL, 300)
ON CONFLICT (organization_id, product_id, pack_id, attribute_key) DO NOTHING;

INSERT INTO lots (id, organization_id, product_id, lot_number, status, approved_for_sale)
VALUES (
  '11111111-1111-4111-8111-111111111117',
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111116',
  '260824-DEMO',
  'ACTIVE',
  true
)
ON CONFLICT (id) DO NOTHING;

-- Cannabis-pack attributes for the demo lot (pack-scoped, not core).
INSERT INTO lot_attributes (organization_id, lot_id, pack_id, attribute_key, value_int)
VALUES
  ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111117', 'cannabis-ca', 'thc_tested_mg_per_g', 308),
  ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111117', 'cannabis-ca', 'thc_label_mg_per_g', 300)
ON CONFLICT (organization_id, lot_id, pack_id, attribute_key) DO NOTHING;

-- Herba enables the cannabis pack: the imports / reconciliations /
-- discrepancies / excise surfaces are pack surfaces, gated on this row.
INSERT INTO organization_packs (organization_id, pack_id, status)
VALUES ('11111111-1111-4111-8111-111111111111', 'cannabis-ca', 'ENABLED')
ON CONFLICT (organization_id, pack_id) DO NOTHING;

INSERT INTO inventory_locations (id, organization_id, site_id, name, external_reference, stock_state)
VALUES (
  '11111111-1111-4111-8111-111111111118',
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111112',
  'Packaging Room (demo)',
  'C-00000-DEMO',
  'BULK'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Second demo tenant (B-110, leak 11): a food company, so the core is
-- never demoed as cannabis-only. Fixed UUIDs match the second tenant on
-- the web select-tenant page. It enables the food pack only — the
-- cannabis pack surfaces refuse it (PACK_NOT_ENABLED), which is the
-- pack gate working as designed.
-- ---------------------------------------------------------------------------
INSERT INTO organizations (id, name, licence_number, country, currency, status)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  'Prairie Foods Co. — Demo Tenant (synthetic)',
  NULL,
  'CA', 'CAD', 'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO sites (id, organization_id, name, address, timezone, status)
VALUES (
  '22222222-2222-4222-8222-222222222223',
  '22222222-2222-4222-8222-222222222222',
  'Winnipeg Production Kitchen (demo)',
  'Demo Address, Winnipeg, MB',
  'America/Winnipeg',
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, email, display_name, mfa_enrolled, status)
VALUES (
  '22222222-2222-4222-8222-222222222224',
  'demo.qa-food@qualios.example',
  'Demo Food QA Approver',
  false,
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO roles (id, organization_id, name, permissions)
VALUES (
  '22222222-2222-4222-8222-222222222225',
  '22222222-2222-4222-8222-222222222222',
  'QA_APPROVER',
  '["document.upload", "traceability.link"]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships (id, user_id, organization_id, site_id, role_id, status)
VALUES (
  '22222222-2222-4222-8222-222222222226',
  '22222222-2222-4222-8222-222222222224',
  '22222222-2222-4222-8222-222222222222',
  NULL,
  '22222222-2222-4222-8222-222222222225',
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

-- A food product, categorized from the food pack's taxonomy.
INSERT INTO products (id, organization_id, name, brand, category_key, taxonomy_pack_id, format, status)
VALUES (
  '22222222-2222-4222-8222-222222222227',
  '22222222-2222-4222-8222-222222222222',
  'Demo Tomato Soup 400g (synthetic)',
  'Prairie Foods',
  'SOUP',
  'food-ca',
  '400g',
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO lots (id, organization_id, product_id, lot_number, status, approved_for_sale)
VALUES (
  '22222222-2222-4222-8222-222222222228',
  '22222222-2222-4222-8222-222222222222',
  '22222222-2222-4222-8222-222222222227',
  'FS-1001',
  'ACTIVE',
  true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO inventory_locations (id, organization_id, site_id, name, external_reference, stock_state)
VALUES (
  '22222222-2222-4222-8222-222222222229',
  '22222222-2222-4222-8222-222222222222',
  '22222222-2222-4222-8222-222222222223',
  'Dry Storage (demo)',
  'D-00000-DEMO',
  'BULK'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO organization_packs (organization_id, pack_id, status)
VALUES ('22222222-2222-4222-8222-222222222222', 'food-ca', 'ENABLED')
ON CONFLICT (organization_id, pack_id) DO NOTHING;
