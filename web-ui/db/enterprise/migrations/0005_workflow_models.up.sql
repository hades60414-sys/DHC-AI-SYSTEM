-- RUN-01 / MODEL-01 / DOC-03：持久工作、模型 provider 與用量、草稿／審批／匯出。
ALTER TABLE enterprise.audit_events DROP CONSTRAINT audit_events_resource_type_check;
ALTER TABLE enterprise.audit_events ADD CONSTRAINT audit_events_resource_type_check
  CHECK (resource_type IN ('task', 'document', 'member', 'session', 'draft', 'run', 'model_provider', 'subscription'));

CREATE TABLE enterprise.model_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{0,40}$'),
  kind text NOT NULL CHECK (kind IN ('mock', 'openai_compatible', 'anthropic')),
  base_url text CHECK (base_url IS NULL OR base_url ~ '^https?://[^\s]+$'),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  deployment text NOT NULL CHECK (deployment IN ('LOCAL_ONLY', 'CLOUD_ALLOWED')),
  -- 只存 AES-256-GCM 密文（iv.tag.ciphertext base64url）；明文金鑰永不入庫、不回傳。
  api_key_ciphertext text CHECK (api_key_ciphertext IS NULL OR api_key_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  input_price_micros_per_mtok bigint NOT NULL DEFAULT 0 CHECK (input_price_micros_per_mtok >= 0),
  output_price_micros_per_mtok bigint NOT NULL DEFAULT 0 CHECK (output_price_micros_per_mtok >= 0),
  monthly_budget_micros bigint NOT NULL CHECK (monthly_budget_micros >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at),
  UNIQUE (organization_id, id), UNIQUE (organization_id, key)
);

CREATE TABLE enterprise.drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  author_member_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'draft', 'submitted', 'approved', 'rejected', 'failed')),
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, author_member_id) REFERENCES enterprise.org_members(organization_id, id)
);

CREATE TABLE enterprise.draft_revisions (
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  draft_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 200000),
  -- 引用清單：[{chunkId, documentId, versionNumber, excerptSha256}]，產生時由伺服器從檢索結果寫入
  citations jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(citations) = 'array'),
  source text NOT NULL CHECK (source IN ('model', 'human')),
  created_by_member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, draft_id, revision),
  FOREIGN KEY (organization_id, draft_id) REFERENCES enterprise.drafts(organization_id, id),
  FOREIGN KEY (organization_id, created_by_member_id) REFERENCES enterprise.org_members(organization_id, id)
);

CREATE TABLE enterprise.runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  kind text NOT NULL CHECK (kind IN ('draft.generate')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  requested_by_member_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  draft_id uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  cancel_requested boolean NOT NULL DEFAULT false,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^ENTERPRISE_[A-Z_]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, requested_by_member_id, idempotency_key),
  FOREIGN KEY (organization_id, requested_by_member_id) REFERENCES enterprise.org_members(organization_id, id),
  FOREIGN KEY (organization_id, draft_id) REFERENCES enterprise.drafts(organization_id, id)
);
CREATE INDEX runs_queue_idx ON enterprise.runs(status, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE enterprise.model_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  provider_id uuid NOT NULL,
  run_id uuid,
  member_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'denied')),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, provider_id) REFERENCES enterprise.model_providers(organization_id, id),
  FOREIGN KEY (organization_id, run_id) REFERENCES enterprise.runs(organization_id, id),
  FOREIGN KEY (organization_id, member_id) REFERENCES enterprise.org_members(organization_id, id)
);
CREATE INDEX model_usage_period_idx ON enterprise.model_usage(organization_id, provider_id, created_at);

CREATE TABLE enterprise.approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  draft_id uuid NOT NULL,
  revision integer NOT NULL,
  requested_by_member_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by_member_id uuid,
  decision_comment text CHECK (decision_comment IS NULL OR length(decision_comment) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (organization_id, id),
  CHECK ((status = 'pending') = (decided_by_member_id IS NULL)),
  -- 職責分離：送審者不能自己核准
  CHECK (decided_by_member_id IS NULL OR decided_by_member_id <> requested_by_member_id),
  FOREIGN KEY (organization_id, draft_id, revision) REFERENCES enterprise.draft_revisions(organization_id, draft_id, revision),
  FOREIGN KEY (organization_id, requested_by_member_id) REFERENCES enterprise.org_members(organization_id, id),
  FOREIGN KEY (organization_id, decided_by_member_id) REFERENCES enterprise.org_members(organization_id, id)
);
CREATE UNIQUE INDEX approvals_one_pending_idx ON enterprise.approvals(organization_id, draft_id) WHERE status = 'pending';

CREATE TABLE enterprise.draft_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  draft_id uuid NOT NULL,
  revision integer NOT NULL,
  format text NOT NULL CHECK (format IN ('docx', 'markdown')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size > 0),
  exported_by_member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, draft_id, revision) REFERENCES enterprise.draft_revisions(organization_id, draft_id, revision),
  FOREIGN KEY (organization_id, exported_by_member_id) REFERENCES enterprise.org_members(organization_id, id)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['model_providers','drafts','draft_revisions','runs','model_usage','approvals','draft_exports'] LOOP
    EXECUTE format('ALTER TABLE enterprise.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE enterprise.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY organization_scope ON enterprise.%I USING (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid)',
      table_name);
  END LOOP;
END $$;

-- worker 需跨組織找出待處理工作：只開放 runs 的 (id, organization_id) 給 worker 角色？
-- v0.1 選擇：worker 以「每個 active 組織輪詢」方式運作，仍經 GUC 與 RLS；不增加 BYPASSRLS。
GRANT SELECT ON enterprise.organizations TO dhc_app;
CREATE POLICY worker_org_enumeration ON enterprise.organizations FOR SELECT
  USING (current_setting('dhc.worker_enumerate', true) = 'on' AND status = 'active');

GRANT SELECT, INSERT ON enterprise.model_providers, enterprise.drafts, enterprise.draft_revisions, enterprise.runs,
  enterprise.model_usage, enterprise.approvals, enterprise.draft_exports TO dhc_app;
GRANT UPDATE (base_url, model, deployment, api_key_ciphertext, input_price_micros_per_mtok, output_price_micros_per_mtok,
  monthly_budget_micros, enabled, updated_at) ON enterprise.model_providers TO dhc_app;
GRANT UPDATE (status, current_revision, updated_at) ON enterprise.drafts TO dhc_app;
GRANT UPDATE (status, draft_id, attempts, cancel_requested, error_code, started_at, finished_at, updated_at) ON enterprise.runs TO dhc_app;
GRANT UPDATE (status, decided_by_member_id, decision_comment, decided_at) ON enterprise.approvals TO dhc_app;
