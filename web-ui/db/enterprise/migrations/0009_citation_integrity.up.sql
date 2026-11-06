-- ASTRA-007：每個草稿修訂在建立時記錄引用完整性檢查結果（稽核用快照）。
-- 送審、核准、匯出與讀取時仍以當下資料重驗（來源可能事後漂移）；0009 之前的修訂為 NULL＝未檢查，送審時重驗。
ALTER TABLE enterprise.draft_revisions ADD COLUMN citation_status text CHECK (citation_status IS NULL OR citation_status IN ('VALID', 'INVALID', 'UNCITED'));
ALTER TABLE enterprise.draft_revisions ADD COLUMN citation_report jsonb CHECK (citation_report IS NULL OR jsonb_typeof(citation_report) = 'object');
