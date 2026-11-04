# 安裝文件對照檢查（2026-11-04）

範圍：`安裝說明.md`、`README.md`、`SETUP_PROMPT.md` 的每個步驟，逐一對照 repo 內實際的腳本與檔案。**只改文件，沒改程式。**

## 怎麼查的

- 讀原始碼：`harness/ops/sync-harness.ps1`、`healthcheck.ps1`、`uninstall-harness.ps1`、`install-harness.ps1`、`install-hooks.cjs`、`harness/sync-manifest.json`、`harness/hooks/*.js`、`harness/mods/dhc-guard/`、`vendor/.claude-plugin/marketplace.json`、`scripts/scan-sensitive.mjs`、`harness/rules/*.md`。
- 實際執行（Linux 容器、Node v22.23.4，HOME 指到暫存資料夾，不碰真實環境）：
  - `node harness/ops/install-hooks.cjs --check`／`--guard`／`--remove`：確認複製的檔案數、註冊的事件數、產生的檔案與移除後剩下什麼。
  - `secret-guard.js` 餵「`sk-ant-` 加 30 個 x」：exit 2 擋下，與「試試看」一致。
  - `node web-ops/assistant-guard.test.cjs`：2 項失敗（self pair），與第 5 步已知狀況一致。
  - `node tools/action_gate/test_matching.cjs`：缺 `experiments/.../cases.json` 失敗，與第 5 步一致。
  - `node scripts/scan-sensitive.mjs`：印 `[scan-sensitive] clean.`，與第 7 步一致。
  - `git grep` 各種寫法的命中數比較（見第 6 項）。
- PowerShell 腳本（`.ps1`）在此環境無法執行，結論來自讀原始碼。

## 修正項目

