-- V5 ACC-MATCH-v1 匯出紀錄：每次匯出都留一筆（格式、內容 SHA-256、位元組數、匯出當下來源是否已有新版本、匯出者）。
-- 只新增不修改（dhc_app 無 UPDATE／DELETE）；同組織複合外鍵綁定 reconciliations 與 org_members。匯出內容本身由已存結果確定性產生，不另存。
CREATE TABLE enterprise.reconciliation_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  reconciliation_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('json', 'csv', 'markdown')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size > 0),
  sources_superseded boolean NOT NULL,
  exported_by_member_id uuid NOT NULL,
  exported_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, reconciliation_id) REFERENCES enterprise.reconciliations(organization_id, id),
  FOREIGN KEY (organization_id, exported_by_member_id) REFERENCES enterprise.org_members(organization_id, id)
);
CREATE INDEX reconciliation_exports_by_reconciliation_idx ON enterprise.reconciliation_exports(organization_id, reconciliation_id, exported_at);
ALTER TABLE enterprise.reconciliation_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise.reconciliation_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_scope ON enterprise.reconciliation_exports
  USING (organization_id = nullif(current_setting('dhc.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('dhc.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON enterprise.reconciliation_exports TO dhc_app;
