# Handoff → Astra（獨立 Auditor）— V5.3

Builder 已提交，請以唯讀方式獨立複驗。Builder 沒有代替你下任何判定。

## 固定目標
- 產品原始碼：`d38afd88d9630a9390785ae35b745a8ad91e6c6a`（與 V5.2 相同）
- 證據 head：`45713dce4a272cd9303478ffe56ac8c732eacd23`（PR #14；#13 `601dbb3` 沒有變動）
- 你上次審查的 SHA：track A 為 `1e481e2`，track B 為 `877525f`（取自 `coordination/AUDITOR_SNAPSHOT.json`）

## 建議的複驗重點
1. **ASTRA-ROLL-002**（你標為 RUNTIME_NEGATIVE_NOT_RUN）：
   - 看 run 42343824443 的 artifact `office-stale-red-v51` 與 `office-stale-green-current`。
   - 也可以自己用 workflow_dispatch 重跑 `office-e2e-evidence`。
   - RED 端：PG 中 B 的 rev 2 等於 A 的內容。GREEN 端：B 沒有任何一版等於 A，且稽核一致。
2. **ASTRA-ROLL-001／008／009**：看 run 42343824459 的 `negative-gate-evidence`，確認案例 step 沒有使用 continue-on-error，失敗來自真實的退出碼。
3. **ASTRA-ROLL-003**：手算 golden 在 `scenarios/會計對帳/golden/跨側同列ID_預期.json`，真 PG 測試在 run 42343825984 的 postgres-integration。
4. **ASTRA-ROLL-010**：50k 同站衝突的量測在 `evidence/OPS_RESOURCE_PROBE.json`；單一衝突的 sources 清單不設上限，列為殘餘風險。
5. **RG-V5-***、**BD-***（V5.1）：你尚未看過，目前 ledger 標 `NOT_YET_REVIEWED`。

## 回寫方式
- 請產出你自己的收據，至少包含 reviewer、審查 SHA、時間、報告 sha256 與逐項判定。
- Builder 只會把收據抄錄進 `AUDITOR_SNAPSHOT.json`，然後重新產生 ledger（流程見 `coordination/AUDIT_INTAKE.md`），不會改判。
- `AUDIT_VERIFIED` 只能由你的收據支持。

## 已知限制
- RED 審批情境在舊 UI 逾時，已如實記錄在 scenarioErrors，沒有隱藏。
- GitHub runner 只跑 amd64 的 RED／GREEN 專用 workflow；arm64 的 GREEN 是在 delivery 裡跑的。
- 不 Merge、不 Release、不部署。
