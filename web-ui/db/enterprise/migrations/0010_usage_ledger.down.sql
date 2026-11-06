-- 有 model_usage 稽核事件時，恢復舊 resource_type CHECK 會失敗，down 交易整體回退。
ALTER TABLE enterprise.audit_events DROP CONSTRAINT audit_events_resource_type_check;
ALTER TABLE enterprise.audit_events ADD CONSTRAINT audit_events_resource_type_check CHECK (resource_type IN ('task', 'document', 'member', 'session', 'draft', 'run', 'model_provider', 'subscription'));
-- 有 reserved／unknown（成本 NULL）的列時，恢復 NOT NULL 與舊 CHECK 會失敗，down 交易整體回退。
ALTER TABLE enterprise.model_usage DROP CONSTRAINT model_usage_reconciler, DROP CONSTRAINT model_usage_pending, DROP CONSTRAINT model_usage_unknown_cost,
  DROP COLUMN reconcile_note, DROP COLUMN reconciled_at, DROP COLUMN reconciled_by_member_id, DROP COLUMN finished_at, DROP COLUMN reconciled_state,
  DROP COLUMN usage_source, DROP COLUMN reserved_micros, DROP COLUMN output_price_micros_per_mtok, DROP COLUMN input_price_micros_per_mtok,
  DROP COLUMN price_effective_at, DROP COLUMN price_source, DROP COLUMN price_version, DROP COLUMN model, DROP COLUMN run_attempt;
ALTER TABLE enterprise.model_usage ALTER COLUMN cost_micros SET NOT NULL;
ALTER TABLE enterprise.model_usage DROP CONSTRAINT model_usage_status_check;
ALTER TABLE enterprise.model_usage ADD CONSTRAINT model_usage_status_check CHECK (status IN ('succeeded', 'failed', 'denied'));
ALTER TABLE enterprise.model_providers DROP COLUMN price_effective_at, DROP COLUMN price_source, DROP COLUMN price_version;
