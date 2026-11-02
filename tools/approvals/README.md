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
