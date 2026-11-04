# Gemini（Antigravity CLI）接手與研究

> **公開包是整合參考，預設不登錄自動接手 hook。** 下文是原環境的操作紀錄，不代表下載即用；帳號、方案與模型名稱需自行核對現況。`agy.exe`、EKB 的 `ekb-lane.cjs`、原機 CloudCLI 依賴與排程均未附。先依實際環境配置、驗證交工與續接，再把 `takeover-whitelist.example.txt` 複製成不入 Git 的 `takeover-whitelist.txt`，逐項填入已授權的工作區；最後才用 `install-hooks.cjs --gemini` 登錄。若沒有 EKB，程式會走降級路徑，仍需可用的外部執行器。私人白名單與登入資料不可提交。

Google 學生方案（AI Pro）的額度。Gemini CLI 從 2026-06-18 起不再服務個人帳號，所以改用 Antigravity CLI（`agy.exe`，閉源，Google LLC 簽章，裝的時候核對過 SHA-512）。

## 檔案
- `agy.exe`：1.4.10，手動下載，沒有跑官方安裝腳本（那支腳本會改 PATH）。登入資料在 `%USERPROFILE%\.gemini\antigravity-cli`。
- `gemini-takeover.cjs`：Claude 撞額度時暫代。排程 TAS-GeminiTakeover（開機啟動、S4U）跑 `--loop` 每 30 秒掃一次；`cc-hosts\health-check.cmd` 每 5 分鐘也跑一次當備援（鎖檔防重疊）。模型 gemini-3.8-flash-high；報告和續跑訊息都標「Gemini 暫代・未經 Claude 核對」；紀錄在 `takeover.log`，狀態在 `takeover-state.json`。
- `takeover-whitelist.txt`：可以交給 Gemini 的工作區，一行一段路徑片段。對話內容會送到 Google（內網 IP／Email／帳密字樣先遮掉）。
- `login.cjs`：重新登入。執行後讀 `login-url.txt`，使用者登入後把授權碼寫進 `login-code.txt`；程序最多等 2 小時。
- 研究指令：`D:\TAS\ai-tools\gemini\gemini-research.cmd "<問題>"`。只查公開資訊，問題裡有內網 IP、記憶卡路徑、部位／損益、帳密字樣就拒絕（exit 2）；逾時 180 秒（exit 1）。

## 接手規則
- 條件：對話最後一則是額度上限訊息、撞限不到 1 小時、離重置還有 20 分鐘以上、工作區在白名單、這次撞限還沒接手過。
- Gemini 只自動核准改檔；系統指令只放行 node、npm test、npm run lint、git status／diff／log。改既有檔案前先備份成 `.bak-gemini`。
- 重置前 5 分鐘停手，報告寫到 `<工作區>\.gemini-takeover\`。`cc-web\auto-resume.cjs` 續跑 Claude 時會附上報告路徑，要 Claude 先核對。

## 關掉 / 還原
- 暫停接手：把 `takeover-whitelist.txt` 裡的工作區都註解掉（行首加 #）。
- 完全移除：先刪排程 `schtasks /delete /tn TAS-GeminiTakeover /f`，再把 `cc-hosts\health-check.cmd.bak-20261030gem` 和 `cc-web\auto-resume.cjs.bak-20261030gem` 複製回原檔名。

## 85% 交工（2026-10-31 起的主線）
Claude 的 5 小時用量到 85% 就交工：EKB 和 agy 互相監督做完，Claude 留 15% 額度做最後審核、上線、回覆使用者。撞 100% 的舊接手（上面）保留當最後防線；這個對話已在交工流程中就不重複接手。

- `usage.cjs`：`--loop` 每 30 秒讀 cc-web 的 `/_usage` 寫 `usage.json`（讀不到保留舊值並標 stale；hook 對超過 10 分鐘沒更新、視窗已重置、壞掉的檔案一律放行）。`TAKEOVER_USAGE_OVERRIDE=86` 可直接覆寫百分比。
- `hooks/handoff-hook.cjs`（掛在 `~/.claude/settings.json` 的 PostToolUse `.*` 和 UserPromptSubmit，只對白名單工作區、出錯放行）：
  - PostToolUse：用量 ≥85% 且主對話在這個視窗還沒提醒過 → 要 Claude 寫交接單到 `<cwd>\.gemini-takeover\HANDOFF-<session前8碼>.md` 並結束回合（子代理的呼叫不算）。
  - UserPromptSubmit：用量 ≥85% 擋下新訊息、原話寫成交接單；`!claude` 開頭放行（hook 不能改寫訊息，前綴會留在對話裡）；`/` 開頭、`<task-notification>` 等系統訊息、「【EKB＋agy 交工完成】」開頭的自動訊息放行。
  - 門檻 `TAKEOVER_HANDOFF_PCT`（預設 85）。提醒預設用 `decision:block` 送出（只用 additionalContext，Haiku 會當成工具結果夾帶的指令而不照做）；`TAKEOVER_REMINDER_MODE=context` 可改回。
- `handoff.cjs`：`handoff-queue\` 佇列（hook 放、`--loop` 掃）。交接單檔案與對話紀錄都靜止 45 秒才啟動，同一時間只跑一個。流程：快照工作區 → EKB（週一到週五 08:00–20:00、題目過 ekb-prep）出做法 → agy 動手 → 審查最多 3 輪（EKB 審；EKB 不可用就由另一個 agy 對話審）→ 程式自己跑交接單裡的驗證指令 → 報告 `<cwd>\.gemini-takeover\<時間>-<id>.md` → `chat.send`「【EKB＋agy 交工完成】…」到原對話。
  - 每個被改的既有檔案，程式依快照補 `.bak-gemini`（agy 沒備份或備份是舊的也補）；偵測刪檔。
  - agy 的 Claude 模型額度用完（RESOURCE_EXHAUSTED）時自動改用 `gemini-3.8-flash-high`，報告會標。
  - agy 的 `command(node)` 放不過 `node test.js`，所以交接單裡出現的驗證指令會逐條加進允許清單。
  - 送出前用量 ≥100%、對話 60 秒內還在動、01:00–06:00 → `notify-pending`，`--loop` 每 30 秒重試。
- 測試：`node tests\hook-test.cjs`（hook，約 5 秒）、`node tests\e2e-fake-ekb.cjs`（EKB 用假的、agy 用真的，3–6 分鐘；要在 agy 的 Claude 額度用完時加 `TAKEOVER_MODEL=gemini-3.8-flash-high`）。
- 暫停：把 `takeover-whitelist.txt` 工作區都註解掉，hook 就全部放行。完全移除：把 `~/.claude/settings.json.bak-20261031handoff` 複製回 settings.json，再把 `gemini-takeover.cjs.bak-20261031handoff`、`ekb-lane.cjs.bak-20261031handoff` 複製回原檔名並重啟排程。
