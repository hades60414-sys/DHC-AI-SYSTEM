---
name: statechart-whiteboard
description: 把 /statechart 畫出的狀態圖（TLA+ 模型的 bug 路徑、總覽）放上 DHC 規劃白板，變成可編輯、保留顏色的方框和箭頭。使用者說「放上白板」「畫在白板給我看」，或做完 statechart／形式驗證要給人看圖時使用。
---

# statechart 上規劃白板

規劃白板的「匯入」走 mermaid-to-excalidraw：只有 flowchart 會變成可編輯方框；`stateDiagram-v2`（statechart 的輸出）只會變一張圖片，子圖（subgraph）會讓匯入失敗。所以先轉成 flowchart。

1. 轉換（每張 .mmd 一次；輸出 `<名>.board.mmd`）：
   ```
   node <本技能資料夾>/scripts/to-flowchart.mjs <chart.mmd 或 bug-N.mmd> [--lr]
   ```
   保留標題、狀態標籤、步驟編號、classDef 顏色（藍粗框＝bug 路徑、綠粗框＝修正後不再出錯、紅粗框＝目前會出錯）、圖例；`<br/>` 拿掉、`after N s`／`with the fix` 改中文。
2. 檔名就是白板名稱：複製成好認的名字（例：`共享白板同時存檔-bug路徑.mmd`）。
3. 匯入：白板右上「匯入」選檔，或拖進白板視窗；每個檔變一張新白板，不動現有白板。
   代操作時（Playwright）：裝置要先有專案設定（localStorage `dhc.settingsProfile`＝設定檔 id，列表在偏好 `dhc.profiles`）；工具列的「規劃白板」鈕藏在「自選功能」後面，先 hover 再 `click({force:true})`；檔案用 `input[type=file][accept*=".mmd"]` 的 `setInputFiles`。
4. 驗證：偏好 `dhc.boards:p:<設定檔 id>` 多出這張白板、第一個元素是 `rectangle`（不是 `image`），再截圖看一次。
5. 白板底部「N 個方框沒接線」是圖例方框，正常。

圖太大（超過約 30 個狀態）先用 statechart 的 `--cover`，或只放 bug 路徑圖。
