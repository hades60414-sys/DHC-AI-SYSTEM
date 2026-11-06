-- PLAN-01：方案權益與人工帳務紀錄。訂閱只能由供應商端（migrator CLI）修改；runtime 只能讀，避免客戶自行調整權益。
CREATE TABLE enterprise.subscriptions (
  organization_id uuid PRIMARY KEY REFERENCES enterprise.organizations(id),
  plan_key text NOT NULL CHECK (plan_key IN ('pilot', 'studio', 'team', 'business', 'private')),
  status text NOT NULL CHECK (status IN ('trial', 'active', 'grace', 'expired', 'cancelled')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('byok', 'managed')),
  seat_limit integer NOT NULL CHECK (seat_limit BETWEEN 1 AND 10000),
  workflow_limit integer NOT NULL CHECK (workflow_limit BETWEEN 0 AND 1000),
  monthly_run_limit integer NOT NULL CHECK (monthly_run_limit BETWEEN 0 AND 10000000),
  storage_limit_bytes bigint NOT NULL CHECK (storage_limit_bytes >= 0),
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  grace_until date CHECK (grace_until IS NULL OR grace_until >= period_end),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE enterprise.subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  before jsonb, after jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE enterprise.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  period_start date NOT NULL, period_end date NOT NULL CHECK (period_end >= period_start),
  amount_ntd bigint NOT NULL CHECK (amount_ntd >= 0),
  state text NOT NULL CHECK (state IN ('draft', 'issued', 'paid', 'void')),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['subscriptions','subscription_events','invoices'] LOOP
    EXECUTE format('ALTER TABLE enterprise.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE enterprise.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY organization_scope ON enterprise.%I USING (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid)',
      table_name);
  END LOOP;
END $$;
GRANT SELECT ON enterprise.subscriptions, enterprise.subscription_events, enterprise.invoices TO dhc_app;
