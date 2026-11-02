# 安全輸入（2026-10-29，仿 ChatGPT 私密登入表單）

要 AI 幫忙登入某台機器上的系統，但那台還沒存帳密時用。使用者在手機點一次性連結、填值，值直接存成那台的使用者環境變數（等同 `setx`），之後 AI 在指令裡用 `%名稱%`，輸出自動遮蔽。值不進聊天、不給 AI 看、不進任何紀錄。遮蔽只防不小心印出；AI 刻意去讀（例如把值拆開印）擋不住，所以只存到 AI 不在的機器。

## 開單（AI 用）
```
D:\TAS\node\node.exe D:\TAS\ai-tools\secure-input\ask.cjs --machine rag1 --name EKB_PWD --note "EKB 登入密碼"
```
- `--machine`：`.mcp.json` 的伺服器名稱，那台要開 ragent_cmd，代理程式要 rag1v 以上（目前 rag1＝srv-rag 可用；pcmain＝srv-main 也裝了，但它是 AI 所在主機，**不開單**；同事主機升級後才能用）。
- `--name`：以 `_PWD`、`_PASS`、`_TOKEN`、`_OTP` 結尾的會遮蔽；`_USER` 結尾的是帳號，不遮蔽。
- 不能用的名稱：CLAUDE_、ANTHROPIC_、OPENAI_、GH_、GITHUB_、GIT_、NODE_、NPM_、HF_、AWS_、AZURE_、GOOGLE_、CLOUDFLARE_、CF_、RAGENT_、TASUI_ 開頭（別的工具在用）。
- 值：可列印英數符號，要遮蔽的至少 6 字、帳號至少 2 字、最多 512 字。
- 卡片只貼到使用者和小助手的私聊（`--room` 只收 `test:` 開頭的測試聊天室）；連結 15 分鐘、只能用一次。程式不印連結。
- 結果（成功／失敗、名稱、字數）由程式貼回同一個私聊；AI 不用等。

## 流程
`ask.cjs` 開單 → 使用者開 `<目前前門網址>/_secure/<一次性碼>`（開單時向信箱 /_where 查；前門有密碼閘，只有登入過網頁版的瀏覽器打得開）（seal-proxy 交給 `serve.cjs`）→ 送出時單據搬到 `done\`（搶不到就是用過了）→ `deliver.cjs`（值只走 stdin）→ `ragent-mcp.cjs` 的隱藏工具 `ragent_secret_set`（只有 `RAGENT_SECRET_SET=1` 才有，`.mcp.json` 不設，AI 看不到）→ 加密簽章工作 → 代理程式 `secret-set` 存成使用者環境變數，從下一個指令起帶給子程序並遮蔽。

## 留下什麼
- `pending\`、`done\`：檔名是一次性碼的 SHA-256；內容只有機器、名稱、說明、時間、字數、結果。
- `secure-input.log`：開單、送出、送達，各一列（名稱與字數）。
- 那台的 `cmd-run.log`：`SET  N chars  secret-set 名稱`。

## 注意
- 測試時才用 `SECURE_INPUT_ALLOW_HOST=1` 對 srv-main 開單，測完用 PowerShell `[Environment]::SetEnvironmentVariable(名稱,$null,"User")` 清掉。
- 拿到網頁版網址的人看得到私聊裡的連結，也就能搶先填一個假值；結果會貼回私聊，看到不是自己填的就叫 AI 重開一張。
- 頁面的 Referrer-Policy 不能設 no-referrer：瀏覽器會讓表單 POST 帶 `Origin: null`，前門 Worker 的跨站防護（gate.mjs crossOrigin）就回純文字 `cross-origin request refused`（10-30 實測，卡 6ab7f7）。現在用 strict-origin（Origin 正常、Referer 只帶網址根）。用 curl 測不出來，curl 不帶 Origin。
- 值存在那台的使用者環境變數（HKCU），和以前手動 `setx` 一樣是明文。
- 值裡有 `" & < > ^ %` 時 CMD 的 `%名稱%` 會被拆壞（實測含 `"` 的值連 `"%名稱%"` 也不行），改用 PowerShell `$env:名稱` 或讓程式自己讀環境變數。
- 其他機器要先升 rag1v 代理程式並把控制端 exe 換成同版（部署走核准單），控制端 `Controller-RAG1.ps1` 已加 `secret-set`。

## 回退
- 10-30 Origin 修正：`copy /y D:\TAS\ai-tools\secure-input\serve.cjs.bak-20261030xo D:\TAS\ai-tools\secure-input\serve.cjs`，再重啟 seal-proxy（先 idle-check）。
- seal-proxy：`copy /y D:\TAS\cc-web\seal-proxy.js.bak-20261029si D:\TAS\cc-web\seal-proxy.js`，再跑 `restart-seal-proxy.cmd`（先 idle-check）。
- ragent-mcp：`ragent-mcp.cjs.bak-20261029b`；Controller：`Controller-RAG1.ps1.bak-20261029`；pcmain 控制端 exe：`release-rag1d-pcmain.bak-20261029`。
- srv-main 代理程式：apply-update 留有 `agent\dbclone-agent-v1.previous.exe`；或把 `TAS遷移\kits\pcmain\tas-rag1t-pcmain.zip` 放 assets 用 ragent_self_update 推回 rag1t。
- 原始碼：`rag1\srcD.bak-20261029`。
