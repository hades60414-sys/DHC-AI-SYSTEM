-- ASTRA-004 / DEC-RUN-01：Run 綁定申請者建立當下的 auth_epoch；結果提交時 epoch／狀態／權限不符 → 結果隔離，不發布。
-- 既有（0008 之前建立）的 Run requester_auth_epoch 為 NULL：worker 視為授權無法驗證，fail closed。
ALTER TABLE enterprise.runs ADD COLUMN requester_auth_epoch integer CHECK (requester_auth_epoch IS NULL OR requester_auth_epoch >= 0);
ALTER TABLE enterprise.runs DROP CONSTRAINT runs_status_check;
ALTER TABLE enterprise.runs ADD CONSTRAINT runs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'quarantined'));
ALTER TABLE enterprise.drafts DROP CONSTRAINT drafts_status_check;
ALTER TABLE enterprise.drafts ADD CONSTRAINT drafts_status_check CHECK (status IN ('generating', 'draft', 'submitted', 'approved', 'rejected', 'failed', 'quarantined'));

-- 隔離內容與正常草稿修訂分表：不會出現在草稿、送審、匯出或檢索；丟棄時清除內容只留中繼資料。
CREATE TABLE enterprise.run_quarantine (
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  run_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^ENTERPRISE_[A-Z_]+$'),
  requester_auth_epoch integer CHECK (requester_auth_epoch IS NULL OR requester_auth_epoch >= 0),
  observed_auth_epoch integer CHECK (observed_auth_epoch IS NULL OR observed_auth_epoch >= 0),
  body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 200000),
  citations jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(citations) = 'array'),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'discarded')),
  decided_by_member_id uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, run_id),
  CHECK ((status = 'held') = (decided_by_member_id IS NULL)),
  CHECK ((status = 'held') = (decided_at IS NULL)),
  CHECK ((status = 'discarded') = (body IS NULL)),
  FOREIGN KEY (organization_id, run_id) REFERENCES enterprise.runs(organization_id, id),
  FOREIGN KEY (organization_id, draft_id) REFERENCES enterprise.drafts(organization_id, id),
  FOREIGN KEY (organization_id, decided_by_member_id) REFERENCES enterprise.org_members(organization_id, id)
);
ALTER TABLE enterprise.run_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise.run_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_scope ON enterprise.run_quarantine
  USING (organization_id = nullif(current_setting('dhc.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('dhc.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON enterprise.run_quarantine TO dhc_app;
GRANT UPDATE (status, body, citations, decided_by_member_id, decided_at) ON enterprise.run_quarantine TO dhc_app;
GRANT UPDATE (requester_auth_epoch) ON enterprise.runs TO dhc_app;
