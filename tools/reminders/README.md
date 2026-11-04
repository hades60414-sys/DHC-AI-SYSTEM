# 一次性提醒（2026-10-25）

到時間貼一則到小助手私聊，附一顆按鈕；按下＝同意，小助手開 Opus 對話照任務檔做（使用者品味：永遠把使用者當懶人）。

- 新增：寫 `<日期>-<名>.md`（任務說明，給 Opus 看、寫到不必回頭問）＋`<日期>-<名>.json`（project／text／button 24 字內／task），再建排程：每天同一時間、到期後約 10 天結束，貼過會留 `.done` 不重貼（主機當天沒開也會補）。
- 試貼：`D:\TAS\node\node.exe remind.cjs <json> --dry`。端對端測試：`test\`（測試房 dm:dhc-assistant~dhc-verify，看不到；click.cjs 模擬按鈕，10-25 實測 15 秒開出對話並封存）。
- 目前排程：TAS-Remind-20261125-SkillPrune（11-25 09:13 起，清沒在用的技能）。取消：`schtasks /delete /tn TAS-Remind-20261125-SkillPrune /f`。
- 目前排程：TAS-Remind-20261201-SrvMainBKey（12-01 09:13 起，換 3+1 的 srv-main-b 收件金鑰，12-17 到期）。取消：`schtasks /delete /tn TAS-Remind-20261201-SrvMainBKey /f`。
- 目前排程：TAS-Remind-20261103-3p1Drill（11-03 09:13 起，查 3+1 夜間演練結果）、TAS-Remind-20261201-BtpRefresh（12-01 09:17 起，backtest 季更新）、TAS-Remind-20261117-KillTests（11-17 09:13 起，11-03 自主機制兩週淘汰檢查）。取消：`schtasks /delete /tn <名稱> /f`。
- 目前排程：TAS-Remind-20261107-HardcodeHabits（11-07 週六 09:13 起，NBLM 找把記憶習慣寫死成程式檢查的現成工具）。取消：`schtasks /delete /tn TAS-Remind-20261107-HardcodeHabits /f`。
