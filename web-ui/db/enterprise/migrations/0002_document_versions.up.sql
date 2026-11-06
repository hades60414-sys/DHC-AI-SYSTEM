-- E05-DOC-01：文件版本與內容 blob metadata。內容本體在 storage adapter，不放資料庫。
-- 所有關聯都帶 organization_id 的複合 FK，讓跨組織引用在資料層就失敗。
ALTER TABLE enterprise.documents ADD CONSTRAINT documents_organization_scope_key UNIQUE (organization_id, id);

CREATE TABLE enterprise.document_blobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 104857600),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  -- 去重只在同一組織內；不同組織相同內容各自一列，避免跨租戶存在性探測。
  UNIQUE (organization_id, sha256)
);

CREATE TABLE enterprise.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  document_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number BETWEEN 1 AND 100000),
  blob_id uuid NOT NULL,
  filename text NOT NULL CHECK (length(btrim(filename)) BETWEEN 1 AND 255 AND filename !~ '[/\\[:cntrl:]]'),
  -- 與 document-content.policy.ts 的 allowlist 一致；放寬型別須同時改程式與新 migration。
  media_type text NOT NULL CHECK (media_type IN (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/png', 'image/jpeg', 'text/plain', 'text/markdown', 'text/csv')),
  created_by_member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, document_id) REFERENCES enterprise.documents(organization_id, id),
  FOREIGN KEY (organization_id, blob_id) REFERENCES enterprise.document_blobs(organization_id, id),
  FOREIGN KEY (organization_id, created_by_member_id) REFERENCES enterprise.org_members(organization_id, id),
  UNIQUE (organization_id, document_id, version_number)
);
CREATE INDEX document_versions_blob_idx ON enterprise.document_versions(organization_id, blob_id);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['document_blobs','document_versions'] LOOP
    EXECUTE format('ALTER TABLE enterprise.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE enterprise.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY organization_scope ON enterprise.%I USING (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid)',
      table_name);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON enterprise.document_blobs, enterprise.document_versions TO dhc_app;
-- 版本與 blob 是追加式紀錄：不授予 runtime UPDATE/DELETE/TRUNCATE。
