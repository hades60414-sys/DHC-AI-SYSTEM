# V5.1 架構差異

V5.1 沿用 `docs/enterprise/architecture/` 的同一套圖（不另建第二套）；新增或修改的元素標示 `NEW_IN_V51`（紫色）。

| 圖 | V5.1 變更 |
|---|---|
| CURRENT_C4_CONTEXT | 新增「同 repo 其他模組（remote-agent cmd-run、deid-proxy）」為 BLOCKED_DECISION |
| CURRENT_C4_CONTAINER | OPS-REPORT 計算閘門與交易外計算；blob 串流 `verify()` |
| TARGET_BACKEND_COMPONENTS | `ops-report-runner`（交易外計算、閘門）、`document-blob-store verify()`；引擎累積器／上限／截斷 |
| AUTH_RLS_SEQUENCE | OPS-REPORT 兩交易模式（prepare → 交易外計算 → commit 重驗 session） |
| DOCUMENT_WORKFLOW_SEQUENCE | 無變更 |
| RECONCILIATION_DATA_FLOW | 匯出串流驗證、可達的 CSV 公式中和＋LibreOffice 實測 |
| OPS_REPORT_DATA_FLOW | 閘門 → prepare（413 快速拒絕）→ 交易外依序讀 blob（可中止）→ 引擎（解碼前掃描）→ 有界主張 → commit |
| DEPLOYMENT_CI_ARCHITECTURE | 資源探針、UAT 證據索引檢查、`csv-spreadsheet-safety`、`upgrade-rollback-amd64`、交付冒煙端到端耗時 |
| FAILURE_RECOVERY_SEQUENCE | 413／429／中止；長時間計算期間停權 → commit 401 |
| TECHNICAL_ROADMAP／ROADMAP_TUI | 由 `roadmap.json` 產生；新增 NEW_IN_V51 狀態與 6 項、BLOCKED_DECISION 3 項 |

全部 `.mmd` 以 repo 內 mermaid 套件解析通過；`render_roadmap.py --check` 在 CI 驗證產出與證據路徑。
