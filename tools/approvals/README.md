# 核准單（2026-10-28）

要在別台機器（srv-db、srv-rag、srv-main、pc-mgr、同事主機）做需要使用者同意的事時，不給使用者 SOP，改開核准單：卡片貼到使用者和小助手的私聊，使用者按「同意核准單 xxxxxx」，一分鐘內由程式執行並把結果貼回聊天室。

## 開單（任何對話都能用）
1. 把要執行的指令寫進一個檔案（危險字串寫在指令列會被 dhc-guard 擋）。
2. 執行：
   ```
   D:\TAS\node\node.exe D:\TAS\ai-tools\approvals\ask.cjs --machine rag1 --cmd-file <指令檔> --why "<為什麼>" --rollback "<怎麼回退>" [--timeout 600]
   ```
   - `--machine`：`.mcp.json` 的伺服器名稱，例如 ragent（srv-db）、rag1（srv-rag）、pcmain、pcmgr、userB、userD、userE、userC、userF、userA；那台要開 ragent_cmd。
   - 指令只能是一行 CMD。要跑 SQL 檔：先用一般的 ragent_cmd 把檔案寫到那台（寫新檔不用核准），核准單裡只放 `sqlcmd ... -i <檔>`。
   - 回退方法要具體（備份表名、還原指令）；沒有回退就照實寫「無法回退」。

## 免核准白名單（2026-10-28）
- 純查詢、看 log 的唯讀指令不開單：`ask.cjs` 判斷符合 `whitelist.txt` 就直接執行，結果貼回聊天室（標「免核准」），紀錄照樣存在 `tickets\<id>.json`（`auto: true`）和 `approvals.log`（`auto` 列）。這類指令可以不給 `--rollback`。
- 預設清單：`hostname`、`whoami`、`ver`、`dir`、`type`、`tasklist`、`netstat`、`findstr`、`reg query`、`sqlcmd`（只收 `-Q "SELECT ..."`）。
- 比對規則（保守）：
  1. 指令只要含 `& | < > ^ % ! ( ) ;`、反引號或換行就一律開單，不論白名單怎麼寫（擋串接、管線、重導向、變數展開）。所以 `%SRC_PWD%` 這類密碼變數也不能用；sqlcmd 免核准只能用 `-E` 或預先設好的 `SQLCMDPASSWORD`。
  2. 含網路路徑 `\\` 或 `//` 一律開單（避免對外連線、送出認證）。
  3. 指令原文開頭要和白名單某一條完全相同（不分大小寫、不能加引號），後面一定接空白或結尾。例如 `reg query` 只放 `reg query ...`，`reg add` 不放；`C:\x\hostname`、`hostnamex`、`"dir"\..\cmd.exe`、`dir\..`、`dir.exe` 都不算。
  4. sqlcmd 另外檢查：要剛好一個 `-Q`、內容以 SELECT 開頭；`-S` 只收本機（`.`、`localhost`、`127.0.0.1`，可帶執行個體）；有 `-i -o -q -z`，或 SQL 裡有 INTO、INSERT、UPDATE、DELETE、EXEC、DROP、BEGIN、WHILE、IF、SET、RECEIVE、NEXT、xp_、sp_ 等字就開單。
  5. tasklist 帶 `/s /u /p`（連別台）、findstr 帶 `/f:`（清單檔可能含網路路徑）就開單；sqlcmd 的 SQL 有四段式名稱（連結伺服器）也開單。
  6. 實際送出時前面加 `set NoDefaultCurrentDirectoryInExePath=1& `（存在核准單檔的 `sent`），避免家目錄裡同名的 `hostname.bat` 之類被執行。
