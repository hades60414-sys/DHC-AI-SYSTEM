-- IAM-01（候選契約，RD-003 未批准）：Enterprise PG 為企業模式的帳號主檔；本機密碼憑證為過渡方案，OIDC 另行接入。
-- 撤權：org_members.auth_epoch 在停權、角色變更時遞增；session 記錄建立當下的 epoch，不符即失效。
ALTER TABLE enterprise.org_members ADD COLUMN auth_epoch integer NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0);

-- 登入前尚未知道組織 id：只允許以 transaction-local dhc.login_slug 讀取「該 slug」的那一列，其他組織仍不可見。
CREATE POLICY login_slug_lookup ON enterprise.organizations FOR SELECT
  USING (slug = nullif(current_setting('dhc.login_slug', true), ''));

CREATE TABLE enterprise.account_credentials (
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  user_account_id uuid NOT NULL,
  -- scrypt$N$r$p$salt$hash（base64url）；格式由應用程式驗證。
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]{20,}\$[A-Za-z0-9_-]{40,}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at),
  PRIMARY KEY (organization_id, user_account_id),
  FOREIGN KEY (organization_id, user_account_id) REFERENCES enterprise.user_accounts(organization_id, id)
);

CREATE TABLE enterprise.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  org_member_id uuid NOT NULL,
  -- 只存 token secret 的 SHA-256；原始 token 只在登入回應出現一次。
  token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  member_auth_epoch integer NOT NULL CHECK (member_auth_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at timestamptz CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, org_member_id) REFERENCES enterprise.org_members(organization_id, id)
);
CREATE INDEX auth_sessions_member_idx ON enterprise.auth_sessions(organization_id, org_member_id);

-- audit 可記錄成員與 session 相關事件
ALTER TABLE enterprise.audit_events DROP CONSTRAINT audit_events_resource_type_check;
ALTER TABLE enterprise.audit_events ADD CONSTRAINT audit_events_resource_type_check
  CHECK (resource_type IN ('task', 'document', 'member', 'session'));

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['account_credentials','auth_sessions'] LOOP
    EXECUTE format('ALTER TABLE enterprise.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE enterprise.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY organization_scope ON enterprise.%I USING (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid)',
      table_name);
  END LOOP;
END $$;

-- runtime 身分管理權限（候選，受 RLS 限於已核對組織；誰能呼叫由服務層 RBAC 決定）。
-- 仍不授予：organizations/roles 寫入、任何 DELETE（角色關聯除外）、TRUNCATE、DDL。
GRANT SELECT, INSERT ON enterprise.account_credentials, enterprise.auth_sessions TO dhc_app;
GRANT UPDATE (password_hash, updated_at) ON enterprise.account_credentials TO dhc_app;
GRANT UPDATE (revoked_at) ON enterprise.auth_sessions TO dhc_app;
GRANT INSERT ON enterprise.user_accounts, enterprise.org_members, enterprise.org_member_roles TO dhc_app;
GRANT UPDATE (status, updated_at) ON enterprise.user_accounts TO dhc_app;
GRANT UPDATE (status, auth_epoch, updated_at) ON enterprise.org_members TO dhc_app;
GRANT DELETE ON enterprise.org_member_roles TO dhc_app;
