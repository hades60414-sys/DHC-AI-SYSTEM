-- 破壞性：僅在 migration runner 明確允許資料刪除，或 schema 為空時執行。
-- 不用 DROP SCHEMA CASCADE，避免刪除未知企業物件；SQLite 完全不受影響。
DROP TABLE enterprise.audit_events;
DROP TABLE enterprise.documents;
DROP TABLE enterprise.tasks;
DROP TABLE enterprise.org_member_roles;
DROP TABLE enterprise.roles;
DROP TABLE enterprise.org_members;
DROP TABLE enterprise.user_accounts;
DROP TABLE enterprise.organizations;