- 那台代理一次只跑一份工作；別的對話正在用時，免核准執行會失敗並照實貼回「執行失敗：還有一份工作在等結果」，稍後重送即可。
- 新增／移除（會先自動備份到 `whitelist.bak\`）：
  ```
  D:\TAS\node\node.exe D:\TAS\ai-tools\approvals\whitelist.cjs add "schtasks /query"
  D:\TAS\node\node.exe D:\TAS\ai-tools\approvals\whitelist.cjs remove "schtasks /query"
  D:\TAS\node\node.exe D:\TAS\ai-tools\approvals\whitelist.cjs list
  D:\TAS\node\node.exe D:\TAS\ai-tools\approvals\whitelist.cjs check "<指令>"
  ```
  只加真的不會寫入的命令；像 `ipconfig` 帶 `/release` 會改設定，就不要整個加進來。
- 關掉白名單：把 `whitelist.txt` 裡的規則行全部刪掉或加 `#`（全部回到開單）。

## 核准後續接（2026-11-03，學 ChatGPT「核准到位後自動續接」）
- 開單時自動記下開單的對話（`CLAUDE_CODE_SESSION_ID`，存在核准單的 `origin`）。使用者按鈕、指令執行完後，`wake.cjs` 叫醒那個網頁版對話：「核准單 xxx 已執行，讀結果把原本的工作做完」。開單後 AI 可以先結束回合，不用守著等。
- `--next "<執行後要做什麼>"` 會一起帶進叫醒訊息；`--no-resume` 不叫（測試、純通知用）。常設授權卡啟用後也會叫醒。
- 只在對話閒著時送（最後一則是已結束的回覆、60 秒內沒寫入）；忙就由 watch.cjs 每分鐘再試，6 小時沒閒下來就放棄。不是網頁版的對話（claude -p、無頭）或已封存的不叫。紀錄在 approvals.log 的 `wake-try`／`wake`。
- 手動補叫：`node wake.cjs <id>`（`--dry` 只看會送什麼）。測試：`node test\wake-e2e.cjs`（要在網頁版對話裡跑）。
- 回退：`copy /y` 蓋回 ask.cjs、run.cjs、watch.cjs、grant.cjs 的 `.bak-20261103wake`。

## 時限續做（2026-11-03）
- 使用者在 Harness優化 說「到 8 點前隨便你」「再試兩小時」，UserPromptSubmit hook `~/.claude/hooks/keepgoing-detect.js` 自動登記時限（`keepgoing\<sessionId>.json`）；說「停／先停／不用做了」取消。
- watch.cjs 每分鐘跑 `keepgoing.cjs tick`：時限內、對話閒著超過 2 分鐘、距上次叫醒超過 5 分鐘，就送「【時限續做】還有 N 分鐘，讀 checkpoint 接著做」。回覆寫「【時限工作完成】」就停；時間到送一次收尾（寫總結、不開新工作）；最多叫 40 次。
- 起因：11-03 夜裡給到 08:00，AI 02:43 列完待決定就結束回合，沒東西叫醒它，閒到 07:26。借 ralph-loop 的完成標記和次數上限，但不用 Stop hook 硬擋，等閒著才送。
- 手動：`node keepgoing.cjs start <sid> --until 10:20 [--goal x]`、`list`、`stop <sid>`、`tick --dry`。測試：`node test\keepgoing-unit.cjs`。
- 回退：還原 `C:\Users\demo\.claude\settings.json.bak-20261103keepgoing`；watch.cjs 蓋回 `.bak-20261103wake`（會一併拿掉核准後續接的重試）。

## 在場時先說好（2026-11-03，觀察者提案、使用者同意上線）
- 使用者人在對話裡時，不用叫他去私聊按卡：AI 開單後，在同一段對話把單號和要做的事列出來，使用者接著回「OK／同意／都做」就算核准，AI 再跑 `node run.cjs <id>`（或等排程一分鐘內執行）。私聊卡片照樣會貼，兩種擇一。
- 程式核對（`wake.cjs` 的 `convApproval`）：開單後 AI 的回覆裡要出現過這個單號；使用者在那之後打的那一則是同意（短的同意詞，或「同意 <單號>」）。回了別的（提問、逐項、先不要）就不算，要 AI 再列一次單號。系統通知、續接訊息、子代理不算使用者。
- 限制同常設授權：AI 與排程同一個 Windows 帳號，防誤用不防惡意。測試：`node test\conv-unit.cjs`（13 項）。

