# Audit Intake——Auditor 判定的同步規則

本目錄是 Builder 與 Auditor（Astra）之間的共享工程狀態。Builder 只能「抄錄」Auditor 的判定，不得改判。

## 檔案
| 檔案 | 寫入者 | 內容 |
|---|---|---|
| `AUDITOR_SNAPSHOT.json` | Builder 抄錄 | Astra 報告中的 ID、嚴重度、判定、reviewed SHA；附來源檔 SHA-256、產生時間、報告種類。完整報告不進公開 Repo。 |
| `FINDING_LEDGER.json` | `scripts/enterprise/coordination/build_state.py` 產生 | 每個 Finding 的 builder／auditor 狀態、根因、修正 commit、回歸、驗證 SHA、證據、owner、複驗觸發條件。 |
| `STATE.json` | 同上 | PR stack、product／head／base SHA、CI run／attempt／artifact、未結 Critical／High、三方狀態、evidence fingerprint。 |
| `BUILDER_RECEIPT.md` | Builder | 本輪提交內容與證據索引。 |
| `CHANGELOG.md` | Builder | 狀態檔變更紀錄。 |

## Finding ID
不另立 ID：沿用 `v51/REPOGUARD_FINDINGS_DISPOSITION.json`（RG-V5-*、BD-*）、`v52/ASTRA_ROLL_REMEDIATION_MATRIX.json`（ASTRA-ROLL-*、RG-*）與 Astra 原始 18 項（ASTRA-001..018）。`check_state.py` 會拒絕 registry 中不存在的 ID。

## 狀態規則
- Builder 狀態上限：`FIXED_PENDING_REAUDIT`。`AUDIT_VERIFIED` 不在 Builder 列舉內，CI 會拒絕。
- `auditor_status` 只能來自 Auditor 收據；有判定就必須有 `auditor_receipt.source_sha256`。Astra 尚未看過的項目為 `NOT_YET_REVIEWED`。
- 同步 Astra 新判定的步驟：
  1. 取得 Astra 的新報告（受控位置）並計算 SHA-256。
  2. 只抄錄 ID／嚴重度／判定／reviewed SHA 到 `AUDITOR_SNAPSHOT.json`，保留原 reviewer、時間與來源。
  3. 重跑 `build_state.py`，再跑 `check_state.py`。
- `STATE.evidence_fingerprint` 必須等於 `FINDING_LEDGER.json` 的 SHA-256；不一致代表狀態過期，CI 失敗。

## 更新時機（不設背景輪詢服務）
PR push、workflow 完成或明確人工 handoff 時才更新。
