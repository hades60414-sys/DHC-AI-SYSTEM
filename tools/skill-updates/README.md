# 第三方技能／外掛更新

每週一 08:43 排程 `TAS-SkillUpdateCheck`（S4U）跑 `check-updates.cmd`：比對 `sources.json` 每個來源目前裝的版本和 GitHub 最新版，有新版就貼一則到 Harness優化 和小助手的私聊。同一個新版只提醒一次（`state.json`）。它只讀 GitHub 公開 API，不下載、不安裝。

- 手動跑：`node check-updates.cjs --dry`（只印）、`--force`（已提醒的也重貼）
- 關掉：在這個資料夾建 `off` 檔；紀錄：`check-updates.log`
- 加來源：在 `sources.json` 加一列（`repo`、`pin` 或 `clone`、`paths`）

## 使用者說「更新技能」時

1. `node check-updates.cjs --dry` 看哪些有新版。
2. 每個要升的來源，取新版到新的空資料夾（有 clone 的：`git fetch` 後 `git archive origin/<branch> | tar -x -C <新資料夾>`）。
3. 走 `scan-before-install`：交給 security-reviewer 子代理審 pin..新版 的差異，重點是新 hook、新腳本、package.json 的 lifecycle scripts、對外連線、Python（本機不能跑）。
4. 判定可以裝才裝：
   - pstack：clone `git checkout <新版>` → `D:\TAS\cc-host\claude plugin marketplace update pstack-claude` → `claude plugin update pstack@pstack-claude` → 比對 cache 和審過的樹 → 確認 `session-start.sh` 輸出 0 位元組（`session hook: off` 有讀到）。
   - 收進 v2 包的技能：複製到 `agent-harness-v2\skills\<名>` → harness-sync → `-Check`。
5. 更新 `sources.json` 的 `pin`（有 clone 的就是 clone 的 HEAD）、v2 包 `THIRD-PARTY.md` 一列、autonomy-log。
6. 回退：clone `git checkout <舊 pin>` 再 `claude plugin update`；v2 包技能用備份還原後 harness-sync。
