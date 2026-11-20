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

INSERT INTO products (id, organization_id, name, brand, category, format, strain_type, thc_label_mg, thc_label_mg_per_g, gtin_upc, case_size, status)
VALUES (
  '11111111-1111-4111-8111-111111111116',
  '11111111-1111-4111-8111-111111111111',
  'Demo Flower 14g (synthetic)',
  'Herba Farms',
  'DRIED_FLOWER',
  '14g',
  'INDICA',
  4200,
  300,
  '628069701524',
  6,
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO lots (id, organization_id, product_id, lot_number, thc_tested_mg_per_g, thc_label_mg_per_g, status, approved_for_sale)
VALUES (
  '11111111-1111-4111-8111-111111111117',
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111116',
  '260824-DEMO',
  308,
  300,
  'ACTIVE',
  true
)
ON CONFLICT (id) DO NOTHING;

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
