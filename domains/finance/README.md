# finance 用途包

金融中後台日常工作的檢核與報表 skill。啟用方式見 [domains/README.md](../README.md)。

| skill | 用途 |
|---|---|
| [pnl-recon](pnl-recon/SKILL.md) | 每日損益（P&L）調節：flash 對 actual、P&L explain、容差閘門、break 根因 |
| [eod-report](eod-report/SKILL.md) | 日終報表：固定格式、例外導向、狀態行、數字驗證鏈 |
| [limit-check](limit-check/SKILL.md) | 限額檢核：使用率矩陣、soft/hard 分級、超限紀錄 |
| [data-quality](data-quality/SKILL.md) | 資料品質：五個維度、stale price、異常值、獨立驗價 |
| [risk-metrics-review](risk-metrics-review/SKILL.md) | 風險指標覆核：VaR、Greeks、壓力測試、前台與風控系統一致性 |

## 共同原則

- 數字必須勾稽。合計對得上明細，明細對得上來源。
- 對不上的差額稱為 break，附證據回報，絕不為了讓數字吻合而調整、補平或四捨五入掩蓋。
- AI 只讀、計算、回報。不修改限額、部位或來源資料，也不建議繞過控制。
- 每個結論都要能追溯到資料來源與截止時間。資料不完整或過期時，結論要明說，或不下結論。
