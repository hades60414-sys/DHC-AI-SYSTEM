-- 有 reconciliation 稽核事件時重建 CHECK 會失敗，整個 down 交易回退（不默默刪稽核）。
ALTER TABLE enterprise.audit_events DROP CONSTRAINT audit_events_resource_type_check;
ALTER TABLE enterprise.audit_events ADD CONSTRAINT audit_events_resource_type_check CHECK (resource_type IN ('task', 'document', 'member', 'session', 'draft', 'run', 'model_provider', 'subscription', 'model_usage'));
DROP TABLE enterprise.reconciliations;