| # | 文件／位置 | 類型 | 原寫法 | 實際行為（依據） | 修正 |
|---|---|---|---|---|---|
| 1 | 安裝說明 開頭表「1 規則與 skills」 | 說明與程式不一致 | 只列 `.claude\` 的四個規則檔、`skills\`、`agents\` | `sync-harness.ps1` 還會建 `CLAUDE.local.md`（沒有才建）、寫 `%USERPROFILE%\.agent-harness\source.txt` 與 `managed-skills.json`，且非 `-Check` 時無論 `-Target` 都會建立 `.codex\`、`.agents\` 資料夾 | 補列這些位置 |
| 2 | 安裝說明 開頭表「2 安全護欄」、第 6 步 | 說明與程式不一致 | `.claude\hooks\` 四支檔 | `install-hooks.cjs` 複製九支 hook＋`das-config.js` 共十支，另建 `das-hooks.json`；`--guard` 另改 `enabledPlugins`、`extraKnownMarketplaces`（實跑確認） | 改成十支檔並列出 `das-hooks.json` 與 plugin 設定 |
| 3 | 安裝說明 第 1 步 `-Check` 說明 | 說明不完整（易誤判失敗） | 「只列出會新增或覆蓋哪些檔」 | `-Check` 對未安裝項目印 `DRIFT`，最後印 `RESULT: DRIFT` 並 exit 1；第一次安裝必然如此 | 說明 `OK`／`DRIFT` 意思與第一次出現 `RESULT: DRIFT` 屬正常 |
| 4 | 安裝說明 第 1 步 | 遺漏行為 | 只說被覆蓋的檔會備份 | manifest 的 `retired` skill（`cross-model-verify`、`sub-agents`、`subagent-driven-development`）若存在於 `~/.claude/skills` 會被 `Remove-ManagedTree` 移走（有備份） | 新增一條說明，提醒同名資料夾會被移走 |
| 5 | 安裝說明 第 1 步 Codex 說明 | 指令參數不對 | 「三行的 `-Target Claude` 都換成 `-Target All`」 | 第三行 `healthcheck.ps1` 原本就沒有 `-Target`；Codex 備份路徑在 `.codex\backups`、`.agents\backups`；`uninstall-harness.ps1` 只處理 Claude | 改為「前兩行換、第三行加」，並註明 Codex 備份位置與解除安裝不涵蓋 Codex |
| 6 | 安裝說明 第 4 步 `git grep` | 指令參數不對 | `git grep -n -e "D:\\\\TAS" -e "srv-" -e "10\.255\.0\."` | 在命令提示字元／PowerShell 中反斜線原樣傳給 git，pattern 變成只比對「兩個反斜線」的 `D:\\TAS`（JS 字串寫法），漏掉 Markdown、`.cmd`、`.ps1` 裡單一反斜線的 `D:\TAS`；實測此寫法 58 筆、實際 `D:\TAS`／`D:\\TAS`／`D:/TAS` 共 287 筆。表格列的 `C:\Users\demo` 也沒被搜尋 | 改為 `git grep -n -E -e "D:[\\/]+TAS" -e "Users[\\/]+demo" -e "srv-" -e "10\.255\.0\."`，在 cmd、PowerShell、bash 結果相同（實測 565 筆） |
| 7 | 安裝說明 第 2 步護欄表 | 說明與程式不一致 | 只列 5 個護欄 | `install-hooks.cjs` 預設註冊 16 條事件，另含 `turn-budget`、`turn-end-guard`、`rea-check`、`drain-guard`、`keepgoing-detect`，以及直接從 repo `tools\` 執行的 `prompt-injection/guard.cjs`、`conversation-search/recall-hook.cjs` | 補齊表格，註明哪些只提醒、哪些需設定才作用 |
| 8 | 安裝說明 第 2 步 | 遺漏前提 | — | `tools\` 兩條 hook 與 `dhc-guard` marketplace 用 repo 的絕對路徑註冊，搬移或刪除 repo 會讓它們失效 | 新增警示：裝好後不要搬 repo，要搬先移除再重裝；並說明 `--gemini` 為選裝 |
| 9 | 安裝說明 第 2 步 | 說明與程式不一致 | 「第二行會備份 `settings.json`」 | 只有 `settings.json` 已存在時才備份；同名 hook 舊檔另存 `.bak-<時間>` | 改成條件式說法，補 hook 舊檔備份 |
| 10 | 安裝說明 第 3 步表 | 路徑不存在 | 「`tools\` 各資料夾 README」含 skill 用量統計 | `tools/skill-usage/` 沒有 README，只有 `skill-usage.cjs` | 註明改看 `skill-usage.cjs` 開頭註解 |
| 11 | 安裝說明 第 6 步 | 說明與程式不一致 | 「第一次安裝時被覆蓋的原檔放回原位」 | `uninstall-harness.ps1` 取「名稱排序最早」的 `harness-sync-*` 備份；第一次同步沒覆蓋任何檔就沒有這個資料夾，之後的備份會被當成原檔。退役 skill 不在還原清單，不會放回；`das-hooks.json`、`.agent-harness\` 也不處理 | 補充例外、建議先看 `-Check` 的 `RESTORE` 清單，列出留下的檔案 |
| 12 | README「怎麼用」第 1 點 | 指令參數不對、步驟不一致 | `sync-harness.ps1 -Target All` 後直接跑 `healthcheck.ps1` | 未加 `-ExecutionPolicy Bypass` 時，Windows 預設執行原則會擋 `.ps1`；`healthcheck.ps1` 預設 `-Target Claude`，和 `All` 不一致；解除安裝只涵蓋 Claude；也少了 `-Check` 預覽 | 改成和安裝說明一致的 `-Target Claude` 加 `-Check` 預覽，附 `All` 的對應寫法 |
| 13 | README V3.1 說明 | 說明與程式不一致 | 「註冊和原機相同的 18 條 hook」 | 預設 16 條；Gemini 2 條要 `--gemini`（`install-hooks.cjs` PLAN 篩選，實跑確認；`harness/README.md` 也寫 16 條） | 改成「預設 16 條，加 `--gemini` 共 18 條」 |
| 14 | SETUP_PROMPT 第 2 步 B／C-1 | 說明與規則檔不一致 | 「GPT 委派已停用」 | `harness/rules/CLAUDE.md` 的 `GPT / Codex delegation`：2026-10-31 起 Codex 子代理已恢復，只有 Codex PM gate 與 `chatgpt-bridge` 停用 | 改成實際內容 |
| 15 | SETUP_PROMPT 第 2 步 B／C-2 | 路徑不明 | 「改 `Communication` 那段」 | 該段只在 `harness/rules/CLAUDE.md`；`CODEX-AGENTS.md` 沒有 | 寫明路徑，註明只用 Codex 時略過 |
| 16 | SETUP_PROMPT 第 2 步 B／C-3 | 參數與後續步驟不一致 | `-Check` 固定 `-Target Claude` | 第 3 步可能用 `Codex`／`All`；`-Check` 第一次必印 `RESULT: DRIFT` | 要求 `-Target` 一致，說明 DRIFT 屬正常、`DRIFT retired tree` 要特別告知 |
| 17 | SETUP_PROMPT 第 3 步 B／C | 說明與程式不一致 | 一律說備份到 `.claude\backups` | `-Target Codex` 備份在 `.codex\backups`、`.agents\backups`，且解除安裝腳本不還原 Codex；原句也沒附 `powershell -ExecutionPolicy Bypass` 寫法 | 補完整指令與 Codex 備份位置、還原限制 |
| 18 | SETUP_PROMPT 第 3 步護欄 | 遺漏前提 | — | hooks 與 `dhc-guard` 只寫入 Claude Code 的 `settings.json`，Codex 不適用；用絕對路徑指向 repo | 註明只對 Claude Code 有效、repo 不能搬 |
| 19 | SETUP_PROMPT 第 3 步 pstack | 路徑不精確 | `rules\CLAUDE.md` | 從 repo 根目錄看是 `harness\rules\CLAUDE.md` | 補上 `harness\` |

## 核對過、沒有問題的項目

- 第 0 步工具需求、`git clone` 用法；`-NoProfile -ExecutionPolicy Bypass` 說明。
- `sync-harness.ps1` 的 `-Target`（All／Claude／Codex）、`-Check`；備份路徑 `backups\harness-sync-<時間>`；`CLAUDE.local.md` 同步時保留。
- `healthcheck.ps1` 最後印 `RESULT: OK`；沒有 Ollama 只印 `INFO`；`-CheckCodexBridge` 選裝。
- `install-hooks.cjs` 的 `--check`、`--guard`、`--no-zh`、`--remove`。
- `secret-guard` 攔金鑰／身分證／信用卡、只提醒 email／手機；`egress-log` 寫在 `~/.claude/egress-log/`；`build-check` 只在 Write 新檔時提醒。
- `dhc-guard` 需要 Claude Code ≥ 2.1.287；`rm -r`、force push、`git reset --hard`、`DROP`、無 WHERE 的 `DELETE` 規則都在 `rules.js`；「試試看」的 `rm -r C:/Temp/tas-guard-test` 會命中。
- `vendor/.claude-plugin/marketplace.json` 名稱為 `dhc-vendor`，含 `pstack`，`pstack@dhc-vendor` 正確；`CLAUDE.md` 確有「pstack workflow」段與 `@pstack-models.md`。
- 第 3 步各入口檔存在：`web-ops/cc-hosts/`、`ARCHITECTURE.md`、`remote-agent/README.md`、`local-model/DELIVERY.md`、`migration/`。
- 第 5 步已知狀況與實測一致；第 7 步 `scan-sensitive.mjs` 與 `scan-sensitive.example.json` 存在、輸出 `clean`。
- `SKILLS.md` 開頭的「複製單一資料夾」說明。

## 未處理（屬程式或範圍外，只記錄）

- `sync-harness.ps1 -Target Claude` 也會建立空的 `.codex\`、`.agents\`（程式行為，本次只在文件註明）。
- `uninstall-harness.ps1` 不還原 Codex、不還原退役 skill（程式行為，本次只在文件註明）。
- `healthcheck.ps1` 的錯誤訊息仍叫人「re-run install-harness.ps1」，該腳本只是 `sync-harness.ps1 -Target Claude` 的相容入口，結果一樣，不影響安裝。
- `SETUP_PROMPT.md` 標題仍用內部代號「TAS」，README 用「DAS」；不影響步驟，未改。
