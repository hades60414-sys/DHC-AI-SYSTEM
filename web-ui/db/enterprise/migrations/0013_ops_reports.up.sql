-- V5 OPS-REPORT-v1：確定性營運週報結果。來源為 1–5 個不可變文件版本（hash 一併固定），結果由伺服器計算後只新增不修改
-- （dhc_app 無 UPDATE／DELETE）。同組織、同規則、同週別、同一組來源版本與案例集（input_key）的成功結果唯一，重送回原結果。
-- 拒收也留一筆（含錯誤清單）供稽核追溯。來源以子表＋同組織複合外鍵綁定 document_versions（陣列欄位做不到外鍵）。
CREATE TABLE enterprise.ops_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  rule_version text NOT NULL CHECK (rule_version = 'OPS-REPORT-v1'),
  iso_week text NOT NULL CHECK (iso_week ~ '^[0-9]{4}-W[0-9]{2}$'),
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end = period_start + 6),
  datasets text[] NOT NULL CHECK (cardinality(datasets) BETWEEN 1 AND 5),
  input_key text NOT NULL CHECK (input_key ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('completed', 'rejected')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, created_by_member_id) REFERENCES enterprise.org_members(organization_id, id)
);
CREATE UNIQUE INDEX ops_reports_completed_once_idx ON enterprise.ops_reports(organization_id, rule_version, iso_week, input_key) WHERE status = 'completed';
CREATE INDEX ops_reports_recent_idx ON enterprise.ops_reports(organization_id, created_at DESC, id);

CREATE TABLE enterprise.ops_report_sources (
  organization_id uuid NOT NULL,
  ops_report_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 5),
  document_version_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (organization_id, ops_report_id, position),
  UNIQUE (organization_id, ops_report_id, document_version_id),
  FOREIGN KEY (organization_id, ops_report_id) REFERENCES enterprise.ops_reports(organization_id, id),
  FOREIGN KEY (organization_id, document_version_id) REFERENCES enterprise.document_versions(organization_id, id)
);

ALTER TABLE enterprise.ops_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise.ops_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_scope ON enterprise.ops_reports
  USING (organization_id = nullif(current_setting('dhc.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('dhc.organization_id', true), '')::uuid);
ALTER TABLE enterprise.ops_report_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise.ops_report_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_scope ON enterprise.ops_report_sources
  USING (organization_id = nullif(current_setting('dhc.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('dhc.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON enterprise.ops_reports, enterprise.ops_report_sources TO dhc_app;

ALTER TABLE enterprise.audit_events DROP CONSTRAINT audit_events_resource_type_check;
ALTER TABLE enterprise.audit_events ADD CONSTRAINT audit_events_resource_type_check CHECK (resource_type IN ('task', 'document', 'member', 'session', 'draft', 'run', 'model_provider', 'subscription', 'model_usage', 'reconciliation', 'ops_report'));
