---
name: pnl-recon
description: 每日 P&L 調節與 break 排查紀律(證券自營中台)。當使用者要「P&L 對帳/調節、flash vs actual 比對、P&L explain/attribution、數字對不上、break 排查、EOD close、損益覆核」時使用。核心:EOD close 狀態機、P&L explain 七類分解、unexplained 容差 gate、break 根因決策樹、四要素 audit trail。對不上就報 break,絕不硬湊。
---

# pnl-recon — P&L 調節與 break 排查

遵守常駐紅線 `MIDOFFICE.md`(禁編故事湊 attribution、AI 不代簽核;安裝後位於 `~/.claude/MIDOFFICE.md`)。研究依據:套件 `docs/midoffice-research-raw.json`(Effective Product Control、IB Product Control Academy、prodktr break 案例、FRTB PLA;僅存於套件)。與 `[[eod-report-discipline]]` 分工:本 skill 管**調節與排查過程**,它管**產出報表的格式紀律**。

## 1. EOD close 狀態機(逐步追蹤,遲到/被拒 = 控制訊號)

```
flash P&L(desk, T+0)→ actual P&L(中台, T+1)→ 比對 → break 解決 → 發布 → desk sign-off
```

[假設] 此為業界標準六步;公司若無 flash 或正式 sign-off 工具,裁剪成實際存在的步驟,狀態行分母同步調整。

- 每步報狀態:`{步驟, 狀態, 時限, 逾時?}`。遲交、缺漏、被拒的 sign-off 自動標紅並升級——那本身就是「P&L 可能有問題」的訊號。
- flash vs actual 持續失準是警訊(trader 理解錯誤/系統錯誤),做跨日趨勢追蹤。
- 中台要對 desk P&L 做重大調整(如 valuation adjustment)→ T+0 就通知 desk,不讓對方 T+1 才發現。
- **sign-off 是人的控制點:AI 只能催辦、備材料,不代簽不代批。**

## 2. P&L explain 七類分解(標準骨架)

市場驅動(rates/prices/spreads/FX/vol)| 新交易(day-one)| carry/時間衰減 | 費用佣金 | reserve/估值調整 | 交易事件(amend/cancel/exercise)| **unexplained residual**

六步:總變動 → 分離存量 vs 新交易 → 存量拆 driver → 檢查非市場項 → 調查 unexplained → commentary。

## 3. unexplained 容差 gate(commentary 之前必過)

- 量化慣例:線性/vanilla book unexplained < 總 P&L 1%(或固定金額門檻);exotic 可至 ~5%,但需趨勢追蹤。門檻依公司配置為準,缺配置就用此慣例並標注「用業界預設」。
- **超標 → 輸出「unexplained 超標、調查中」+ 候選原因清單。禁止硬編市場故事湊成好看的 attribution。**連續超標自動升級。

## 4. break 根因決策樹(先分類,再走固定排查路徑)

| 根因類 | 先查什麼 |
|---|---|
| timing 差異 | 兩邊資料截點/入帳日 vs 交割日 |
| 靜態資料 | master data 設置:股息扣稅率、債券條款、利息 accrual 規則 |
| booking 錯誤 | 逐筆比對:數量/價格/方向/帳戶;amend/cancel 有沒有同步 |
| 定價/估值 | 兩邊價格來源與時點;IPV 基準 |
| 公司行動/股息 | 除權息日多來源比對 |
| 費用/佣金 | 費率表版本、稅費計算 |
| 調節頻率不一致 | 各方對帳週期;解法是統一每日調節 |

每個 break 輸出:**根因類別標籤 + 證據**。拒絕無分類的泛泛描述。比對層級:部位(逐筆+彙總)、交易明細、現金(逐筆+餘額)、P&L 四種。

## 5. 容差與例外管理

- 容差外部化為配置(按 instrument type/asset class/帳戶重大性分層);AI 只引用配置、不得自行放寬。低於容差可自動 clear 但留 log;超容差進人工佇列。
- 每筆 exception 四要素:`{owner(單一負責人), 調查, 決定, 證據}` + 帳齡;帳齡超門檻強制留 commentary;優先序 = 帳齡 × 距 cutoff 時間。
- Manual Intervention Rate(需人工的比率)定期回饋校準容差。

## 6. 輸出格式

1. 狀態行:`close 進度 X/6,未解 breaks N(最老帳齡 D 天),距 cutoff T`。
2. exception-based:只列超容差項,附根因標籤與證據。
3. attribution 表(七類)+ unexplained gate 結果。
4. 驗算 code + 資料 lineage。

## 為什麼(教材)

- flash/actual 比對、IPV、sign-off 是 product control 教科書級標準(Effective Product Control ch.14-15),不是個別公司習慣。
- FRTB PLA 用 Spearman correlation + KS 檢定給 FO vs risk 系統一致性打分(交通燈)——長期可借用此思路做 desk 級品質儀表板。
- 實務案例:break 減 90% 靠的是「每日三方調節 + 分層容差 + 靜態資料治理」,不是更努力的人工。
