# harness — 規則、skills、子代理、護欄

這一層是整包最常被借用的部分：裝好之後，Claude Code 每個新 session 都會照這裡的規則做事。安裝步驟見上一層的 [安裝說明.md](../安裝說明.md)，或把 [SETUP_PROMPT.md](../SETUP_PROMPT.md) 貼給 AI 讓它帶你裝。

## 資料夾

| 路徑 | 內容 |
|---|---|
| `rules/` | `CLAUDE.md`（入口）、`AGENTS.md`（做事紀律）、`MIDOFFICE.md`（中台紅線，碰到市場資料、損益、風險時才讀）、`pstack-models.md`（pstack 外掛的模型分工）、`CODEX-AGENTS.md`（給 Codex 的版本） |
| `skills/` | 約 50 個 skill，一覽與用途見 [SKILLS.md](../SKILLS.md) |
| `agents/` | 9 個子代理：`scout`（找檔案）、`executor`／`mech-executor`（實作）、`verifier`（獨立驗證）、`observer`（提點子）、`plan-verifier`、`security-reviewer`／`security-executor`、`Explore` |
| `hooks/` | 四支 hook：金鑰攔截、對外傳輸紀錄、自建前提醒、繁中回覆檢查 |
| `mods/dhc-guard/` | 危險指令確認閘（要回「確認執行」才放行） |
| `ops/` | `sync-harness.ps1`（安裝／同步）、`healthcheck.ps1`（檢查）、`install-hooks.cjs`（自動合併 hooks 設定）、`uninstall-harness.ps1`（解除安裝） |
| `docs/` | 設計筆記與安全掃描紀錄；`archive/` 是停用規則的封存 |
| `templates/` | 給不吃 `@import` 的工具（例如其他 AI CLI）用的啟動提示 |
| `sync-manifest.json` | 哪些 skill 給 Claude、哪些給 Codex、哪些已退役 |

## 規則的幾個設計

- **單一來源**：改規則只改這裡，再跑 `sync-harness.ps1`；不要直接改 `~/.claude` 裡的副本。每台機器自己的設定寫在 `~/.claude/CLAUDE.local.md`，同步時不會被蓋掉。
- **按需載入**：中台紅線（`MIDOFFICE.md`）只在碰到損益、部位、風險、資料庫時才讀，平常不佔 context。
- **紅線先問，其餘直接做**：算錢的邏輯、刪資料、對外送出、權限、花錢才停下來問；能回退的事做完附證據回報。
- **不自己打分數**：重要交付前用獨立的 `verifier` 子代理挑錯。

## 跟原團隊有關、可能要改的地方

- 回覆預設繁體中文、先講結論、精簡風格（`rules/CLAUDE.md` 的 Communication）。
- GPT／Codex 委派已停用（`codex-*`、`chatgpt-bridge` 這幾個 skill 會裝上但不會自動被叫用）。
- 複雜系統工作走 [pstack](https://github.com/michael-denyer/pstack-claude) 外掛；沒裝 pstack 就把 `rules/CLAUDE.md` 的「pstack workflow」段與 `@pstack-models.md` 那行刪掉。
- 規則裡提到的 `company-environment`、`company-intranet` skill 含公司內部資訊，沒有收錄；換成自己公司的版本，或刪掉那幾句。