## 常設授權（2026-11-03，仿 ChatGPT Custom rules）
同一台、同一類的動作（例如每次都在 srv-rag 跑同一支部署腳本）不想每次開單時：AI 開一張「常設授權」卡，使用者按一次，之後指令開頭符合的直接執行，結果照樣貼回並標「依常設授權 <id>（剩 N 天／N 次）」。
```
D:\TAS\node\node.exe D:\TAS\ai-tools\approvals\grant.cjs propose --machine rag1 --prefix "D:\TAS\deploy\push-page.cmd CBAS" --why "<為什麼>" [--days 14] [--uses 20]
D:\TAS\node\node.exe D:\TAS\ai-tools\approvals\grant.cjs list
D:\TAS\node\node.exe D:\TAS\ai-tools\approvals\grant.cjs revoke <id>
D:\TAS\node\node.exe D:\TAS\ai-tools\approvals\grant.cjs check --machine rag1 --cmd "<指令>"
```
- AI 只能 propose；啟用由排程 watch.cjs → run.cjs 在核對使用者按鈕後寫入 `grants\<id>.json`。授權檔存字首的 SHA-256，字首被改就不命中。
- 期限最多 30 天（預設 14）、次數最多 100（預設 20），先到先停；`revoke` 立刻失效。
- 字首至少兩段（命令＋參數，例如完整腳本路徑），不能只授權一個命令名。
- 程式硬排除，不能存成授權、指令裡出現也不放行：串接／重導向／變數展開字元（含 `%X_PWD%`）、網路路徑、刪除（del、rd、move、/mir）、權限（icacls、net、reg、sc、setx、runas）、對外（curl、wget、ftp、ssh、certutil）、資料庫（sqlcmd、bcp…）、系統層與腳本主機（powershell、wmic、msiexec…）、schtasks 只收 /run /end /query、含 password／_PWD／_TOKEN 字樣。
- 限制：AI 和排程是同一個 Windows 帳號，這是防誤用、不是防惡意；改得到 `grants\` 的程式就能偽造授權。
- 測試：`node test\grant-unit.cjs`（30 項判斷）、`node test\grant-e2e.cjs`（測試房開卡→沒按要拒→按鈕啟用→srv-rag echo 直接執行→次數減一→撤銷後回到開單；11-03 實測通過）。
- 回退：`copy /y ask.cjs.bak-20261103grant ask.cjs`、`copy /y run.cjs.bak-20261103grant run.cjs`（grant.cjs 與 grants\ 留著不影響）。

## 安全設計
- 核准單存在 `tickets\<id>.json`，裡面有指令的 SHA-256；執行前重算，不一致就拒絕。
- `run.cjs` 只在聊天室裡找得到「不是小助手」發的、內容完全等於按鈕字、時間晚於開單的訊息時才執行。
- 24 小時過期；只能執行一次（`.lock` 檔搶鎖，狀態改成 done 或 failed）。
- 執行的指令由程式從核准單讀出，直接呼叫那台代理；模型不經手。小助手只回「收到」。
- 信任範圍和現在的聊天室相同：拿得到網址的人都能按。

## 排程與紀錄
- 排程 `TAS-Approvals-Watch`（S4U，每分鐘一次）跑 `watch.cmd` → `watch.cjs` → `run.cjs`。
- 紀錄：`approvals.log`（開單、執行、結果）、`watch.log`（只有出錯才有內容）。
- 停用：`schtasks /change /tn TAS-Approvals-Watch /disable`；移除：`schtasks /delete /tn TAS-Approvals-Watch /f`。

## 測試
- `node test\e2e.cjs`：在看不到的測試房開單、沒按就跑要被拒、模擬按鈕、等排程執行、重跑要被拒（10-28 實測 35 秒執行完）。
- `node test\negative.cjs`：指令被改、過期都要被拒。
- `node test\whitelist-unit.cjs`：白名單判斷 45 筆（11 筆該放行、34 筆帶串接／寫入該開單），只呼叫判斷函式、不執行指令。
