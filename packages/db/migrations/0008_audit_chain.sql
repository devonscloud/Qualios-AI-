-- 0008_audit_chain.sql — Audit-event hash chain hardening + document-review approvals
-- (Data Model §7, Threat Model T-02/T-06, Sprint Days 12–18)
--
-- What this adds:
--  1. audit_events.event_hash — SHA-256 of the canonical event content, computed
--     by the application (packages/db/src/audit.ts) at insert time. Together with
--     previous_hash it forms a per-organization hash chain for tamper detection.
--  2. audit_events.seq — a per-table identity sequence giving a strict total
--     order (insertion order). The chain is verified in (organization_id, seq)
--     order; created_at alone is not a safe order because two events can share
--     a timestamp.
--  3. Append-only triggers on audit_events: UPDATE and DELETE raise an
--     exception. (TRUNCATE is not blocked by a trigger — it requires a
--     separate privilege control; see packages/db/README.md.)
--  4. approval_action_type gains DOCUMENT_REVIEW, so a document review
--     decision is recorded as an Approval row (sprint Days 12–18).
--
-- Why event_hash is NOT NULL: audit_events has never been written by any
-- code before this step (no API route wrote audit events in the Days 7–12
-- scaffold, and no seed inserts them), so every database this migration can
-- run against has zero rows in the table. Adding a NOT NULL column to an
-- empty table is safe; if a row ever did exist, the migration would fail
-- loudly instead of silently backfilling a wrong hash.
--
-- Why the enum is recreated instead of ALTER TYPE ... ADD VALUE: ADD VALUE
-- cannot run inside a transaction block, and the migrate runner wraps each
-- migration in one transaction. Recreating the type is the transactional way.
-- UP

-- 1. Recreate approval_action_type with DOCUMENT_REVIEW added.
CREATE TYPE approval_action_type_new AS ENUM (
  'DISCREPANCY_RESOLUTION', 'RECONCILIATION_APPROVE', 'LISTING_APPROVE',
  'EXCISE_FINALIZE', 'BATCH_RELEASE', 'DOCUMENT_REVIEW'
);
ALTER TABLE approvals
  ALTER COLUMN action_type TYPE approval_action_type_new
  USING action_type::text::approval_action_type_new;
DROP TYPE approval_action_type;
ALTER TYPE approval_action_type_new RENAME TO approval_action_type;

-- 2. Hash-chain columns on audit_events.
ALTER TABLE audit_events ADD COLUMN event_hash text NOT NULL;
ALTER TABLE audit_events ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX audit_events_chain_idx ON audit_events (organization_id, seq);

-- 3. Append-only enforcement: UPDATE and DELETE are rejected by the database.
CREATE OR REPLACE FUNCTION qualios_audit_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION qualios_audit_events_immutable();
CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION qualios_audit_events_immutable();

-- DOWN
DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;
DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
DROP FUNCTION IF EXISTS qualios_audit_events_immutable();
DROP INDEX IF EXISTS audit_events_chain_idx;
ALTER TABLE audit_events DROP COLUMN IF EXISTS seq;
ALTER TABLE audit_events DROP COLUMN IF EXISTS event_hash;

CREATE TYPE approval_action_type_old AS ENUM (
  'DISCREPANCY_RESOLUTION', 'RECONCILIATION_APPROVE', 'LISTING_APPROVE',
  'EXCISE_FINALIZE', 'BATCH_RELEASE'
);
ALTER TABLE approvals
  ALTER COLUMN action_type TYPE approval_action_type_old
  USING action_type::text::approval_action_type_old;
DROP TYPE approval_action_type;
ALTER TYPE approval_action_type_old RENAME TO approval_action_type;
