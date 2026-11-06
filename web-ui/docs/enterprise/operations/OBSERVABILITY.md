# 企業 API 可觀測性與故障診斷（V5）

實作：`server/modules/enterprise-api/enterprise-observability.ts`；測試：`server/modules/enterprise-api/tests/enterprise-observability.test.ts`。
無外部依賴（不引入 prom-client／OpenTelemetry），輸出格式相容 Prometheus 文字格式 0.0.4。

## 1. Metrics

| 名稱 | 類型 | 標籤 | 說明 |
|---|---|---|---|
| `dhc_enterprise_http_requests_total` | counter | `route` `method` `status_class` | `route` 是 Express 路由樣板（如 `/documents/:documentId`）；未比對到為 `unmatched` |
| `dhc_enterprise_http_request_duration_seconds` | histogram | `route` `method` | 桶：5ms–10s 共 11 個 |
| `dhc_enterprise_errors_total` | counter | `code` | `ENTERPRISE_*` 錯誤代碼；格式不符歸 `ENTERPRISE_OTHER` |
| `dhc_enterprise_engine_results_total` | counter | `engine` `outcome` | `ops_report`／`reconciliation`：`completed`／`rejected`／`reused`；`reconciliation_export`：格式 |
| `dhc_enterprise_engine_duration_seconds` | histogram | `engine` | 確定性引擎純計算耗時（不含 DB、storage） |
| `dhc_enterprise_db_pool_total`／`_idle`／`_waiting` | gauge | — | 擷取當下的 pg Pool 狀態 |
| `dhc_enterprise_metric_series_overflow_total` | counter | — | 因序列上限而歸入 overflow 的次數；大於 0 代表有標籤設計問題 |

**基數政策**：標籤鍵在定義時固定，傳入其他鍵會丟例外；標籤值須符合 `^[A-Za-z0-9_:/.{}-]{1,96}$`，否則記為 `invalid`；每個 metric 最多 200 個序列，超過歸入 `overflow`。**禁止**把組織 id、成員 id、文件 id、email、原始 URL 或 query 當標籤。

**存取**：`GET /api/enterprise/v1/metrics`，只有設定環境變數 `DHC_METRICS_TOKEN`（至少 24 字元）時開放，請求需帶 `Authorization: Bearer <token>`，以常數時間比較。未設定或 token 不符一律回 404（與不存在的路徑相同）。建議只在內網或反向代理後由監控系統擷取。

## 2. 結構化日誌

一行一個 JSON，寫到 stderr。`ENTERPRISE_ACCESS_LOG=off` 可關閉 access log（錯誤日誌不受影響）。

| 事件 | 等級 | 欄位 |
|---|---|---|
| `enterprise.http_request` | info | `request_id` `route` `method` `status` `duration_ms` |
| `enterprise.unexpected_error` | error | `request_id` `error_name` `sqlstate` `constraint` `table` |
| `enterprise.server_error` | error | `request_id` `code`（已知 500，如 `ENTERPRISE_BLOB_INTEGRITY`） |
| `enterprise.auto_ingestion_failed` | warn | `request_id` `code` |

**不記錄**：任何 header（含 Authorization、Cookie）、request／response body、query string、原始 URL、錯誤訊息本文（可能含連線字串或使用者輸入）、組織／成員／文件 id。實作上 `logEnterpriseEvent` 只輸出允許清單欄位，其他鍵一律丟棄；字串去控制字元並截斷 120 字。

**Request ID**：合格的 `X-Request-Id`（`^[A-Za-z0-9-]{8,64}$`）沿用，否則產生 UUID；一律回傳於回應標頭，並寫入同一請求的所有日誌。

## 3. 可靠性性質與證據

| 性質 | 機制 | 證據（測試） |
|---|---|---|
| 組織隔離 | 每個請求一個交易，`set_config('dhc.organization_id')`＋FORCE RLS；組織只來自 session | `ops-report.integration`（直接 RLS 讀寫）、`reconciliation.integration`、`enterprise.integration` |
| Session 有效性 | 交易開頭 `FOR SHARE` 重驗 session epoch；停權、改角色都使舊 session 失效 | `session-inflight.integration`、`ops-report`／`reconciliation-export` 撤權案例 |
| 冪等 | 成功結果部分唯一索引＋`ON CONFLICT DO NOTHING` 取回既有列 | `ops-report`（6 路並行）、`reconciliation`（重送） |
| 只新增 | `dhc_app` 對結果與匯出表只有 SELECT／INSERT | `ops-report.integration`（UPDATE 被拒） |
| 失敗不留痕 | 來源 hash 不符或遺失時整個交易回退 | `ops-report`（竄改 blob）、`reconciliation-export`（blob 遺失） |
| 確定性 | 純函式＋正規 JSON SHA-256；呼叫端可重算 | 引擎單元測試、整合測試的 hash 重算 |

## 4. 常見錯誤代碼診斷

| 代碼 | HTTP | 常見原因 | 先查 |
|---|---|---|---|
| `ENTERPRISE_AUTH_REQUIRED` | 401 | token 過期、被登出、成員停權或改角色（epoch 改變） | 成員狀態與角色異動稽核；重新登入 |
| `ENTERPRISE_FORBIDDEN` | 403 | 角色沒有該權限（如稽核者建立週報） | 角色權限表 |
| `ENTERPRISE_SUBSCRIPTION_INACTIVE` | 402 | 訂閱到期，商務寫入被擋（讀取、匯出仍可） | 訂閱狀態 |
| `ENTERPRISE_INVALID_OPS_REPORT`／`_RECONCILIATION` | 400 | 週別、案例集、來源數量或規則版本不合法 | 請求 body |
| `ENTERPRISE_SOURCE_UNAVAILABLE` | 409 | 匯出時來源 blob 遺失或 hash 不符 | storage 完整性、備份還原紀錄 |
| `ENTERPRISE_BLOB_INTEGRITY` | 500 | 建立結果時來源內容與 hash 不符（不寫入） | storage 完整性；`enterprise.server_error` 日誌 |
| `ENTERPRISE_INTERNAL` | 500 | 未預期錯誤 | `enterprise.unexpected_error` 的 `sqlstate`／`constraint`／`table` |

## 5. 尚未實作（PLANNED）

- 分散式追蹤（OpenTelemetry span）與跨行程 trace id。
- 告警規則與 SLO（需先有實際流量基線；無實測前不設門檻）。
- Run worker 與模型閘道的專屬 metrics（目前只有 worker tick 失敗日誌）。
- 日誌集中收集與保留期限（屬部署與客戶政策決定）。
