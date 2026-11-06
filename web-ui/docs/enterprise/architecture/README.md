# DHC AI Office 企業後端架構（V5）

本目錄的圖與說明以實際程式為準（V5 分支 `feature/ai-office-backend-v5-20261106`）。每個元素都標示狀態：

| 標記 | 意義 |
|---|---|
| `CURRENT` | 已在程式中，且有測試或交付證據（V4 以前完成） |
| `NEW_IN_V5` | 本輪新增，已有測試證據；尚未經 Astra 獨立審查 |
| `PLANNED` | 尚未實作；不能當作現有能力對外描述 |
| `BLOCKED_DECISION` | 需要人類（產品、法務、商務）決策後才能排入 |

## 圖目錄

| 檔案 | 內容 |
|---|---|
| [CURRENT_C4_CONTEXT.mmd](CURRENT_C4_CONTEXT.mmd) | C4 L1：使用者、維運者、模型供應商、監控、CI 與待決策外部系統 |
| [CURRENT_C4_CONTAINER.mmd](CURRENT_C4_CONTAINER.mmd) | C4 L2：app 容器（Express、worker、擷取沙箱、引擎）、PostgreSQL、blob volume、migrate 工具 |
| [TARGET_BACKEND_COMPONENTS.mmd](TARGET_BACKEND_COMPONENTS.mmd) | `enterprise-api`／`enterprise-persistence` 元件與規劃中元件 |
| [AUTH_RLS_SEQUENCE.mmd](AUTH_RLS_SEQUENCE.mmd) | Bearer session → 權限 → 交易內 session epoch 重驗 → RLS |
| [DOCUMENT_WORKFLOW_SEQUENCE.mmd](DOCUMENT_WORKFLOW_SEQUENCE.mmd) | 上傳 → 擷取 → Run → 草稿 → 審批 → 匯出 |
| [RECONCILIATION_DATA_FLOW.mmd](RECONCILIATION_DATA_FLOW.mmd) | ACC-MATCH-v1 對帳與 V5 結構化匯出 |
| [OPS_REPORT_DATA_FLOW.mmd](OPS_REPORT_DATA_FLOW.mmd) | OPS-REPORT-v1 週報引擎、冪等鍵與敘述守門 |
| [DEPLOYMENT_CI_ARCHITECTURE.mmd](DEPLOYMENT_CI_ARCHITECTURE.mmd) | GitHub Actions 工作流程、artifact、客戶端維運工具 |
| [FAILURE_RECOVERY_SEQUENCE.mmd](FAILURE_RECOVERY_SEQUENCE.mmd) | blob 完整性、來源遺失、並行重送、撤權、worker 重啟、備份還原 |
| [TECHNICAL_ROADMAP.mmd](TECHNICAL_ROADMAP.mmd) | 依狀態分組的路線圖（由 roadmap.json 產生） |
| [ROADMAP_TUI.md](ROADMAP_TUI.md) | 路線圖文字看板＋證據表（由 roadmap.json 產生） |

全部 `.mmd` 以 repo 內 `mermaid` 套件 `mermaid.parse` 驗證可解析。路線圖修改請改 `roadmap.json` 後執行
`python3 -B scripts/enterprise/render_roadmap.py`；`--check` 會在產出過期或 CURRENT／NEW_IN_V5 項目缺證據時失敗。

## 關鍵架構事實

- **單客戶隔離部署**：一個 compose project（app、db、migrate），PostgreSQL 在 internal 網路；app 只綁 `127.0.0.1`，TLS 由客戶端反向代理負責。
- **組織範圍只來自 session**：每個請求一個交易，`set_config('dhc.organization_id')`；31 張企業資料表全部 FORCE RLS；`dhc_app` 對結果類表只有 SELECT／INSERT。
- **撤權即時生效**：交易開頭以 `FOR SHARE` 重驗 session epoch；停權、改角色都會讓既有 session 失效。
- **確定性計算與模型分離**：ACC-MATCH-v1、OPS-REPORT-v1 與匯出都是純函式＋整數運算＋正規 JSON SHA-256；模型不得產生數字（`validateOpsNarrative`）。
- **CI**：公開 repo、`contents: read`、無 secrets；原生 amd64／arm64 runner 建置並各自做交付冒煙；不推送 registry。

## 已知限制

- 週報的敘述生成、送審與正式匯出尚未實作（PLANNED）；目前 API 只回傳確定性主張。
- `validateOpsNarrative` 只核對數值是否出自引擎，不理解語意，仍需人審。
- 效能（p50／p95、5 萬列對帳耗時、記憶體）尚未在 CI 量測，見 V5 交付的 PERFORMANCE_REPORT（未量測項標 NOT_RUN）。
