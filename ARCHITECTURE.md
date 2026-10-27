# 架構

一台共用主機（`srv-main`）跑 Claude Code 與網頁版；同事從內網瀏覽器使用；內網其他主機透過遠端代理程式提供資料庫與文件。原則只有一條：**AI 可以讀、可以算、可以提案；會改資料、對外送出、動權限的事，由程式驗證或人放行。**

## 全貌

```text
同事瀏覽器 ──HTTPS──> Cloudflare Worker (web-ops/worker)
                         │ cookie 閘門 + 每 IP 登入限流
                         ▼
                   quick tunnel ──> seal-proxy :3002 (web-ops/seal-proxy.js)
                                        │ 只放行帶封條的請求
                                        ▼
                                  DHC CLI :3001（CloudCLI fork，另一個 repo）
                                        │ 每個對話起一個 Claude Code
                                        ▼
                                  Claude Code ── hooks / dhc-guard / skills (harness/)
                                        │ ANTHROPIC_BASE_URL
                                        ▼
                                  deid-proxy (web-ops/deid-proxy) ──> 模型 API
                                        │ 送出前：人名、IP、email、金額、字典詞 → DEID_<種類>_<n>
                                        │ 回來後：代稱 → 原值；讀不出內容的附件擋下等人覆核
                                        ▼
                                  MCP 工具 (remote-agent/mcp) ──> 公開信箱 ──> 內網主機上的代理程式
                                                                   (簽章 + 加密的工作單，白名單動作)
```

## 元件

### 1. Harness（`harness/`）
- **規則分層**：`rules/AGENTS.md` 是跨工具的行為鐵則；`CLAUDE.md` 用 `@import` 疊上 AGENTS、中台紅線（`MIDOFFICE.md`）與本機 overlay；Codex 另有 `CODEX-AGENTS.md`。規則單一來源，`ops/sync-harness.ps1` 依 `sync-manifest.json` 同步到 `~/.claude`、`~/.codex`、`~/.agents/skills`，有差異才備份。
- **skills**：三類——工作紀律（驗證、交接、委派、找現成再自建）、中台方法論（部位限額、P&L 調節、資料品質、EOD 報表、風險指標覆核，只給方法不給引擎）、產出工具（簡報、圖表、影片、UI）。
- **子代理**：`scout`／`Explore` 唯讀偵察，`executor`／`mech-executor` 實作，`verifier`／`plan-verifier` 新鮮脈絡驗收，`observer` 只提大膽想法。重要成果交付前一律由沒參與的子代理挑錯。
- **護欄**：`hooks/secret-guard.js` 擋工具輸入裡的金鑰與個資；`hooks/egress-log.js` 記錄每次對外傳輸；`hooks/zh-reply-guard.js` 擋英文回覆；`mods/dhc-guard` 對刪檔、改權限、停服務等指令要求網頁上按「確認執行」。

### 2. 網頁版周邊（`web-ops/`）
- **對外入口**：Worker 固定網址 → 每次重開都會變的 quick tunnel → `seal-proxy` 只認 Worker 蓋的封條，繞過 Worker 直連 tunnel 會被擋。`tunnel-watchdog.ps1` 換通道時更新 Worker 的 KV。
- **去識別代理**：模型看到的是代稱，使用者看到的是原值。偵測規則認得形狀固定的值（身分證檢查碼、員編、內網 IP、UNC 路徑、金額），字典補沒有形狀的字（公司名、資料表名）。PDF 走文字層、圖片走 OCR 塗黑，讀不出來就擋下，由發送者輸入放行碼才送出。
- **團隊小助手**：`assistant-guard.cjs` 是小助手專用的 PreToolUse 閘門（受保護檔案改動先變成「動作卡」等人按）；`assistant-nudge.cjs` 不叫模型、只讀站內狀態推提醒；`assistant-memory-curate.cjs` 夜間整理記憶檔。
- **營運**：`auto-resume.cjs` 撞 5 小時額度後在重置時各續跑一次；`idle-check.cjs` 確認沒有對話與背景子代理在跑才重啟；`db-backup.cjs` 每晚 `VACUUM INTO` 留 14 份。

### 3. 遠端代理程式（`remote-agent/`）
- .NET Framework 單一執行檔（`Channel.cs` 等），PowerShell 控制端（`Controller-V35.ps1`、`rag1/Controller-RAG1.ps1`），Node MCP server（`mcp/ragent-mcp.cjs`）。
- 工作單由控制端簽章並加密給已配對的裝置憑證；回報由裝置簽章加密回來。序號單調遞增、15 分鐘過期、一次只有一張在跑、執行前先落地 `RUNNING`，重開不重放。
- 動作是白名單：唯讀 SQL 用結構化 JSON（不收 SQL 文字）、文件問答（本地模型作答＋逐字核對出處）、受限 CMD（擋格式化、關機、刪系統資料夾、改帳號）、`aiw_` 開頭的搬遷沙盒、驗雜湊的自我更新。
- 每台主機一份設定（`userA`～`userF`、`pcmain`、`pcmgr` 等），MCP 名稱即主機名。

### 4. 工具（`tools/`）
- `action_gate/`：只看代理當下看得到的資訊，判斷一個提案動作「放行」或「停下等人」。附三輪對抗測試（全新子代理找漏洞）的探針與回歸題。
- `local_qa/`：本機小模型文件問答與 37 題評估；`grounding_eval.cjs` 離線核對答案是否逐字出自段落。
- `aiw-probe/`：內網網頁的臨時測試沙盒，`.php` 30 分鐘自動失效。
- `reminders/`、`skill-updates/`、`skill-usage/`：一次性提醒（附一鍵開工按鈕）、每週查第三方技能新版、統計 skill 實際使用次數。

## 設計取捨

1. **能回退就直接做，紅線才問人**：改檔前先備份、附回退指令；算錢的邏輯、刪資料、對外送出、帳密權限一律先問提需求的人。
2. **驗證放在出錯代價高的地方**：內網與同事電腦是單程票，先在等價環境證明再交付；exit 0、「已送出」都可能是假象，驗實際產物。
3. **錯兩次就做成機制**：同一個錯誤出現第二次，就寫成 hook、測試或檢查，並證明它擋得住那個錯。
4. **網址即權限**：網頁版目前不設登入以外的防護，所有資料庫工具都是唯讀或沙盒；要開放更多人前，先在 Worker 前加存取控制。
