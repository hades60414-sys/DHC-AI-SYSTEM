---
name: eod-report-discipline
description: EOD/日常監控報表產出紀律(證券自營中台)。當使用者要「日報/EOD 報表、daily pack、監控面板、風險日報、給主管的彙總表、breach 摘要」時使用。核心:Volcker 七指標裁剪的 daily pack 骨架、exception-based 呈現、狀態行、數字驗證鏈、固定格式與收件人。日終彙總必產出,不因「今日無事」省略。
---

# eod-report-discipline — EOD 報表紀律

遵守常駐紅線 `MIDOFFICE.md`(數字附 lineage、AI 不代簽核;安裝後位於 `~/.claude/MIDOFFICE.md`)。研究依據:套件 `docs/midoffice-research-raw.json`(OCC Volcker metrics、兆豐證陳報頻率實例、exception 管理實務;僅存於套件)。與 `[[pnl-recon]]` 分工:它管調節與排查過程,本 skill 管**產出報表的格式紀律**。

## 1. daily pack 骨架(Volcker 官方 5 項 + 中台自訂 2 項,按公司實際持有品裁剪)

官方七指標中的「庫存周轉」「客戶對向交易比率」對純自營中台實用性低,以「未解 breaks」「資料品質」替代;需要對監理口徑時回官方七項。

| 區塊 | 內容 | 異常觸發器 |
|---|---|---|
| 限額使用率 | 每一限額逐一列 usage(接 `[[position-limit-review]]` 的矩陣) | soft/hard 名單 |
| VaR / Stress VaR | 值、限額比、backtest 例外數 | 超限、例外增加 |
| 風險因子敏感度 | delta/vega/duration 依品種 | 大幅跳動 |
| P&L attribution | 七類分解(接 `[[pnl-recon]]`) | **unexplained 超容差** |
| 庫存帳齡 | 持倉天數分布 | **帳齡異常增長** |
| 未解 breaks | 數量、最老帳齡、owner | 帳齡超門檻 |
| 資料品質 | 五維度紅綠燈(接 `[[data-quality-gate]]`) | STALE/FAIL 清單 |

「未歸因損益」與「庫存帳齡異常」是最值得 AI 主動示警的兩個觸發器(官方定義明確、噪音低)。

## 2. 呈現紀律

- **exception-based**:首頁只放紅綠燈摘要 + 異常清單;全量明細進附錄。沒人讀的全量表不是報告。
- **狀態行開頭**:`日期 | 紅 x 黃 y | 未解 breaks N(最老 D 天)| 距申報 cutoff T`。
- **固定格式、固定收件人、固定頻率**,依公司陳報規定(分層示例——日報→高層、週報→風管、季報→董事會、異常即時——取自兆豐證券公開揭露,僅供參考)。日終彙總**必產出**——「今日無超限」也要出,無事本身是需要留痕的控制證據。
- 涉及月度申報時點(如月計表、資本適足申報在次月 10 日前)提前列入狀態行倒數。

## 3. 數字驗證鏈(每個數字可回溯)

1. 來源系統與資料時點(lineage)。
2. 計算 code/查詢附上,可重跑。
3. 與前日比對:跳動超過合理範圍先自查(資料品質?計算變更?)再發布。
4. 過 `[[data-quality-gate]]`:有 STALE/FAIL 的輸入,對應數字標注品質狀態,不得無註記地混入。

## 4. 紅綠燈語意(寫死)

- 綠:全部指標在限內、資料品質過、breaks 在容差內。
- 黃:soft 預警、unexplained 接近容差、breaks 帳齡增長、資料 DEGRADED。
- 紅:hard breach、unexplained 超容差、STALE 資料被迫使用、sign-off 被拒/逾期。
- **紅黃的判定只依規則,不因「今天大家很忙」降級。** AI 不得被說服把紅改黃。

## 5. commentary 紀律

- 先數字後敘事;每句敘事可指回一個數字。
- unexplained 超標 → 寫「調查中+候選原因」,不編故事(同 `[[pnl-recon]]` gate)。
- 草稿身分:報表由人簽發,AI 產出標注「草稿,待覆核」。

## 為什麼(教材)

- 七指標是 prop desk 監控唯一有官方完整定義的指標集(OCC Volcker specifications),拿它裁剪比自創清單可防漏。
- exception-based + 狀態行:報表的讀者是要在 30 秒內決定「今天要不要介入」的人,不是要讀完 20 頁的人。
- 「無事也出報告」:控制的存在證據與異常本身同等重要(內控稽核視角)。
