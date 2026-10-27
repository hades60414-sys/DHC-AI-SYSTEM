# midoffice 模組設計藍圖(v0 草案,2026-08-14)

目標:讓本 harness 在「證券自營中台」工作情境下即戰——部位/限額監控、P&L 調節、交易核對、資料品質、EOD 報表、風險指標覆核。

## 受眾(2026-08-14 使用者指示)

本機為**公司共用機**,harness 受眾是**中台團隊全體**,不是單一使用者。個人可識別資訊已全部移出套件(見 changelog);所有 skill/規則以團隊通用為準,不引用任何個人背景。

## 防 overfitting 原則(硬約束)

1. 目標是**一般化的證券自營中台**,不猜使用者公司的內部系統/流程細節。
2. 所有假設標注 `[假設]`,模組全部可選可刪——不確定的做成「方法論 skill」而非「綁定某系統的腳本」。
3. Skill 教的是**檢核紀律與判斷框架**,不是計算引擎;真的算數字時遵守既有紅線(程式驗算、引來源、算錢邏輯先問)。
4. 使用者是實習生:skill 同時要能當**學習教材**(每個檢核附「為什麼」)。

## 規劃中的模組

### rules delta(併入 CLAUDE.md 或獨立 midoffice-redlines)
- AI 在中台的角色邊界:**可讀、可算、可比對、可草擬;不可執行交易、不可改正式帳務/系統資料、不可代替覆核簽核**。
- 雇主資訊隔離:交易室 flow/部位/客戶資訊不進個人系統、不外送(既有記憶已有此紅線,升格為規則)。
- 數字紀律:任何要交出去的數字先程式驗算 + 標注資料來源與時點;對不上的數字回報 break,不硬湊。

### skills 候選(依研究結果增刪)
| Skill | 內容 | 型態 |
|---|---|---|
| `position-limit-review` | 部位/限額檢核:重算曝險→比對限額(soft/hard)→超限分級與升級路徑 | 方法論 + 檢核清單 |
| `pnl-recon` | P&L 調節:FO/MO 數字比對、break 分類(價格/數量/時點/費用)、容差、排查順序 | 方法論 |
| `data-quality-gate` | 市場/部位資料品質:完整性、一致性、時效、stale price、outlier 檢測 | 方法論 + pandas 檢核 pattern |
| `eod-report-discipline` | EOD 報表產出紀律:數字驗證鏈、來源標注、格式一致性、紅綠燈摘要 | 紀律 |
| `risk-metrics-review` | VaR/Greeks/壓測**覆核**紀律(不是計算引擎):合理性檢查、backtesting 觀念 | 方法論 + 教材 |

[假設] 使用者主要用 Python/pandas 處理資料、報表以表格/Markdown/Excel 交付——skill 範例以此為主但不綁死。

## 驗收標準

- 每個新 skill 過 fresh verifier 對抗式審查(找矛盾/錯誤財金概念/過度假設)。
- 與既有 skill 無衝突(尤其 security-audit 的算錢邊界、AGENTS.md 數字紀律)。
- install → healthcheck 綠 → zip v2.4 → THIRD-PARTY/README/changelog/記憶更新。

## 時程(2026-08-14)

- 09:22 啟動,研究 fan-out 背景跑 ✅(6/6 角度完成,原始結果存 `docs/midoffice-research-raw.json`)
- 09:40 研究整併 → 模組定稿 ✅:rules/MIDOFFICE.md(常駐紅線,@import 進 CLAUDE.md)+ 5 skills(position-limit-review / pnl-recon / data-quality-gate / eod-report-discipline / risk-metrics-review)全部完成
- 下一步:對抗式審查 → 修正 → 安裝 → healthcheck → zip v2.4 → changelog/記憶 → 總結

## 定稿說明(與 v0 草案的差異)

- 原候選 `eod-report` 更名 `eod-report-discipline`,骨架採 OCC Volcker 七指標裁剪版。
- 新增常駐 `rules/MIDOFFICE.md`(原「rules delta」構想),含建議單模式、資訊隔離(證交法46/管理規則44/36-1)、數字紀律、超限語意、稽核軌跡——研究確認這些是法定義務或監理實務,值得常駐而非 opt-in。
- 全部 skill 為方法論+檢核紀律型,計算引擎刻意不做(防 overfitting:不猜公司系統)。
