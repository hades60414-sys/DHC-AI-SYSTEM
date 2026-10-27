---
name: cross-model-verify
description: 跨模型對抗式驗證。當使用者要求用 Codex/GPT second opinion、cross-check、跨模型驗證，或安全、法規、金錢/數字、DB migration、發布等載重結論需要異質審查時使用。透過 codex-verifier 與 PowerShell bridge 執行；一般偵察或實作改用 codex-scout/codex-worker。
---

# Cross-model verify

目標是用不同模型家族的盲點差異抓錯，不是增加贊成票。

## Route

- 機械或廣域偵察：`codex-scout`（Luna/medium/read-only）。
- 獨立可擁有的實作 lane：`codex-worker`（Terra/high/workspace-write）。
- 安全、法規、金錢/數字、DB/schema、發布或難解 bug：`codex-verifier`（Sol/high/read-only）。
- 主模型不是 FABLE (`claude-fable-5`)或無法確認模型時的規劃領導：`codex-bridge -Role pm`(Sol/high/read-only)，由 Sol 出計畫、本地模型執行；session 中途因額度、fallback、功能受限或手動 `/model` 降離 FABLE 時重新觸發。
- 主 Claude 保留需求解讀、資訊隔離、衝突裁決、整合與最終驗證。

不要再用 Python `sub-agents` runner 呼叫 Codex；本機 EndpointGuard 會殺長跑 Python。不要只用 `Get-Command codex` 判斷；WindowsApps alias 可能存在但不可執行。三個 Codex skills 會透過 `codex-bridge` 解析桌面版實體 CLI。

## Adversarial brief

給 verifier：待反駁的 claim、精確檔案/範圍、驗收標準、已知排除、需要的 `file:line` 證據與停止條件。不要提供預期 verdict。要求輸出 `CONFIRMED`、`REFUTED` 或 `INCONCLUSIVE`，並列出未驗證項目。

一個異質 verifier 通常足夠。只有兩個鏡頭能獨立檢查不同失敗模式時才加第二路；不要為形式湊票。

## Information boundary

不得傳 credentials、secrets、客戶/委託/部位/flow、公司 DB row values 或不可去敏的機密程式片段。無法安全去敏就留在 Claude 本線驗證，並明示少了一個異質鏡頭。

Codex 結果是證據，不是最終判決。失敗、timeout 或部分結果都要當 coverage gap 回報。
