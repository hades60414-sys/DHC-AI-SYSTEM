# V5 OCR Builder 審查發現

範圍：`1e481e2..7100d26`（V5 分支）。OCR delegate 篩出 32 個可審檔案（另排除 31 個測試／文件／lockfile），**32/32 已審，涵蓋率 100%**。

審查方式：OCR 只做檔案篩選與規則分組；審查由 Builder 主機 agent 執行，沒有呼叫外部 LLM，也沒有外送原始碼（符合 DEC-OCR-01）。**這是 Builder 自審，不是 Astra 結論。**

| 嚴重度 | 數量 |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 5 |

## V5-OCR-001｜MEDIUM｜security

- 檔案：`web-ui/server/modules/enterprise-persistence/reconciliation-export.ts`
- 問題：CSV 公式注入防護未涵蓋前導空白（例如 "  =1+1"、" -5"），部分試算表會去除前導空白後求值。目前欄位值經 ACC-MATCH 的 ID 格式驗證，引擎輸出不可能含這些前綴，屬縱深防禦缺口。
- 處置：**FIXED**

## V5-OCR-002｜MEDIUM｜performance

- 檔案：`web-ui/server/modules/enterprise-persistence/enterprise.service.ts`
- 問題：exportReconciliation 為了驗證來源完整性，會把兩個來源 blob 整份讀進記憶體（storage adapter 只提供 get(): Buffer）。100 MiB 上限的文件會造成每次匯出數百 MiB 暫時記憶體。
- 處置：**DEFERRED**

## V5-OCR-003｜LOW｜maintainability

- 檔案：`web-ui/server/modules/enterprise-persistence/enterprise.repository.ts`
- 問題：insertOpsReport 只對 completed 去重；同一份不合格來源重送會產生多筆 rejected 列與稽核事件（與 V4 reconciliations 相同設計）。已登入的寫入者可重複送出造成表成長。
- 處置：**ACCEPTED**

## V5-OCR-004｜LOW｜other

- 檔案：`web-ui/server/modules/enterprise-persistence/enterprise.service.ts`
- 問題：createOpsReport 在查詢既有成功結果之前先做商務權益檢查，訂閱到期後連重送同一請求取回既有結果也回 402（讀取 GET 仍可）。
- 處置：**ACCEPTED**

## V5-OCR-005｜LOW｜maintainability

- 檔案：`web-ui/db/enterprise/migrations/0013_ops_reports.down.sql`
- 問題：有 ops_report 稽核事件時 down 會因重建 audit_events CHECK 失敗而整筆回退，即使給了 allowDataLoss。
- 處置：**ACCEPTED**

## V5-OCR-006｜LOW｜security

- 檔案：`web-ui/server/modules/enterprise-api/enterprise-observability.ts`
- 問題：合格格式的 inbound X-Request-Id 會原樣沿用並寫入日誌，用戶端可自訂 request id 以混淆日誌關聯。
- 處置：**ACCEPTED**

## V5-OCR-007｜LOW｜other

- 檔案：`web-ui/server/modules/enterprise-persistence/ops-report-v1.ts`
- 問題：validateOpsNarrative 只比對數值是否出自引擎，恰好等於某主張值的錯誤敘述（例如把增量 30 寫成「節省 30%」）無法偵測。
- 處置：**DOCUMENTED**

## V5-OCR-008｜MEDIUM｜test

- 檔案：`web-ui/server/modules/agent/tests/agent.routes.test.ts`
- 問題：本機全套 npm test 2 次中 1 次出現 node test runner IPC 錯誤 'Unable to deserialize cloned data due to invalid or unsupported version'（整個檔案判 fail）；單獨執行 3/3 通過，CI 未出現。疑似子行程 stdout 混入非 TAP 位元組。
- 處置：**OPEN**
