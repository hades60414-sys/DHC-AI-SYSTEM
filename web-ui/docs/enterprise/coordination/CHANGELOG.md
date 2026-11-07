# Coordination State Changelog

## V5.3（2026-11-07）
- 新增 `AUDITOR_SNAPSHOT.json`：抄錄 Astra INTERIM_AUDIT（20 項 rolling findings＋原始 18 項 track 判定），來源 SHA-256 `84137ee9ef477bc8c51f20af50d849754e5b47078ccef380b29801f5248402ab`。
- 新增 `FINDING_LEDGER.json`／`STATE.json`（由 `build_state.py` 產生）與 `check_state.py`／`test_check_state.py`（CI static-and-unit 執行）。
- Builder 狀態：BUILDER_SUBMITTED；Auditor 狀態：ASTRA_REAUDIT_PENDING。沒有任何項目被 Builder 標為 AUDIT_VERIFIED。
- CI 證據（head `45713dce4a272cd9303478ffe56ac8c732eacd23`）：enterprise-verify 42343825984、enterprise-image-build 42343825894、repo-coverage 42343825939、negative-gate-evidence 42343824459（預期 failure，all_match）、office-e2e-evidence 42343824443。STATE 已帶入 run／attempt／artifact ID。

## V5.3.1（2026-11-07）
- schema 2：
  - SHA 角色分離（product／ci_evidence／documentation／pr_head／auditor／artifact），新增 `EVIDENCE_SOURCES.json` 並以 git 歷史驗證；
  - closure_class 分六類；
  - 補抄錄 Astra CONTINUATION_V4（`690b71a3…`，2cc9e93）。
- 檢查器：
  - 判定、嚴重度、builder_status 都由 snapshot／registry 重新推導；
  - Auditor 報告以來源雜湊＋內容雜湊釘選；
  - golden fixture 不算文件。
- 828a763 單獨推送時被閘門擋下（run 42348453024），屬預期。
