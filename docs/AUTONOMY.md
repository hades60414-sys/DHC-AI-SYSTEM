# 自主執行：從雲端部署操作蒸餾的做法

這份文件把雲端部署與後續互動測試中可重用的做法放進 DAS；不附私人對話、登入會話、cookie 或原機設定。最初被稱為「GPT 操作 Vercel」的紀錄，實際使用的是 Cloudflare Workers／wrangler；後續另有 Vercel 操作訪談。平台名稱不能當成部署驗證的證據。

## 從接手到完成

1. 開場說清楚目標資源、要改什麼、如何驗收；先讀專案規則與 `.astra` 狀態。必要資訊先查檔案與現況。
2. 在使用者已授權的範圍內完成可回退工作，包括已授權的推送或部署，不重複索取同一份許可。尚未授權的對外操作、付費、權限與破壞性變更，先備妥可審閱的具體變更再確認。
3. 改動前保留 Git 版本或備份；第三方套件先檢查來源與內容。憑證由本機安全設定或環境變數提供，不放進 repo、命令輸出或報告。
4. 工具卡住時按已載入的 `AGENTS.md`「When blocked」規則盤點資源，保持原授權與驗收條件。使用者明示「失敗即停」或限定工具時照做；寫入結果不明先讀回，避免重複送出。
5. 發布前核對候選 commit、建置結果與部署版本；部署後讀正式網址，驗 HTTP 狀態與實際內容。HTTP 200 本身不代表正確版本，畫面正確也不代表業務資料正確。
6. 分層回報程式、測試、建置、部署、正式生效與資料驗證；沒驗的層明寫未驗。完成後清理本次建立的暫時設定，保留驗證證據與回退方法。

## 已有機制與啟用條件

| 機制 | 公開包內容 | 使用前要完成的設定 |
|---|---|---|
| Claude／Codex 行為規則 | `harness/rules/AGENTS.md`、`CODEX-AGENTS.md` | 同步至所選平台；能力仍取決於當地工具與授權 |
| 回合結束守門 | `harness/hooks/turn-end-guard.js` | A/B 基本檢查啟用；C/D 手動交棒與過早放棄檢查只對 `das-hooks.json` 的 workspaces 生效 |
| 核准後續接、時限續做 | `tools/approvals/`、`keepgoing-detect.js` | 設好 MCP 路徑、DHC CLI 服務、watch 排程；先驗證叫醒，再開 keepgoingEnabled |
| 常設授權 | `tools/approvals/grant.cjs` | 使用者核准具體指令字首與期限；同帳號下屬防誤用機制，不是防惡意的權限隔離 |
| 維護暫停 | `harness/hooks/drain-guard.js` | `drainRoot` 或 `DRAIN_ROOT` 指向實際維護服務資料夾 |
| Gemini 接手 | `tools/gemini-takeover/` | 選裝；外部執行器、服務與工作區白名單需另配置，EKB 整合未附 |

新安裝的 `~/.claude/das-hooks.json` 由安裝器產生，保留已存在的檔案；預設 workspaces 空白、keepgoingEnabled 為 false、drainRoot 空白。填入自己要啟用的絕對工作區路徑，只涵蓋該目錄及子目錄。toolsRoot 指向這份 repo 的 tools；移動 repo 後需更新。只安裝單支依賴設定的 hook 時，也要複製 `das-config.js`。

核准服務以 `APPROVALS_MCP_CONFIG` 指定本機 MCP 設定檔，以 `NUDGE_BASE` 指定 DHC CLI 服務；`WAKE_PROJECTS` 可覆寫 Claude 對話目錄。這些本機設定與排程不隨公開包附送。未完成整合時，程式碼存在不代表服務已可用。

會話清單只需記錄可用工具與授權範圍，保留在本機；本人驗證交給使用者完成，再由代理讀回結果續做。不要把登入狀態檔或私人會話複製到分享包。
