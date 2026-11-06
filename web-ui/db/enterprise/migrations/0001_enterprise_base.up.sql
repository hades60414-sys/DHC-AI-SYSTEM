-- 新企業資料；不讀取、修改或遷移 DHC SQLite。
CREATE TABLE enterprise.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{0,62}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at)
);
CREATE TABLE enterprise.user_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at),
  UNIQUE (organization_id, id), UNIQUE (organization_id, email)
);
CREATE TABLE enterprise.org_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  user_account_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at),
  FOREIGN KEY (organization_id, user_account_id) REFERENCES enterprise.user_accounts(organization_id, id),
  UNIQUE (organization_id, id), UNIQUE (organization_id, user_account_id)
);
CREATE TABLE enterprise.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at),
  UNIQUE (organization_id, id), UNIQUE (organization_id, key)
);
CREATE TABLE enterprise.org_member_roles (
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  org_member_id uuid NOT NULL,
  role_id uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, org_member_id, role_id),
  FOREIGN KEY (organization_id, org_member_id) REFERENCES enterprise.org_members(organization_id, id),
  FOREIGN KEY (organization_id, role_id) REFERENCES enterprise.roles(organization_id, id)
);
CREATE INDEX org_member_roles_role_idx ON enterprise.org_member_roles(organization_id, role_id);
CREATE TABLE enterprise.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  owner_member_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at),
  FOREIGN KEY (organization_id, owner_member_id) REFERENCES enterprise.org_members(organization_id, id)
);
CREATE INDEX tasks_scope_created_idx ON enterprise.tasks(organization_id, created_at, id);
CREATE INDEX tasks_owner_idx ON enterprise.tasks(organization_id, owner_member_id);
CREATE TABLE enterprise.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  owner_member_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  classification text NOT NULL DEFAULT 'internal' CHECK (length(btrim(classification)) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at),
  FOREIGN KEY (organization_id, owner_member_id) REFERENCES enterprise.org_members(organization_id, id)
);
CREATE INDEX documents_scope_created_idx ON enterprise.documents(organization_id, created_at, id);
CREATE INDEX documents_owner_idx ON enterprise.documents(organization_id, owner_member_id);
CREATE TABLE enterprise.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  actor_member_id uuid NOT NULL,
  action text NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 100),
  resource_type text NOT NULL CHECK (resource_type IN ('task', 'document')),
  resource_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, actor_member_id) REFERENCES enterprise.org_members(organization_id, id)
);
CREATE INDEX audit_events_scope_time_idx ON enterprise.audit_events(organization_id, occurred_at, id);
CREATE INDEX audit_events_actor_idx ON enterprise.audit_events(organization_id, actor_member_id);

-- RLS 是資料層防線；SET LOCAL 的 scope 必須先由服務核對可信身分與 membership。
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['organizations','user_accounts','org_members','roles','org_member_roles','tasks','documents','audit_events'] LOOP
    EXECUTE format('ALTER TABLE enterprise.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE enterprise.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY organization_scope ON enterprise.%I USING (%I = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid) WITH CHECK (%I = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid)',
      table_name, CASE WHEN table_name = 'organizations' THEN 'id' ELSE 'organization_id' END,
      CASE WHEN table_name = 'organizations' THEN 'id' ELSE 'organization_id' END
    );
  END LOOP;
END $$;
GRANT SELECT ON enterprise.organizations, enterprise.user_accounts, enterprise.org_members,
  enterprise.roles, enterprise.org_member_roles, enterprise.tasks, enterprise.documents, enterprise.audit_events TO dhc_app;
GRANT INSERT ON enterprise.tasks, enterprise.documents, enterprise.audit_events TO dhc_app;
-- 不授予 runtime UPDATE/DELETE/TRUNCATE/DDL 或身分、角色管理權。
