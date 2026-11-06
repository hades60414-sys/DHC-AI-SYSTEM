ALTER TABLE enterprise.draft_exports DROP CONSTRAINT draft_exports_approval_fk;
ALTER TABLE enterprise.draft_exports DROP COLUMN approval_id;
ALTER TABLE enterprise.approvals DROP COLUMN revision_sha256;
