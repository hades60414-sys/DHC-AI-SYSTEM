# V5.3.1 Engineering Maintenance：最終待命交接

**狀態：`BUILDER_MAINTENANCE_COMPLETE`／`WAITING_FOR_ASTRA_VERDICT`／`COMMERCIAL_RELEASE_NO_GO`**

本輪沒有改 PR #14，沒有觸發 CI，也沒有修改產品。文件放在 `docs/ai-office-v531-maintenance` 分支：從 PR #14 HEAD `38c7293` 分出，只含文件，沒有開 PR。Builder 的審查不代表 Astra 的判定。

## 1. GitHub 狀態（2026-11-07 唯讀核對）
- PR 狀態：
  - **#14**：Open、Draft，HEAD `38c7293d3764f61a967b2bd2e90526e218b77793`，70 個變更檔，0 則 review，1 則留言（F2 CI）。
  - **#10～#13**：Open、Draft，head 未變（`1e481e2`／`877525f`／`2cc9e93`／`601dbb3`）。
- 本輪起點之後沒有新的 workflow run。最新一批是 F2 的 3 個 run：42349749547、42349749608、42349749548，全部 success。
- 文件與 GitHub 的對帳：`CI_MATRIX.json`、`SUPPLY_CHAIN_PROVENANCE.json`、`EVIDENCE_SOURCES.json` 中共 36 個 job／artifact，id 與 digest 都和 API 一致。`check_state.py --require-git` PASS。

## 2. Evidence Index
`EVIDENCE_INDEX.md`／`.json`：共 51 項，其中 24 項有逐項對應的目前 CI 證據。每項記錄：Finding、Product SHA、Test SHA、Run、Job、Artifact、到期日、路徑與驗證限制。其餘 27 項沒有逐項的測試對應，原因已在限制欄寫明；不會把整套 CI 硬套成單項證據。

產生方式：`python3 -B docs/enterprise/v531_maintenance/tools/build_evidence_index.py <artifact-json 目錄>`

## 3. Finding 待命矩陣
`FINDING_STANDBY_MATRIX.md`：

| 類別 | 數量 |
|---|---|
| AUDITOR_VERIFIED | 1 |
| BUILDER_FIXED_PENDING_REAUDIT | 12 |
| RETEST_REQUIRED | 27 |
| EVIDENCE_MISSING | 2 |
| NOT_IMPLEMENTED | 4 |
| HUMAN_DECISION_BLOCKED | 5 |

重點 High：ASTRA-ROLL-001、ASTRA-ROLL-002、RG-001、RG-V5-01、RG-V5-06。每項都附「若 Astra 判 FAIL」的最小修補與測試預案。

## 4. Auditor Anchor 提案
`AUDITOR_ANCHOR_PROPOSAL.md`，兩個方案：
- **A**：Astra 用 Ed25519 簽章，報告做成 RFC 8785 canonical JSON（auditor-receipt/v1），配合 ALLOWED_SIGNERS、key rotation 與撤銷規則。
- **B**：CODEOWNERS 加上 ruleset。

實施需要 repo Admin。Builder 不持有、也沒有產生任何 Auditor 金鑰。

## 5. Image 保存提案
`IMAGE_PRESERVATION_PROPOSAL.md`。

⚠️ 時效問題：
- V5.1 與 V5.2 產品 SHA 的 image tar artifact **今天（2026-11-07）就會到期**。
- F1／F2 的 image tar artifact 在 **2026-11-08** 到期。

若需要精確二進位，必須在到期前決定是否核准 GHCR private＋digest＋SBOM＋attestation。若不核准，之後只能用 Dockerfile 加固定 base 重建，重建出的 image id 不保證與原本相同。

## 6. 客戶 UAT 執行準備
`CUSTOMER_PILOT_UAT_PLAN.md`：66 項逐項列出角色、前置資料、Expected、Evidence、簽認欄與失敗處理。

| 分層 | 數量 |
|---|---|
| T1 試點必測 | 42 |
| T1 客戶專屬（只能客戶執行） | 3 |
| T2 試點測（已知缺口需事先揭露） | 17 |
| 排除 | 4 |

工程狀態不能轉成客戶 PASS。目前 PASS＝0。

## 7. 下一輪整改優先級（Astra 判定後才開始）
1. **ASTRA-ROLL-001／002（High）**：只要 Astra 判 FAIL，就先處理，因為這兩項只需重跑證據 workflow、不必重建產品 image。
2. **D01／D02 的 Auditor 錨點**：人類決策後才實作 CI 驗章。
3. **RG-V5-01（High，RETEST_REQUIRED）**：補 targeted 的 probe 與 PG 測試。
4. **其他 RETEST_REQUIRED 中 Astra 點名的項目**。
5. **RG-001／RG-V5-06（SEC-01）、DeID 工單**：交給 owner。

## 8. 未決的人類決策
| ID | 事項 |
|---|---|
| ANCHOR | Auditor 錨點（方案 A／B） |
| IMAGE | GHCR 封存與否（有時效） |
| SEC-01 | remote-agent |
| SEC-02 | DEID-01..10 |
| DEC-05 | OPS 合計上限，以及 6.4 MB 衝突 JSON |
| DEC-07 | 拒收的 OPS Report 是否去重 |
| SC-OWNER | OS HIGH 風險接受 |
| UAT-66 | 客戶試點與簽認 |
| RD-002／RD-003 | 未批准的契約 |
| IP／AGPL／SDK／DAS | 授權與歸屬 |
| SOW 等 | SOW／價格／到期／維護 |
| GHCR | 正式發布 |

選項見 `v53/DECISION_PROPOSALS.md` 與本目錄兩份提案。

## 9. 下一個 Agent 可以直接執行的工作
| # | 工作 | 前提 | 指令／位置 |
|---|---|---|---|
| 1 | 核對 PR #14 是否被 Astra 固定、有沒有新報告 | 無 | `gh pr view 14 …`；到受控交接位置（Astra 審核資料夾，不在 repo）查看有無新的報告目錄 |
| 2 | 收到 Astra 報告後抄錄 | 有新報告 | `sync_auditor_snapshot.py` → 更新 `check_state.py` 的 `PINNED_AUDITOR_REPORTS` → `build_state.py` → `check_state.py --require-git`。只能在**新分支**上做；PR #14 若已被固定則不動 |
| 3 | 依判定挑出要處理的 FAIL 項 | Astra 判定 | `FINDING_STANDBY_MATRIX.md` |
| 4 | 實作 Auditor 錨點的 CI 驗章 | 人類核准方案 A 或 B | `AUDITOR_ANCHOR_PROPOSAL.md` |
| 5 | GHCR 封存 workflow | 人類核准 | `IMAGE_PRESERVATION_PROPOSAL.md` |
| 6 | 客戶試點 | 客戶核准與環境 | `CUSTOMER_PILOT_UAT_PLAN.md` |
| 7 | 重產 Evidence Index | 有新 run 時 | `tools/build_evidence_index.py` |

禁止事項：
- 不改 #10～#14
- 不 Force Push、不 Merge、不 Release、不部署
- 不改 remote-agent／DeID
- 不碰本機 QA VM
- Builder 不得標 AUDIT_VERIFIED
- 不無限輪詢
