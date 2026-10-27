---
name: tas-charts
description: 把資料做成可直接分享的單檔 HTML 圖表或報告（日報一頁、月報／專題），零外部依賴、內網離線可開、雙擊即看。依資料形狀選圖，數字和圖形嚴格成正比，一份交付只用一套色系，紅漲綠跌與億／百萬單位照台灣慣例。使用者說「畫圖」「做圖表」「視覺化」「做成報告／日報／月報頁」「這組數字畫一下」時使用。要放進 Excel、PPT 原生圖表或內網 PHP 頁時不用（那是各自的工具）。
---

# tas-charts

產出是一個 HTML 檔：圖表程式 `chartkit.js` 內嵌在檔案裡，不連任何外部網址（沒有 CDN、沒有線上字型），所以內網、離線、寄給同事都打得開。

## 檔案

- `chartkit.js`：繪圖函式庫（純 SVG）。一頁呼叫一次 `CK.use(色系)`，再呼叫各圖。
- `templates/page.html`：圖表頁（一張或幾張圖）。
- `templates/report-daily.html`：日報一頁（狀態行 → KPI → 例外表 → 證據圖）。
- `templates/report-monthly.html`：月報／專題（三句結論 → 每節一圖一解讀 → 附表）。
- `examples/gallery.html`：每種元件各一張的示意頁，查用法、看樣子都看這裡。
- `scripts/build.mjs`：把草稿裡的 `<script>/*CHARTKIT*/</script>` 換成 chartkit 全文。
- `scripts/check.mjs`：交付前檢查，加 `--render` 會用本機 Edge／Chrome 實際開啟並確認每張圖都畫出來。

## 流程

1. **先判交付形式。** 預設是圖表頁。使用者明講「報告、日報、月報、一頁摘要」才用報告模板。資料多不等於要報告。
2. **先驗數字再畫。** 加總、勾稽、單位換算用程式算過，結果對不上就當 break 回報，不畫成好看的圖蓋過去。資料來源和截止時間要寫進來源行。
3. **依資料形狀選圖**（下表）。一張圖只講一個結論；兩張圖講同一件事就刪一張。一頁超過 6 張就拆頁。
4. **複製模板到工作資料夾**，填 `{{…}}`、換資料，標題寫結論。
5. **打包並驗收：**
   ```
   node <skill>/scripts/build.mjs 草稿.html 成品.html
   node <skill>/scripts/check.mjs 成品.html --render --shot 成品.png
   ```
   check 沒通過不交付。看一眼截圖：標籤有沒有重疊、主角是否一眼看得到。
6. 回報時附檔案路徑、用了哪套色系與理由、資料來源與截止時間。

## 資料形狀 → 圖

| 資料長相 | 用 | 備註 |
|---|---|---|
| 少數類目比大小（≤12） | `bar` | 類目名長或要排名改 `hbar` |
| 類目名長、要排名 | `hbar` | `sort:'desc'` |
| 有正有負（損益、增減） | `diverging` | 預設紅漲綠跌 |
| 時間序列 | `line` | 多條線時名稱標在線尾；主角用 `highlight` |
| 單一序列看總量走勢 | `area` | 一定從 0 起 |
| 各期構成＋總量 | `stacked` | 值不可為負；有序組成加 `ordered:true` |
| 兩個時點比較（上月 vs 本月） | `dumbbell` | `pnl:true` 時實心點依增減上色 |
| 從期初拆到期末（損益歸因） | `waterfall` | `start`、`steps`、`endLabel` |
| 類目 × 類目（部門 × 日） | `heatmap` | 有正負自動用漲跌雙色 |
| 兩個連續量的關係 | `scatter` | 第三個量放 `size`（面積編碼） |
| 100% 構成（取代圓餅） | `waffle` | 每格 1%，類目多就合併成「其他」 |
| 限額使用率 | `limits` | `value/limit`，`soft` 預警線、100% 上限 |
| 重點數字 | `kpi` | `delta` 依台灣慣例上色；非損益的變動加 `neutral:true` |
| 一句話狀態 | `status` | `ok / warn / breach` |
| 例外清單、明細 | `table` | 空清單會顯示 `empty` 文字，不會留白 |

