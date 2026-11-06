-- W6-B / DEC-W6-SCOPE-01：ACC-MATCH-v1 確定性對帳結果。輸入是兩個不可變的文件版本（內容 hash 一併固定），
-- 結果由伺服器計算後只新增不修改（dhc_app 無 UPDATE／DELETE）；同組織、同兩個版本、同規則、同期間的成功結果唯一，
-- 重送回傳原結果（不會把 9＋9 列變成 18＋18）。拒收也留一筆（含錯誤清單），供 UAT 與稽核追溯。
-- 同組織複合外鍵沿用 0004 建立的 document_versions (organization_id, id) 唯一鍵。
CREATE TABLE enterprise.reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  rule_version text NOT NULL CHECK (rule_version = 'ACC-MATCH-v1'),
  ledger_version_id uuid NOT NULL,
  receipts_version_id uuid NOT NULL,
  ledger_sha256 text NOT NULL CHECK (ledger_sha256 ~ '^[0-9a-f]{64}$'),
  receipts_sha256 text NOT NULL CHECK (receipts_sha256 ~ '^[0-9a-f]{64}$'),
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  status text NOT NULL CHECK (status IN ('completed', 'rejected')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, ledger_version_id) REFERENCES enterprise.document_versions(organization_id, id),
  FOREIGN KEY (organization_id, receipts_version_id) REFERENCES enterprise.document_versions(organization_id, id),
  FOREIGN KEY (organization_id, created_by_member_id) REFERENCES enterprise.org_members(organization_id, id)
);
CREATE UNIQUE INDEX reconciliations_completed_once_idx ON enterprise.reconciliations(organization_id, ledger_version_id, receipts_version_id, rule_version, period_start, period_end)
  WHERE status = 'completed';
ALTER TABLE enterprise.reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise.reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_scope ON enterprise.reconciliations
  USING (organization_id = nullif(current_setting('dhc.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('dhc.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON enterprise.reconciliations TO dhc_app;

ALTER TABLE enterprise.audit_events DROP CONSTRAINT audit_events_resource_type_check;
ALTER TABLE enterprise.audit_events ADD CONSTRAINT audit_events_resource_type_check CHECK (resource_type IN ('task', 'document', 'member', 'session', 'draft', 'run', 'model_provider', 'subscription', 'model_usage', 'reconciliation'));
