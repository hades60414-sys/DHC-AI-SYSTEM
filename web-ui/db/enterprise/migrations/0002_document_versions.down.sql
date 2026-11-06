-- 只移除 E05-DOC-01 新增的結構；0001 的資料表不在此處理。
DROP TABLE enterprise.document_versions;
DROP TABLE enterprise.document_blobs;
ALTER TABLE enterprise.documents DROP CONSTRAINT documents_organization_scope_key;
