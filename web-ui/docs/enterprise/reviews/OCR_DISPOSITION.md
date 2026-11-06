# OCR_DISPOSITION — DAS V3.2 整合（Builder 快速審查，非獨立審核）

範圍 `68b5bea..5614f9d`：114 個可審檔案；整合差異 16 檔逐一深審；其餘 98 檔與 V4 產品 SHA 位元組相同（V4 已審）。Critical 0／High 0。

| ID | 嚴重度 | 檔案 | 處置 | 說明 |
|---|---|---|---|---|
| OCR-INT-01 | info | `web-ui/server/index.ts` | VERIFIED_NO_ISSUE | 合併後函式外只剩 /api/enterprise/v1；V3.2 新增 /api/assistant 位於 mountLegacyApiRoutes() 內；企業模式安全標頭與 legacy gate 仍是第一層 middleware。 |
| OCR-INT-02 | info | `web-ui/server/modules/websocket/services/*.ts` | VERIFIED_NO_ISSUE | V3.2 對 chat／shell WS handler 的變更位於 verifyClient 閘門之後；legacyWebSocketsEnabled=!IS_ENTERPRISE 在升級握手層拒絕所有路徑。 |
| OCR-INT-03 | medium | `web-ui/scripts/enterprise/ci/known-v32-baseline-failures.json` | VALID_NOT_BLOCKER | 清單只含 V3.2 legacy 測試，附未合併 V3.2 的實測證據；建議上游修好後縮減清單。 |
| OCR-INT-04 | medium | `.github/workflows/enterprise-image-build.yml` | VALID_NOT_BLOCKER | 既有 OS critical（zlib will_not_fix）與 npm high 需 owner 處置；直接設閾值會讓 CI 永遠紅。處置見交接文件。 |
| OCR-INT-05 | low | `.github/workflows/enterprise-*.yml` | DEFERRED_WITH_OWNER | 需實際觸發 workflow；不可用時 arm64 job 失敗並標 NOT_RUN，workflow 內有架構檢查不允許以模擬冒充。 |
| OCR-INT-06 | low | `.github/workflows/enterprise-*.yml` | VALID_NOT_BLOCKER | GitHub-hosted runner 每個 job 都是全新且用完即丟；若改用 self-hosted runner 必須改成只刪本 job 的 compose project。 |
| OCR-INT-07 | medium | `web-ui/scripts/enterprise/基線啟動測試.py; web-ui/tests/enterprise/容器驗收.py` | FIXED | 改讀 DHC_CHROMIUM_PATH，未設定用 Playwright 預設 Chromium（本整合 commit） |
