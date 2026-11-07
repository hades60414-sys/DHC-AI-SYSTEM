# Astra Intake Index（V5.3.1）

> 本文件只提供索引，Builder **不設定任何 PASS**。每個判定都等待 Astra 的獨立收據。
> 路徑以 `web-ui/docs/enterprise/` 為起點：`v53/` 與 `coordination/` 在 PR #14 分支，`v531_maintenance/` 在 `docs/ai-office-v531-maintenance` 分支。

| 項目 | 值 |
|---|---|
| Astra 上次審核的 SHA | `2cc9e93e75133dc4247e7af3b959865cf8d9d05d`（PR #12；CONTINUATION_V4，2026-11-07T00:38+08:00，報告 sha256 `690b71a3f102…`） |
| PR #14 固定 HEAD | `38c7293d3764f61a967b2bd2e90526e218b77793`（Draft；本輪未改動） |
| 產品程式 | `d38afd88d9630a9390785ae35b745a8ad91e6c6a` |
| 最終程式 commit | `828a763681fc60c795df27733aaa5c1369be0571` |
| 證據 SHA | `c2ae88b8b93a8440a2c804fcab8b1cd72b8464f4`（Office E2E、Negative Gate） |
| 完整 CI | F1 `0e5b470`：verify 42349084781、image 42349084776、coverage 42349084813 |
| 完整入口 | `v53/FINAL_CLOSURE_REPORT.md` → `v531_maintenance/EVIDENCE_INDEX.md`（每項的 run／job／artifact／到期） |

## 兩項 High 的 RED／GREEN
| Finding | RED | GREEN | 已知限制 |
|---|---|---|---|
| ASTRA-ROLL-001 | 舊 collector 對 14 個合成反例有 9 個沒擋下（`v53/evidence/COLLECTOR_TESTS_RED_917c0c3.txt`） | 14/14（`COLLECTOR_TESTS_GREEN.txt`）。真實 run 42348102897：10 個負向 job failure、positive success、collect success、all_match（`v53/evidence/NEGATIVE_GATE_EVIDENCE.json`） | wrong_sha256／build／smoke 只判「失敗」，不辨別原因（OCR-V531-06）；job log 已人工確認 |
| ASTRA-ROLL-002 | V5.1 image：A 的內容寫入 B；PG 中 B rev 2 的 md5＝A；兩次 run 一致（`v53/evidence/OFFICE_STALE_RED_V51_run42348102966.json`） | 10/10：攔截都有命中、6 個情境完整執行、PG 一致（`OFFICE_STALE_GREEN_c2ae88b.json`）；delivery 兩個架構都 10/10 | RED 審批正向段 timeout，**不算已重現**；審批一半的 PG oracle 分不出缺陷與正常行為（OCR-V531-04） |

## 51 項狀態（`coordination/FINDING_LEDGER.json`；待命預案見 `v531_maintenance/FINDING_STANDBY_MATRIX.md`）
| 類別 | 數量 | 需要你做什麼 |
|---|---|---|
| AUDITOR_VERIFIED | 1（RG-006） | 確認仍成立即可 |
| BUILDER_FIXED_PENDING_REAUDIT | 12：ROLL-001～009、011、RG-003、RG-007 | **獨立重測**（V5.2 才修，你還沒看過） |
| RETEST_REQUIRED | 27 | **獨立重測**，其中兩種情況：<br/>• 你在 2cc9e93 判過 PASS，但修正檔之後又被改：RG-V5-01、RG-V5-04、BD-BLOB、BD-UPGRADE、BD-REVOKE、BD-PERF、ASTRA-004、005、006、016、018<br/>• 你原判 PARTIAL 的項目 |
| EVIDENCE_MISSING | 2：ASTRA-012、013 | 授權／RD 契約相關，可能需要人類資料 |
| NOT_IMPLEMENTED | 4：ROLL-012、013、RG-002、RG-V5-07 | 不需重測：DeID 工單尚未實作 |
| HUMAN_DECISION_BLOCKED | 5：RG-001、RG-005、RG-008、RG-V5-06、BD-REJECTED | **只需人工決策**（SEC-01、SC-OWNER、DEC-07 等） |

仍開著的 High：ASTRA-ROLL-001、ASTRA-ROLL-002、RG-001、RG-V5-01、RG-V5-06。

## D01／D02 殘餘風險
`AUDITOR_SNAPSHOT.json` 是 Builder 抄錄的。現有防護是 `check_state.py` 的 `PINNED_AUDITOR_REPORTS`：同時釘選來源雜湊與內容雜湊，竄改會出現在 PR diff 中。但 Builder 能同時修改 snapshot 與檢查器，所以這不能證明判定出自你。

建議你：
1. 用你的原始報告執行 `sync_auditor_snapshot.py`，重算 content_sha256，與釘選值比對。
2. 從 `v531_maintenance/AUDITOR_ANCHOR_PROPOSAL.md` 選擇簽章方案或 CODEOWNERS 方案。這需要 repo owner 核准。

## 回寫
請產出你自己的收據，內容包含 reviewer、審核 SHA、時間、報告 sha256 與逐項判定。只有你的收據能支持 AUDIT_VERIFIED。
