# rulesync（專案層 Claude ↔ Codex 設定共用）

讓一個專案同時給 Claude Code 和 Codex 用：`.rulesync\` 是正本，產出 `CLAUDE.md`、`.claude\skills\`（Claude）與 `AGENTS.md`、`.agents\skills\`（Codex）。

- 用法：`codex-ready.cmd <專案資料夾>`；先看會寫什麼加 `--dry-run`。第一次會從現有 CLAUDE.md 與 skills 匯入。
- 之後改規則改 `.rulesync\rules\`、`.rulesync\skills\`，再跑一次 codex-ready.cmd；直接改 CLAUDE.md／AGENTS.md 會被下次產出蓋掉。
- 版本鎖 43.4.2，`npm install --ignore-scripts` 安裝（2026-11-02）。來源 https://github.com/dyoshikawa/rulesync（MIT）。

## 不要用的功能（2026-11-02 安全審查，Codex gpt-6-astra 讀碼）
- `rulesync init`：預設把 Codex 設成 danger-full-access，並加外部 MCP（DeepWiki、未鎖版本的 pnpm dlx）。
- `--delete`：會刪掉不是它建立的 skills 與 Claude 排程。
- `--global`：會寫 `~/.claude`、`~/.codex`，跟 harness v2 的 sync-harness.ps1 搶同一批檔案。使用者層設定照舊走 harness v2。
- `fetch`／`install`／`update`：會連 GitHub、npm；不需要就不跑。
- 沒有自動遙測或自動更新。

## 交接
Codex 主導的專案用 `.astra\`（PROJECT_STATE、TODO、HANDOFF 等，見 Codex 的 AGENTS.md）；Claude 接手時先讀 `.astra\HANDOFF.md`。session-handoff（yuzushi-dev）審查後不採用：只支援 POSIX、會自動替換 CLI 啟動程式、有選項把對話送第三方 API。
