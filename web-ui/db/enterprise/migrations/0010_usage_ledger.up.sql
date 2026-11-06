-- ASTRA-008：attempt 級用量帳。model_usage 每列＝一次實際（或被拒的）HTTP 呼叫：
-- reserved（呼叫前、預算鎖下寫入最壞情況預留）→ succeeded／failed／unknown；denied＝未送出。
-- unknown（逾時、送出後斷線、回應不完整、worker 中斷）成本為 NULL、預留額度持續計入預算，直到管理員對帳。
ALTER TABLE enterprise.model_providers
  ADD COLUMN price_version integer NOT NULL DEFAULT 1 CHECK (price_version >= 1),
  ADD COLUMN price_source text NOT NULL DEFAULT 'unspecified' CHECK (length(btrim(price_source)) BETWEEN 1 AND 200),
  ADD COLUMN price_effective_at timestamptz NOT NULL DEFAULT now();
GRANT UPDATE (price_version, price_source, price_effective_at) ON enterprise.model_providers TO dhc_app;

ALTER TABLE enterprise.model_usage DROP CONSTRAINT model_usage_status_check;
ALTER TABLE enterprise.model_usage ADD CONSTRAINT model_usage_status_check CHECK (status IN ('reserved', 'succeeded', 'failed', 'denied', 'unknown'));
ALTER TABLE enterprise.model_usage ALTER COLUMN cost_micros DROP NOT NULL;
ALTER TABLE enterprise.model_usage
  ADD COLUMN run_attempt integer CHECK (run_attempt IS NULL OR run_attempt BETWEEN 1 AND 10),
  ADD COLUMN model text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200),
  ADD COLUMN price_version integer CHECK (price_version IS NULL OR price_version >= 1),
  ADD COLUMN price_source text CHECK (price_source IS NULL OR length(price_source) BETWEEN 1 AND 200),
  ADD COLUMN price_effective_at timestamptz,
  ADD COLUMN input_price_micros_per_mtok bigint CHECK (input_price_micros_per_mtok IS NULL OR input_price_micros_per_mtok >= 0),
  ADD COLUMN output_price_micros_per_mtok bigint CHECK (output_price_micros_per_mtok IS NULL OR output_price_micros_per_mtok >= 0),
  ADD COLUMN reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  ADD COLUMN usage_source text CHECK (usage_source IS NULL OR usage_source IN ('provider_reported', 'estimated', 'reconciled', 'none')),
  ADD COLUMN reconciled_state text NOT NULL DEFAULT 'final' CHECK (reconciled_state IN ('final', 'pending_reconciliation')),
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN reconciled_by_member_id uuid,
  ADD COLUMN reconciled_at timestamptz,
  ADD COLUMN reconcile_note text CHECK (reconcile_note IS NULL OR length(btrim(reconcile_note)) BETWEEN 1 AND 500),
  ADD CONSTRAINT model_usage_unknown_cost CHECK ((status IN ('reserved', 'unknown')) = (cost_micros IS NULL)),
  ADD CONSTRAINT model_usage_pending CHECK (status NOT IN ('reserved', 'unknown') OR reconciled_state = 'pending_reconciliation'),
  ADD CONSTRAINT model_usage_reconciler FOREIGN KEY (organization_id, reconciled_by_member_id) REFERENCES enterprise.org_members(organization_id, id);
GRANT UPDATE (status, input_tokens, output_tokens, cost_micros, usage_source, reconciled_state, finished_at, error_code,
  reconciled_by_member_id, reconciled_at, reconcile_note) ON enterprise.model_usage TO dhc_app;

-- 對帳事件需要 model_usage 資源類型。
ALTER TABLE enterprise.audit_events DROP CONSTRAINT audit_events_resource_type_check;
ALTER TABLE enterprise.audit_events ADD CONSTRAINT audit_events_resource_type_check CHECK (resource_type IN ('task', 'document', 'member', 'session', 'draft', 'run', 'model_provider', 'subscription', 'model_usage'));
