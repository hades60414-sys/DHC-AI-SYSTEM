# 蒸餾流程（給 Claude）

使用者說「蒸餾專案記憶」時照這個做。

1. `node "D:\TAS\Claude Code專案\Harness優化\project-memory\pm.cjs" extract`。沒有待蒸餾摘要就回報「沒有新 session」並結束。
2. 讀 `INDEX.md` 與現有專案卡，知道已經有哪些專案。另跑 `node "D:\TAS\Claude Code專案\Harness優化\project-memory\todos.cjs"` 看每個工作區的待辦清單（DHC CLI 側欄「待辦」）：用來判斷摘要裡的工作屬於哪個專案、還有哪些事沒做完。卡片上照樣只寫角色不寫人名；沒做完的待辦可寫進卡片的待辦／未完成欄位並標來源「待辦清單」。
3. 讀 `Harness優化\project-memory\digests\*.md`。摘要多（總量超過約 300KB）就按工作區分給子代理，每個子代理回傳「專案筆記」（格式同下方卡片欄位，附來源標記），由你合併。
4. 歸屬：一個 session 可能涉及多個專案；同一個專案可能散在多個工作區（例如同一支 PHP 頁面在不同人的資料夾都改過）。以**被處理的東西**（頁面、報表、工具、資料管線）判斷專案，不是以工作區判斷。只是閒聊、一次性問答、沒有可重用知識的 session 就跳過。
5. 更新或新增 `projects/<slug>.md`（slug 用小寫英數與連字號），格式照 `TEMPLATE.md`。更新既有卡時，規格變了就改正文、舊做法移到決策紀錄；不要只在底部追加。
6. 更新 `INDEX.md`（每個專案一行）。
7. `node pm.cjs check`，有問題就修到通過；check 抓不到人名以外的真實姓名，所以自己再看一遍有沒有人名、數字、帳密。
8. `node pm.cjs done`。
9. 回報：新增／更新了哪些卡、跳過哪些 session、有哪些「（未確認）」需要人看。
