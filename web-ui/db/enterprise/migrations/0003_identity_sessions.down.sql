REVOKE DELETE ON enterprise.org_member_roles FROM dhc_app;
REVOKE UPDATE ON enterprise.org_members, enterprise.user_accounts FROM dhc_app;
REVOKE INSERT ON enterprise.user_accounts, enterprise.org_members, enterprise.org_member_roles FROM dhc_app;
DROP TABLE enterprise.auth_sessions;
DROP TABLE enterprise.account_credentials;
ALTER TABLE enterprise.audit_events DROP CONSTRAINT audit_events_resource_type_check;
ALTER TABLE enterprise.audit_events ADD CONSTRAINT audit_events_resource_type_check CHECK (resource_type IN ('task', 'document'));
DROP POLICY login_slug_lookup ON enterprise.organizations;
ALTER TABLE enterprise.org_members DROP COLUMN auth_epoch;
