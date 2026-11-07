# Finding 待命矩陣（51 項）

> 只是整改**預案**，不修改已固定的產品或 PR #14。Auditor 狀態原文照抄自 ledger（源自 AUDITOR_SNAPSHOT），Builder 不改判。
統計：AUDITOR_VERIFIED 1、BUILDER_FIXED_PENDING_REAUDIT 12、RETEST_REQUIRED 27、EVIDENCE_MISSING 2、NOT_IMPLEMENTED 4、HUMAN_DECISION_BLOCKED 5。

## 重點項（仍開著的 High）

| ID | 類別 | Astra 最新判定 | 若 Astra 判 FAIL：觸發條件 | 最小修補 | 測試／證據 |
|---|---|---|---|---|---|
| **ASTRA-ROLL-001** 品質比較器／封存校驗失敗碼被 tee 遮蔽 | BUILDER_FIXED_PENDING_REAUDIT | FAIL（2cc9e93） | collector／gate 對某案例誤判或 pipefail 失效 | 重現 Astra 的反例為 negative_gate_case 新案例＋test_collect_negative_gate 合成測試（RED）→ 最小修 gate.sh／collector／workflow shell → 在 ci-evidence/** 重跑 negative-gate（不需重建產品 image） | collector 14＋新案例；negative-gate run all_match；test_gate.py |
| **ASTRA-ROLL-002** Office 切換資源時沿用前一資源資料寫入／審批 | BUILDER_FIXED_PENDING_REAUDIT | FAIL（2cc9e93） | 仍有情境可在資源未就緒時寫入／審批，或 oracle 不足 | 把 Astra 的情境加進 office_stale_e2e.mjs（RED 用 2cc9e93 image）→ 最小修 useOfficeQuery／動作 guard（只動 Office 前端）→ OfficeApp.test.tsx 單元回歸 | office-e2e-evidence RED／GREEN、delivery 兩架構、vitest；若涉審批 oracle，補「決策稽核記錄 expectedRevision／sha」的 PG 斷言（OCR-V531-04） |
| **RG-001** remote-agent 命令執行面 | HUMAN_DECISION_BLOCKED | PARTIAL（2cc9e93） | 人類決策阻塞，不屬 Builder 修補 | 等 SEC-01 owner 決策（P1 預設關閉＋P2 allowlist 等）；決策後由模組 owner 實作，Builder 只補 repo 層 CI 覆蓋與證據 | remote-agent 自己的測試＋repo-coverage；不由 Builder 直接改 remote-agent |
| **RG-V5-01**  | RETEST_REQUIRED | PASS（2cc9e93） | OPS 資源上限在 d38afd8 後的變更下失效 | 以 ops-resource-probe 新增 Astra 指定情境（RED）→ 最小修 ops-report-v1.ts 上限檢查 → 不改業務規則（DEC-05） | ops-resource-probe（static-and-unit）、ops-report.integration.test.ts（併發 429、中止不寫入） |
| **RG-V5-06**  | HUMAN_DECISION_BLOCKED | PARTIAL（2cc9e93） | 人類決策阻塞 | 同 RG-001（SEC-01 Grill-Me 決策） | 同 RG-001 |

## 規則
- 每個修補：RED（Astra 反例）→ 最小修 → GREEN → 受影響 PG／E2E → 同 SHA CI → Builder Receipt；狀態最多標 FIXED_PENDING_REAUDIT。
- 程式 commit 與重產 STATE 的 docs commit 一起 push（協作狀態閘門）。
- 不改會計規則、不新增功能；remote-agent／DeID 交 owner。

## 全部 51 項（依類別）

### AUDITOR_VERIFIED（1）

| ID | 嚴重度 | Astra 最新判定 | 若 FAIL 的最小預案 | 測試 | 驗證限制 |
|---|---|---|---|---|---|
| RG-006 供應鏈台帳停在舊 SHA | LOW | PASS | 依其新判定進入 RETEST_REQUIRED 流程 | — | — |

### BUILDER_FIXED_PENDING_REAUDIT（12）

| ID | 嚴重度 | Astra 最新判定 | 若 FAIL 的最小預案 | 測試 | 驗證限制 |
|---|---|---|---|---|---|
| **ASTRA-ROLL-001** 品質比較器／封存校驗失敗碼被 tee 遮蔽 | HIGH | FAIL | 重現 Astra 的反例為 negative_gate_case 新案例＋test_collect_negative_gate 合成測試（RED）→ 最小修 gate.sh／collector／workflow shell → 在 ci-evidence/** 重跑 negative-gate（不需重建產品 image） | collector 14＋新案例；negative-gate run all_match；test_gate.py | wrong_sha256／build／smoke 三案只接受「失敗」，不辨別失敗原因（OCR-V531-06）；job log 已人工確認 |
| **ASTRA-ROLL-002** Office 切換資源時沿用前一資源資料寫入／審批 | HIGH | FAIL | 把 Astra 的情境加進 office_stale_e2e.mjs（RED 用 2cc9e93 image）→ 最小修 useOfficeQuery／動作 guard（只動 Office 前端）→ OfficeApp.test.tsx 單元回歸 | office-e2e-evidence RED／GREEN、delivery 兩架構、vitest；若涉審批 oracle，補「決策稽核記錄 expectedRevision／sha」的 PG 斷言（OCR-V531-04） | 審批這一半的 PG 狀態分不出缺陷與正常行為（OCR-V531-04），判定只靠瀏覽器 oracle；RED 審批正向段 timeout，不列為已重現 |
| ASTRA-ROLL-003 ACC 隔離集合混合兩側列 ID | MEDIUM | FAIL | 把 Astra 反例寫成 RED 測試（同檔案）→ 最小修 → 同 SHA CI | 該 finding 的 regression 檔＋受影響的 PG／E2E | — |
| ASTRA-ROLL-004 CSV parser 引號狀態 | MEDIUM | FAIL | 把 Astra 反例寫成 RED 測試（同檔案）→ 最小修 → 同 SHA CI | 該 finding 的 regression 檔＋受影響的 PG／E2E | — |
| ASTRA-ROLL-005 幣別查表命中原型鍵 | MEDIUM | FAIL | 把 Astra 反例寫成 RED 測試（同檔案）→ 最小修 → 同 SHA CI | 該 finding 的 regression 檔＋受影響的 PG／E2E | — |
| ASTRA-ROLL-006 非法日期在 DB cast 才失敗 | MEDIUM | FAIL | 把 Astra 反例寫成 RED 測試（同檔案）→ 最小修 → 同 SHA CI | 該 finding 的 regression 檔＋受影響的 PG／E2E | — |
| ASTRA-ROLL-007 離線 image reference 驗 A 啟 B | MEDIUM | FAIL | 把 Astra 反例寫成 RED 測試（同檔案）→ 最小修 → 同 SHA CI | 該 finding 的 regression 檔＋受影響的 PG／E2E | — |
| ASTRA-ROLL-008 vitest 退出碼被丟棄 | MEDIUM | FAIL | 把 Astra 反例寫成 RED 測試（同檔案）→ 最小修 → 同 SHA CI | 該 finding 的 regression 檔＋受影響的 PG／E2E | — |
| ASTRA-ROLL-009 skip／todo 未受管 | MEDIUM | FAIL | 把 Astra 反例寫成 RED 測試（同檔案）→ 最小修 → 同 SHA CI | 該 finding 的 regression 檔＋受影響的 PG／E2E | — |
| ASTRA-ROLL-011 1970-W01 前週越界 | LOW | FAIL | 把 Astra 反例寫成 RED 測試（同檔案）→ 最小修 → 同 SHA CI | 該 finding 的 regression 檔＋受影響的 PG／E2E | — |
| RG-003 CI path filter 只涵蓋 web-ui | MEDIUM | PARTIAL | 把 Astra 反例寫成 RED 測試（同檔案）→ 最小修 → 同 SHA CI | 該 finding 的 regression 檔＋受影響的 PG／E2E | — |
| RG-007 image source label 指向上游 | MEDIUM | FAIL | 把 Astra 反例寫成 RED 測試（同檔案）→ 最小修 → 同 SHA CI | 該 finding 的 regression 檔＋受影響的 PG／E2E | — |

### RETEST_REQUIRED（27）

| ID | 嚴重度 | Astra 最新判定 | 若 FAIL 的最小預案 | 測試 | 驗證限制 |
|---|---|---|---|---|---|
| ASTRA-ROLL-010 OPS 衝突計算 O(n²)／資源 | MEDIUM | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 5 萬列量測只記錄、不設門檻；單一衝突 sources 不設上限（DEC-05） |
| **RG-V5-01**  | HIGH | PASS | 以 ops-resource-probe 新增 Astra 指定情境（RED）→ 最小修 ops-report-v1.ts 上限檢查 → 不改業務規則（DEC-05） | ops-resource-probe（static-and-unit）、ops-report.integration.test.ts（併發 429、中止不寫入） | Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：web-ui/server/modules/enterprise-persistence/enterprise.service.ts、web-ui/server/modules/enterprise-persistence/ops-report-v1.t |
| RG-V5-02  | MEDIUM | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | — |
| RG-V5-03  | LOW | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項 |
| RG-V5-04  | MEDIUM | PASS | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：.github/workflows/enterprise-verify.yml |
| RG-V5-05  | LOW | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | — |
| BD-BLOB  | UNRATED_IN_REGISTRY | PASS | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 嚴重度未知（UNRATED_IN_REGISTRY）；Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：web-ui/server/modules/enterprise-persistence/enterprise.service.ts、web-ui/server/modules/enterprise- |
| BD-FLAKE  | UNRATED_IN_REGISTRY | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 嚴重度未知（UNRATED_IN_REGISTRY） |
| BD-UPGRADE  | UNRATED_IN_REGISTRY | PASS | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 嚴重度未知（UNRATED_IN_REGISTRY）；Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：.github/workflows/enterprise-image-build.yml、web-ui/deploy/customer-single/Dockerfile |
| BD-REVOKE  | UNRATED_IN_REGISTRY | PASS | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 嚴重度未知（UNRATED_IN_REGISTRY）；Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：web-ui/server/modules/enterprise-persistence/enterprise.service.ts、web-ui/server/modules/enterprise- |
| BD-PERF  | UNRATED_IN_REGISTRY | PASS | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 嚴重度未知（UNRATED_IN_REGISTRY）；Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：.github/workflows/enterprise-image-build.yml、web-ui/deploy/customer-single/Dockerfile |
| ASTRA-001  | UNRATED_IN_SNAPSHOT | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-002  | UNRATED_IN_SNAPSHOT | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-003  | UNRATED_IN_SNAPSHOT | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-004  | UNRATED_IN_SNAPSHOT | PASS | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT）；Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：.github/workflows/ |
| ASTRA-005  | UNRATED_IN_SNAPSHOT | PASS | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT）；Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：.github/workflows/ |
| ASTRA-006  | UNRATED_IN_SNAPSHOT | PASS | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT）；Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：.github/workflows/ |
| ASTRA-007  | UNRATED_IN_SNAPSHOT | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-008  | UNRATED_IN_SNAPSHOT | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-009  | UNRATED_IN_SNAPSHOT | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-010  | UNRATED_IN_SNAPSHOT | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-011  | UNRATED_IN_SNAPSHOT | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-014  | UNRATED_IN_SNAPSHOT | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-015  | UNRATED_IN_SNAPSHOT | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-016  | UNRATED_IN_SNAPSHOT | PASS | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT）；Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：.github/workflows/ |
| ASTRA-017  | UNRATED_IN_SNAPSHOT | PARTIAL | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-018  | UNRATED_IN_SNAPSHOT | PASS | 先對照 Astra 指出的不變量補 targeted 測試；若 RED 才修 | 對應 regression；若無逐項測試，新增一個針對不變量的測試 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT）；Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：.github/workflows/ |

### EVIDENCE_MISSING（2）

| ID | 嚴重度 | Astra 最新判定 | 若 FAIL 的最小預案 | 測試 | 驗證限制 |
|---|---|---|---|---|---|
| ASTRA-012  | UNRATED_IN_SNAPSHOT | NOT_RUN | 補可在 GitHub runner 執行的證據（不需本機 VM）；若需客戶／法務資料則轉人類決策 | 新的證據 job 或文件 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |
| ASTRA-013  | UNRATED_IN_SNAPSHOT | NOT_RUN | 補可在 GitHub runner 執行的證據（不需本機 VM）；若需客戶／法務資料則轉人類決策 | 新的證據 job 或文件 | 沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項；嚴重度未知（UNRATED_IN_SNAPSHOT） |

### NOT_IMPLEMENTED（4）

| ID | 嚴重度 | Astra 最新判定 | 若 FAIL 的最小預案 | 測試 | 驗證限制 |
|---|---|---|---|---|---|
| ASTRA-ROLL-012 DeID KEEP 規則穿透 arguments | MEDIUM | FAIL | 交 owner（TAS／模組 owner）依工單；Builder 只補 CI 覆蓋 | 工單內定義的測試 | 沒有修正，所以沒有修正證據；只有工單／決策文件 |
| ASTRA-ROLL-013 DeID 未知 block 原樣外送 | MEDIUM | FAIL | 交 owner（TAS／模組 owner）依工單；Builder 只補 CI 覆蓋 | 工單內定義的測試 | 沒有修正，所以沒有修正證據；只有工單／決策文件 |
| RG-002 deid-proxy 大小／逾時／背壓 | MEDIUM | FAIL | 交 owner（TAS／模組 owner）依工單；Builder 只補 CI 覆蓋 | 工單內定義的測試 | 沒有修正，所以沒有修正證據；只有工單／決策文件 |
| RG-V5-07  | MEDIUM | PARTIAL | 交 owner（TAS／模組 owner）依工單；Builder 只補 CI 覆蓋 | 工單內定義的測試 | 沒有修正，所以沒有修正證據；只有工單／決策文件 |

### HUMAN_DECISION_BLOCKED（5）

| ID | 嚴重度 | Astra 最新判定 | 若 FAIL 的最小預案 | 測試 | 驗證限制 |
|---|---|---|---|---|---|
| **RG-001** remote-agent 命令執行面 | HIGH | PARTIAL | 等 SEC-01 owner 決策（P1 預設關閉＋P2 allowlist 等）；決策後由模組 owner 實作，Builder 只補 repo 層 CI 覆蓋與證據 | remote-agent 自己的測試＋repo-coverage；不由 Builder 直接改 remote-agent | 沒有修正，所以沒有修正證據；只有工單／決策文件 |
| RG-005 供應鏈 OS HIGH 風險接受 | MEDIUM | PARTIAL | 不修；保持 BLOCKED 並更新 DECISION_PROPOSALS | — | 沒有修正，所以沒有修正證據；只有工單／決策文件 |
| RG-008 （Astra RG-008） | LOW | NOT_RUN | 不修；保持 BLOCKED 並更新 DECISION_PROPOSALS | — | 沒有修正，所以沒有修正證據；只有工單／決策文件 |
| **RG-V5-06**  | HIGH | PARTIAL | 同 RG-001（SEC-01 Grill-Me 決策） | 同 RG-001 | 沒有修正，所以沒有修正證據；只有工單／決策文件 |
| BD-REJECTED  | UNRATED_IN_REGISTRY | NOT_RUN | 不修；保持 BLOCKED 並更新 DECISION_PROPOSALS | — | 沒有修正，所以沒有修正證據；只有工單／決策文件；嚴重度未知（UNRATED_IN_REGISTRY） |

