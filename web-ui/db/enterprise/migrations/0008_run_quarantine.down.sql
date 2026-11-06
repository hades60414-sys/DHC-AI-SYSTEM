-- 有 quarantined 狀態的資料時，重建原 CHECK 會失敗，整個 down 交易回退（不會默默改寫狀態）。
DROP TABLE enterprise.run_quarantine;
ALTER TABLE enterprise.drafts DROP CONSTRAINT drafts_status_check;
ALTER TABLE enterprise.drafts ADD CONSTRAINT drafts_status_check CHECK (status IN ('generating', 'draft', 'submitted', 'approved', 'rejected', 'failed'));
ALTER TABLE enterprise.runs DROP CONSTRAINT runs_status_check;
ALTER TABLE enterprise.runs ADD CONSTRAINT runs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'));
ALTER TABLE enterprise.runs DROP COLUMN requester_auth_epoch;