沒有適合的圖時，先用表格或最接近的圖，並跟使用者說清楚；不要硬造一種新圖。

## 不可違反

- **數值和圖形成正比。** 長條不斷軸；有極端值就讓它衝出去、或另做一張放大圖並寫明。面積編碼用開根號（chartkit 已處理）。
- **標題寫結論，不寫圖型名。** 「自營一組貢獻最大」可以，「長條圖」不行。
- **副標寫單位、期間、顏色在代表什麼。** 圖上刻度只有數字，單位靠副標。
- **一份交付只用一套色系**，所有圖共用：
  - `ink`（灰階，預設）：明度＝重要性。
  - `harbor`（藍階）：有序資料、單一序列，氣質正式。
  - `jade`（分類色，最多 5 類）：無序類目要分得開。
  - `signal`（灰＋一個藍色主角）：整頁只想讓一件事跳出來。
  - 使用者給品牌色時用自訂：`CK.use({bg, card, txt, mut, grid, data, hero, cat?, ramp?})`，對比不足會記成錯誤。
- **漲跌色是語意色，不屬於色系**：預設台灣慣例紅漲綠跌；對外商或英文讀者用 `CK.use('ink', {updown:'intl'})`。限額的預警黃、超限紅是另一組，只在 `limits`、`status` 用。
- **類目超過色系容量就不要硬上色**：合併成「其他」、改用 `highlight` 只標主角，或拆圖。chartkit 會直接報錯擋下。
- **不做**：3D、發光、漸層裝飾、雙 Y 軸、圓餅（用 `waffle`）。使用者堅持時說明原因，給替代做法。
- **示意資料不能出現在正式交付**：`CK.demo` 只給 gallery 用，check 會警告。

## chartkit 參考

共同參數：`unit`（'億'、'百萬'、'%'…，加在數值後）、`digits`（小數位）、`parens`（負數用括號）、`height`、`highlight`（類目名或陣列；有設就只有主角是深色）、`pnl`（依正負上紅綠）。

```js
CK.use('ink');                                   // 一頁一次
CK.bar('#c1', { data: [{label, value}], unit: '億', digits: 2, highlight: '自營一組' });
CK.hbar('#c2', { data, sort: 'desc' });          // diverging 同參數，預設 pnl:true
CK.line('#c3', { x: ['8/1', ...], series: [{name, values: [...]}], highlight: '自營一組', zero: false });
CK.stacked('#c4', { x: [...], series: [{name, values}], ordered: false });
CK.dumbbell('#c5', { data: [{label, a, b}], aName: '上月', bName: '本月', pnl: true });
CK.waterfall('#c6', { start: {label, value}, steps: [{label, value}], endLabel: '本月合計' });
CK.heatmap('#c7', { rows: [...], cols: [...], values: [[...], ...] });
CK.scatter('#c8', { data: [{x, y, label, size}], xName, yName, xUnit, yUnit, highlight: [...] });
CK.waffle('#c9', { data: [{label, value}] });
CK.limits('#c10', { data: [{label, value, limit}], soft: 0.8 });
CK.kpi('#k', { items: [{label, value, unit, digits, delta, deltaLabel, neutral, note}] });
CK.status('#st', { level: 'warn', text: '…' });
CK.table('#t', { columns: [{key, label, num, digits, unit, pnl, sign}], rows: [...], empty: '今日無例外' });
CK.toUnit(123456789, '億');                      // → 1.2345…
```

資料有問題時（不是數字、長度對不上、負值進堆疊圖），該圖位置會顯示紅框寫原因，`body` 的 `data-ck-errors` 加一；`check.mjs --render` 會把它列出來。不會靜默少畫一張。

## 列印

報告頁已含 A4 列印樣式（卡片不跨頁、動畫關閉）。要 PDF 時用瀏覽器列印，或：
`msedge --headless=new --print-to-pdf=成品.pdf 成品.html`。
