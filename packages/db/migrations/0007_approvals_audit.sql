-- 0007_approvals_audit.sql — Approvals, append-only audit events, AI interaction log (Data Model §7–8)
-- AuditEvent rows are append-only: never updated, never deleted.
-- The hash chain (previous_hash) supports tamper detection.
-- UP
CREATE TYPE approval_action_type AS ENUM (
  'DISCREPANCY_RESOLUTION', 'RECONCILIATION_APPROVE', 'LISTING_APPROVE',
  'EXCISE_FINALIZE', 'BATCH_RELEASE'
);
CREATE TYPE approval_decision AS ENUM ('APPROVED', 'REJECTED');

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  action_type approval_action_type NOT NULL,
  target_id uuid NOT NULL,
  target_type text NOT NULL,
  approver_id uuid NOT NULL REFERENCES users (id),
  decision approval_decision NOT NULL,
  note text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX approvals_organization_id_idx ON approvals (organization_id);
CREATE INDEX approvals_target_idx ON approvals (target_type, target_id);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  actor_id uuid REFERENCES users (id),
  event_type text NOT NULL,
  target_type text,
  target_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  previous_hash text
);
CREATE INDEX audit_events_organization_id_idx ON audit_events (organization_id);
CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id);
CREATE INDEX audit_events_created_at_idx ON audit_events (created_at);

CREATE TABLE ai_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id uuid NOT NULL REFERENCES users (id),
  question text NOT NULL,
  answer text NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_sufficient boolean NOT NULL DEFAULT false,
  model_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_interactions_organization_id_idx ON ai_interactions (organization_id);

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY approvals_tenant_isolation ON approvals
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY audit_events_tenant_isolation ON audit_events
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY ai_interactions_tenant_isolation ON ai_interactions
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);

-- DOWN
DROP POLICY IF EXISTS ai_interactions_tenant_isolation ON ai_interactions;
DROP POLICY IF EXISTS audit_events_tenant_isolation ON audit_events;
DROP POLICY IF EXISTS approvals_tenant_isolation ON approvals;
DROP TABLE IF EXISTS ai_interactions;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS approvals;
DROP TYPE IF EXISTS approval_decision;
DROP TYPE IF EXISTS approval_action_type;
