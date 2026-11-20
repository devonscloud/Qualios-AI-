-- 0010_sop_training.sql — SOP publish lifecycle + training (Data Model §3–§4, B-201–B-204)
-- Industry-neutral core: an SOP is a generic document (document_type 'SOP');
-- training is assignment/completion/verification of a document version.
-- No industry-specific concept is introduced here.
--
-- What this adds:
--  1. document_type gains generic values SOP, POLICY, FORM, MANUAL (ALTER TYPE
--     ... ADD VALUE, following 0009: the new values are not used by any
--     statement in this migration, so they become usable after commit).
--  2. documents gains publish fields: effective_version_id (the one version
--     that is currently EFFECTIVE), effective_from, published_at,
--     published_by. The verification lifecycle (status enum) is unchanged:
--     a version must be VERIFIED before it can be published.
--  3. approval_action_type gains SOP_PUBLISH and TRAINING_VERIFY.
--  4. training_assignments + training_completions (Data Model §4).
--     An assignment is always against one specific document version.
--     A partial unique index prevents two OPEN assignments for the same
--     (document, version, assignee); re-assignment after completion is
--     allowed (refresher/retraining).
--  5. RLS policies on both new tables, keyed on organization_id.
-- UP

-- 1. Generic document types.
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'SOP';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'POLICY';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'FORM';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'MANUAL';

-- 2. SOP publish fields on documents.
ALTER TABLE documents
  ADD COLUMN effective_version_id uuid REFERENCES document_versions (id),
  ADD COLUMN effective_from timestamptz,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN published_by uuid REFERENCES users (id);
CREATE INDEX documents_effective_version_id_idx ON documents (effective_version_id);

-- 3. Approval action types for publish and training verification.
ALTER TYPE approval_action_type ADD VALUE IF NOT EXISTS 'SOP_PUBLISH';
ALTER TYPE approval_action_type ADD VALUE IF NOT EXISTS 'TRAINING_VERIFY';

-- 4. Training tables.
CREATE TYPE training_assignment_status AS ENUM (
  'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'EXEMPTED'
);

CREATE TABLE training_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  document_id uuid NOT NULL REFERENCES documents (id),
  version_number integer NOT NULL CHECK (version_number >= 1),
  assignee_id uuid NOT NULL REFERENCES users (id),
  assigned_by uuid NOT NULL REFERENCES users (id),
  due_at timestamptz NOT NULL,
  status training_assignment_status NOT NULL DEFAULT 'ASSIGNED',
  completed_at timestamptz,
  verified_by uuid REFERENCES users (id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX training_assignments_organization_id_idx
  ON training_assignments (organization_id);
CREATE INDEX training_assignments_document_id_idx
  ON training_assignments (document_id);
CREATE INDEX training_assignments_assignee_id_idx
  ON training_assignments (assignee_id);
CREATE INDEX training_assignments_status_idx
  ON training_assignments (status);
-- One open assignment per (document, version, assignee). Completed,
-- exempted, or overdue-closed assignments do not block a fresh assignment
-- (refresher/retraining). OVERDUE is reported by the API from due_at and
-- is not maintained as a stored transition in this increment.
CREATE UNIQUE INDEX training_assignments_one_open_idx
  ON training_assignments (document_id, version_number, assignee_id)
  WHERE status IN ('ASSIGNED', 'IN_PROGRESS');
CREATE TRIGGER training_assignments_updated_at
  BEFORE UPDATE ON training_assignments
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE training_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES training_assignments (id),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id uuid NOT NULL REFERENCES users (id),
  document_id uuid NOT NULL REFERENCES documents (id),
  version_number integer NOT NULL CHECK (version_number >= 1),
  acknowledgement boolean NOT NULL DEFAULT false,
  assessment_score integer CHECK (assessment_score >= 0 AND assessment_score <= 100),
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id)
);
CREATE INDEX training_completions_organization_id_idx
  ON training_completions (organization_id);
CREATE INDEX training_completions_assignment_id_idx
  ON training_completions (assignment_id);
CREATE INDEX training_completions_user_id_idx
  ON training_completions (user_id);

-- 5. RLS.
ALTER TABLE training_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY training_assignments_tenant_isolation ON training_assignments
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY training_completions_tenant_isolation ON training_completions
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);

-- DOWN
DROP POLICY IF EXISTS training_completions_tenant_isolation ON training_completions;
DROP POLICY IF EXISTS training_assignments_tenant_isolation ON training_assignments;
DROP TABLE IF EXISTS training_completions;
DROP TRIGGER IF EXISTS training_assignments_updated_at ON training_assignments;
DROP TABLE IF EXISTS training_assignments;
DROP TYPE IF EXISTS training_assignment_status;
DROP INDEX IF EXISTS documents_effective_version_id_idx;
ALTER TABLE documents
  DROP COLUMN IF EXISTS published_by,
  DROP COLUMN IF EXISTS published_at,
  DROP COLUMN IF EXISTS effective_from,
  DROP COLUMN IF EXISTS effective_version_id;
-- NOTE: enum values added with ALTER TYPE ... ADD VALUE cannot be removed
-- by a DOWN migration without recreating the enum (see 0008 for the
-- pattern). The DOWN below intentionally leaves 'SOP', 'POLICY', 'FORM',
-- 'MANUAL', 'SOP_PUBLISH', and 'TRAINING_VERIFY' in place: they are inert
-- values no row can reference once the tables/columns above are dropped,
-- and recreating the enums would risk the live approval/document rows.
