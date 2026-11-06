# V5 OCR 處置

| ID | 嚴重度 | 處置 | 說明 |
|---|---|---|---|
| V5-OCR-001 | medium | FIXED | cell() 改為檢查前導空白後的 = + @ -；單元測試新增兩個案例並確認數值負差額 -5000 不受影響。 |
| V5-OCR-002 | medium | DEFERRED | 需擴充 storage adapter 介面（串流 hash 或已驗證 hash 快取），屬 V4 已審 adapter 契約變更；記入 PERFORMANCE_REPORT 與後續路線（PERF-01）。 |
| V5-OCR-003 | low | ACCEPTED | 設計上每次拒收都留稽核痕跡（規格：拒收也留一筆）；與 V4 一致。是否改為 rejected 也去重需產品決定，列入 HUMAN_DECISION_QUEUE。 |
| V5-OCR-004 | low | ACCEPTED | 與 V4 createReconciliation 行為一致（ASTRA-014 商務寫入政策 fail closed）；到期後讀取既有結果用 GET /ops-reports/:id。 |
| V5-OCR-005 | low | ACCEPTED | 刻意設計：不默默刪稽核紀錄；與 0012 相同，註解已說明。 |
| V5-OCR-006 | low | ACCEPTED | 值限制為 [A-Za-z0-9-]{8,64}，無注入風險；沿用 inbound id 是反向代理串接 trace 的常見需求。日誌另含 route／status／時間可交叉比對。 |
| V5-OCR-007 | low | DOCUMENTED | 已在函式註解、架構 README 與測試註記；敘述生成尚未實作（PLANNED），上線前仍需人審。 |
| V5-OCR-008 | medium | OPEN | 根因未確認；未列入基線白名單（比對器照樣會擋）。列為後續調查項（legacy V3.2 測試，非企業模組）。 |

## 審查重點與結論（無發現項）

- **授權與隔離**：新端點全部經 `requireAuth`＋`requirePermission`＋`withOrganization`；組織只來自 session；新表 FORCE RLS，`dhc_app` 只有 SELECT／INSERT；整合測試含跨組織直接 RLS 讀寫拒絕。
- **交易與冪等**：結果與來源列同交易寫入；成功結果部分唯一索引＋ON CONFLICT；6 路並行測試收斂為一筆。來源 hash 不符時整筆回退。
- **確定性**：引擎只用 BigInt；ROUND_HALF_UP 以整數實作並測正負 tie；結果 hash 由呼叫端可重算。
- **CI 權限**：只新增 `pull_request.branches`（integration 分支）；仍為 `contents: read`、無 secrets、無 pull_request_target。
- **供應鏈**：overrides 範圍限定在指定父套件（lodash-es 全樹統一為 4.18.1）；npm 移除只限 enterprise profile，build 時斷言。
- **日誌與 metrics**：不記錄 header／body／query／id；標籤值白名單＋序列上限；/metrics 未設定 token 一律 404。
