-- 0003_documents.sql — Documents, versions, extraction (Data Model §3)
-- UP
CREATE TYPE document_type AS ENUM (
  'BATCH_RECORD', 'PACKING_SLIP', 'COA', 'TRANSFER_RECORD', 'INVOICE', 'LISTING_FORM', 'OTHER'
);
CREATE TYPE document_status AS ENUM (
  'UPLOADED', 'EXTRACTING', 'AWAITING_VERIFICATION', 'VERIFIED', 'REJECTED'
);
CREATE TYPE verification_status AS ENUM ('UNVERIFIED', 'CONFIRMED', 'CORRECTED', 'REJECTED');

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  uploaded_by uuid NOT NULL REFERENCES users (id),
  storage_key text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  sha256 text NOT NULL,
  document_type document_type NOT NULL DEFAULT 'OTHER',
  linked_lot_id uuid REFERENCES lots (id),
  linked_batch_id uuid REFERENCES batches (id),
  status document_status NOT NULL DEFAULT 'UPLOADED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX documents_organization_id_idx ON documents (organization_id);
CREATE INDEX documents_linked_lot_id_idx ON documents (linked_lot_id);
CREATE TRIGGER documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents (id),
  version_number integer NOT NULL,
  storage_key text NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  change_note text,
  UNIQUE (document_id, version_number)
);
CREATE INDEX document_versions_document_id_idx ON document_versions (document_id);

CREATE TABLE extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents (id),
  field_name text NOT NULL,
  extracted_value text NOT NULL,
  confidence numeric(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  verification_status verification_status NOT NULL DEFAULT 'UNVERIFIED',
  verified_by uuid REFERENCES users (id),
  verified_at timestamptz,
  model_version text NOT NULL,
  source_location text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extractions_document_id_idx ON extractions (document_id);
CREATE TRIGGER extractions_updated_at
  BEFORE UPDATE ON extractions
  FOR EACH ROW EXECUTE FUNCTION qualios_set_updated_at();

-- inventory_movements.document_id FK, deferred from 0002 (documents did not exist yet).
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_document_id_fk
  FOREIGN KEY (document_id) REFERENCES documents (id);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE extractions ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_tenant_isolation ON documents
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE POLICY document_versions_tenant_isolation ON document_versions
  USING (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_versions.document_id
        AND d.organization_id = current_setting('app.current_organization_id', true)::uuid
    )
  );
CREATE POLICY extractions_tenant_isolation ON extractions
  USING (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = extractions.document_id
        AND d.organization_id = current_setting('app.current_organization_id', true)::uuid
    )
  );

-- DOWN
DROP POLICY IF EXISTS extractions_tenant_isolation ON extractions;
DROP POLICY IF EXISTS document_versions_tenant_isolation ON document_versions;
DROP POLICY IF EXISTS documents_tenant_isolation ON documents;
ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_document_id_fk;
DROP TABLE IF EXISTS extractions;
DROP TABLE IF EXISTS document_versions;
DROP TABLE IF EXISTS documents;
DROP TYPE IF EXISTS verification_status;
DROP TYPE IF EXISTS document_status;
DROP TYPE IF EXISTS document_type;
