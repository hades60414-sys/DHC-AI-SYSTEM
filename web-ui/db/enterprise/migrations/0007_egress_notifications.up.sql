-- ASTRA-002 / DEC-EGRESS-01：provider 層級 redirect allowlist（host:port，空＝拒絕所有 redirect）。
-- 格式在應用層驗證（egress-policy.parseRedirectAllowlist）；資料庫只守筆數與字元集合。
ALTER TABLE enterprise.model_providers ADD COLUMN redirect_allowlist text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(redirect_allowlist) <= 16 AND array_to_string(redirect_allowlist, ',') ~ '^[a-z0-9.:\[\],-]*$');
GRANT UPDATE (redirect_allowlist) ON enterprise.model_providers TO dhc_app;

-- DEC-EGRESS-01 / DEC-RUN-01：站內通知（外送被拒、撤權隔離等硬邊界事件）。
-- 收件者二選一：指定成員，或某角色的全部成員；已讀狀態以成員為單位另存，避免角色通知被一人讀過就消失。
CREATE TABLE enterprise.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  recipient_member_id uuid,
  audience_role text CHECK (audience_role IN ('org_admin', 'approver', 'employee', 'auditor')),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{0,63}$'),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  subject_type text NOT NULL CHECK (subject_type ~ '^[a-z][a-z0-9_]{0,40}$'),
  subject_id uuid,
  code text CHECK (code IS NULL OR code ~ '^ENTERPRISE_[A-Z0-9_]{1,80}$'),
  message text NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK ((recipient_member_id IS NULL) <> (audience_role IS NULL)),
  FOREIGN KEY (organization_id, recipient_member_id) REFERENCES enterprise.org_members(organization_id, id)
);
CREATE INDEX notifications_recent_idx ON enterprise.notifications(organization_id, created_at DESC);
CREATE TABLE enterprise.notification_reads (
  organization_id uuid NOT NULL REFERENCES enterprise.organizations(id),
  notification_id uuid NOT NULL,
  member_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, notification_id, member_id),
  FOREIGN KEY (organization_id, notification_id) REFERENCES enterprise.notifications(organization_id, id),
  FOREIGN KEY (organization_id, member_id) REFERENCES enterprise.org_members(organization_id, id)
);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['notifications','notification_reads'] LOOP
    EXECUTE format('ALTER TABLE enterprise.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE enterprise.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY organization_scope ON enterprise.%I USING (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''dhc.organization_id'', true), '''')::uuid)',
      table_name);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON enterprise.notifications, enterprise.notification_reads TO dhc_app;
