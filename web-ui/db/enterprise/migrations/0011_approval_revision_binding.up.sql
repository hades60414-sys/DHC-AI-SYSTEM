-- ASTRA-V3-NEW-001：審批綁定不可變修訂內容。
-- revision_sha256＝送審當下該修訂 {body, citations} 正規化 JSON 的 SHA-256；核准者必須以相同版號與 hash 確認。
-- 0011 之前建立的 approval 為 NULL（舊資料），決定時以修訂現值計算後比對呼叫者提供的 hash。
-- draft_exports.approval_id：每次匯出記錄依據的 approval，NULL 僅限 0011 之前的匯出紀錄。
ALTER TABLE enterprise.approvals ADD COLUMN revision_sha256 text CHECK (revision_sha256 IS NULL OR revision_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE enterprise.draft_exports ADD COLUMN approval_id uuid;
ALTER TABLE enterprise.draft_exports ADD CONSTRAINT draft_exports_approval_fk
  FOREIGN KEY (organization_id, approval_id) REFERENCES enterprise.approvals(organization_id, id);
