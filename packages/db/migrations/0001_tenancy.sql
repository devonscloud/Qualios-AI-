-- 0001_tenancy.sql — Tenancy and identity (Data Model §1)
-- UP
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Shared updated_at trigger: every table gets updated_at maintained by the DB.
CREATE OR REPLACE FUNCTION qualios_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TYPE organization_status AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE site_status AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE user_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');
CREATE TYPE membership_status AS ENUM ('ACTIVE', 'REVOKED');

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  licence_number text,
  country text NOT NULL DEFAULT 'CA',
  currency text NOT NULL DEFAULT 'CAD',
  status organization_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name text NOT NULL,
  address text,
  timezone text NOT NULL DEFAULT 'America/Regina',
  status site_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX sites_organization_id_idx ON sites (organization_id);
CREATE TRIGGER sites_updated_at
  BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  mfa_enrolled boolean NOT NULL DEFAULT false,
  status user_status NOT NULL DEFAULT 'INVITED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL organization_id = platform role (e.g. PLATFORM_OPERATOR).
  organization_id uuid REFERENCES organizations (id),
  name text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE TRIGGER roles_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  -- NULL site_id = all sites in the organization.
  site_id uuid REFERENCES sites (id),
  role_id uuid NOT NULL REFERENCES roles (id),
  status membership_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id, site_id, role_id)
);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);
CREATE INDEX memberships_organization_id_idx ON memberships (organization_id);
CREATE TRIGGER memberships_updated_at
  BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

-- Row-level security (ADR-004 / ADR-008 layer 2).
-- Application code sets app.current_organization_id per session/transaction.
-- Tables without organization_id (users) are not tenant-scoped at the DB layer;
-- access to user records is gated by membership rows.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_tenant_isolation ON organizations
  USING (id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY sites_tenant_isolation ON sites
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY roles_tenant_isolation ON roles
  USING (
    organization_id IS NULL
    OR organization_id = current_setting('app.current_organization_id', true)::uuid
  );
CREATE POLICY memberships_tenant_isolation ON memberships
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);

-- DOWN
DROP POLICY IF EXISTS memberships_tenant_isolation ON memberships;
DROP POLICY IF EXISTS roles_tenant_isolation ON roles;
DROP POLICY IF EXISTS sites_tenant_isolation ON sites;
DROP POLICY IF EXISTS organizations_tenant_isolation ON organizations;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS sites;
DROP TABLE IF EXISTS organizations;
DROP TYPE IF EXISTS membership_status;
DROP TYPE IF EXISTS user_status;
DROP TYPE IF EXISTS site_status;
DROP TYPE IF EXISTS organization_status;
DROP FUNCTION IF EXISTS qualios_set_updated_at();
