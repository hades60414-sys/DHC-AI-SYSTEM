# Codex 去識別代理（codex-deid）

Codex 子代理（`codex-scout`／`codex-worker`／`codex-verifier`）送到 OpenAI 的內容，跟 Claude Code 一樣先去識別。2026-10-31 建。

- `server.cjs`：代理，`127.0.0.1:3004` 轉到 `https://chatgpt.com`（Codex 用 ChatGPT 登入時走 `/backend-api/codex/responses`）。
  - 重用 `D:\TAS\cc-web\deid-proxy\deid.cjs` 偵測引擎和 `dictionary.txt`。別名表 `vault.json` 是這裡自己的一份（一個檔只給一個程序寫）。
  - 送出：`input` 裡每個字串都換成 `DEID_<類別>_<n>`；`function_call.arguments` 先解 JSON 再換。協定欄位（type、id、call_id、name、encrypted_content 等）不動。圖片、檔案附件擋下不送。
  - 回來：SSE 串流裡的別名換回真值，切斷在兩段 delta 之間的別名也會接起來，所以 Codex 執行工具、寫檔都用真值。
  - 看不懂的請求內容（不是 Responses 格式、壓縮過）一律拒絕，不轉送。WebSocket 升級也拒絕（Codex 會改走 HTTPS）。
  - `audit.jsonl` 只記每類換了幾個，不記值。
- 橋接腳本 `~\.claude\skills\codex-bridge\scripts\run_codex_subagent.ps1`：每次呼叫先檢查 `/_deid/health`，沒回應就自己啟動代理；還是不通就不跑 Codex（exit 3）。用 `-c model_provider=deid` 指向代理。
- 沙盒：Windows 沙盒在 DHC CLI 的 session 0 起不來（提權版逾時、非提權版 0xC0000142），所以橋接改成 `danger-full-access`，邊界靠去識別代理。使用者 10-31 同意「可以讀任何檔但要跟 CC 一樣去識別」。
- 測試：`node test.cjs`（離線 9 條）。端對端：`e2e\secret.txt` 放假機密，經橋接叫 scout 讀，看 `audit.jsonl` 有換、回覆是真值。
- 不涵蓋：直接開 Codex 桌面版或自己打 `codex exec`（沒帶 provider 參數）不經代理。
- 回退：把 `run_codex_subagent.ps1.bak-20261031deid` 複製回原檔名（兩個位置：`~\.claude\skills\codex-bridge\scripts\`、`agent-harness-v2\skills\codex-bridge\scripts\`）。
- `capture.cjs`、`inspect.cjs`、`capture-body-*.bin` 是建置時抓請求格式用的，可刪。
