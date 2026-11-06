-- DOC-02：文件文字擷取與切塊索引。每個 chunk 綁定具體 document_version，引用可回到版本與位置並以 text_sha256 驗證。
ALTER TABLE enterprise.document_versions ADD CONSTRAINT document_versions_organization_scope_key UNIQUE (organization_id, id);

CREATE TABLE enterprise.document_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  document_version_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  extractor text NOT NULL CHECK (extractor ~ '^[a-z0-9-]+@[0-9]+$'),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'unsupported')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^ENTERPRISE_[A-Z_]+$'),
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count BETWEEN 0 AND 5000),
  created_by_member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, document_version_id, attempt),
  CHECK ((status = 'succeeded') = (error_code IS NULL)),
  FOREIGN KEY (organization_id, document_version_id) REFERENCES enterprise.document_versions(organization_id, id),
  FOREIGN KEY (organization_id, created_by_member_id) REFERENCES enterprise.org_members(organization_id, id)
);

CREATE TABLE enterprise.document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  extraction_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 4999),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  location jsonb NOT NULL CHECK (jsonb_typeof(location) = 'object'),
  UNIQUE (organization_id, extraction_id, chunk_index),
  FOREIGN KEY (organization_id, extraction_id) REFERENCES enterprise.document_extractions(organization_id, id),
  FOREIGN KEY (organization_id, document_version_id) REFERENCES enterprise.document_versions(organization_id, id)
);
CREATE INDEX document_chunks_version_idx ON enterprise.document_chunks(organization_id, document_version_id);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['document_extractions','document_chunks'] LOOP
    EXECUTE format('ALTER TABLE enterprise.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE enterprise.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY organization_scope ON enterprise.%I USING (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid)',
      table_name);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON enterprise.document_extractions, enterprise.document_chunks TO dhc_app;
