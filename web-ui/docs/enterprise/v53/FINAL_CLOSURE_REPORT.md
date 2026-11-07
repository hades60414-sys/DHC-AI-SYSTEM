# DHC AI Office V5.3.1：後端工程里程碑收束報告

> **唯一入口。** 本報告列出的檔案，路徑都以 `web-ui/docs/enterprise/` 為起點。
> 本報告是 Builder 的提交，**不是**獨立驗收。

## 0. 階段性判定（第 16 項）
| 判定 | 狀態 | 依據 |
|---|---|---|
| `V53_BACKEND_ENGINEERING_MILESTONE_READY` | **成立**（條件見第 16 節）。Builder 自己確認的 Critical／High 中，D01／D02 只做了緩解，殘餘風險已交人類決策 | 本報告 §5～§11 |
| `ASTRA_INDEPENDENT_REAUDIT_PENDING` | 保留 | Astra 最新報告只審到 PR #12 `2cc9e93`；#13、#14 都還沒有 Astra 報告（AUDITOR_REPORT_NOT_AVAILABLE） |
| `CUSTOMER_UAT_NOT_APPROVED` | 保留 | 66 項 UAT 中 PASS＝0（§12） |
| `COMMERCIAL_RELEASE_NO_GO` | 保留 | 安全、授權、產品、商務 Gate 都還沒決策（§13） |

沒有任何項目由 Builder 標成 AUDIT_VERIFIED。唯一的 AUDITOR_VERIFIED 是 RG-006，它來自 Astra 的 CONTINUATION_V4 報告。

## 1. 目前產品已具備的功能與技術架構
- **企業身分與隔離**：RBAC、session epoch 撤權、PostgreSQL FORCE RLS，並且每個請求都包在一個交易裡。
- **文件與草稿**：文件版本、引用完整性、草稿版號、送審與審批；approval 綁定 revision 與 sha256。
- **Office 前端**：資料綁定當前資源；資料未就緒時不能儲存、送審或審批（ROLL-002）。
- **OPS-REPORT-v1**：多來源週報。
  - 上限：總列數 5 萬、總大小 25 MiB、單行 16 KiB。
  - 計算在交易外進行，commit 前重新驗證撤權。
  - 有併發閘門（滿載回 429）；用戶端中止時不寫入。
- **ACC-MATCH-v1 對帳**：兩側隔離計算，匯出 JSON、CSV、Markdown 三種格式，並做 CSV 公式注入防護。
- **交付**：單一客戶 image（amd64／arm64），工具 `dhc-office.py`（install／bootstrap／backup／restore），支援升級與回退。
- **CI**：
  - 所有 job 都用 `shell: bash`（含 pipefail）。
  - gate.sh 分別記錄工具、比較器、閘門三段退出碼。
  - 另有負向閘門證據、Office RED／GREEN E2E、協作狀態 schema 2 檢查。
- 架構圖：`architecture/`（C4、CI、資料流、路線圖）。

## 2. PR #10～#14 的版本關係
| PR | 分支 | Head | 角色 |
|---|---|---|---|
| #10 | integration/enterprise-rcfix-v4-20261106 | `1e481e2fca812dcd2bfc45645623129bd7b54dea` | V4 RC，Astra track A |
| #11 | feature/ai-office-backend-v5-20261106 | `877525f27eed8d394f609d7ad7d2d8695be1035b` | V5 後端，Astra track B |
| #12 | fix/ai-office-v51-repoguard-hardening | `2cc9e93e75133dc4247e7af3b959865cf8d9d05d` | V5.1，Astra CONTINUATION_V4 審核標的 |
| #13 | fix/ai-office-v52-astra-roll | `601dbb3ee1d75f94ce75947af6e1cb2eea17661c` | V5.2，Astra 固定標的，未變更 |
| #14 | fix/ai-office-v53-closure | 最終 HEAD 見 §3 | V5.3／V5.3.1 本輪（Draft，stacked 在 #13 上） |

每個 PR 都是 Draft。沒有 Merge、Force Push 或 Release。

## 3. SHA 角色
| 角色 | SHA |
|---|---|
| 產品程式 `product_sha` | `d38afd88d9630a9390785ae35b745a8ad91e6c6a`（V5.3／V5.3.1 沒有改產品路徑；CI 以 git 歷史驗證） |
| 最終程式 commit | `828a763681fc60c795df27733aaa5c1369be0571` |
| F1：完整 CI 跑的 commit | `0e5b470776c38c44e322057ed3bbae132fa2cce6` |
| F2：本報告所在的 docs commit，即 PR #14 HEAD | 見 PR，以及 `coordination/STATE.json` 的 `pr_head_sha` 說明 |
| Office E2E 證據 | `c2ae88b8b93a8440a2c804fcab8b1cd72b8464f4`（run 42348102966） |
| Negative Gate 證據 | `c2ae88b8b93a8440a2c804fcab8b1cd72b8464f4`（run 42348102897） |
| Auditor 最新審核 | `2cc9e93e75133dc4247e7af3b959865cf8d9d05d`（Astra CONTINUATION_V4，2026-11-07T00:38+08:00） |

機器可讀的版本在 `coordination/STATE.json` 的 `shas`，各證據的來源與依賴路徑在 `coordination/EVIDENCE_SOURCES.json`。

## 4. 本輪實際完成的整改
| commit | 內容 |
|---|---|
| 785485e | ROLL-001：collector fail closed。RED 9/14 → GREEN 14/14（`evidence/COLLECTOR_TESTS_*`） |
| 87b1b49 | ROLL-002：E2E 逐項核對（`OFFICE_E2E_VERIFICATION.md`） |
| d23bddd、cb19d46 | 狀態 schema 2：SHA 角色、證據來源矩陣、closure_class、補抄錄 Astra CONTINUATION_V4 |
| e71725b | OCR-V531-01（High）／02／03／05／09。RED 在 cb19d46 → GREEN |
| 828a763 | OCR-V531-D01／D02（High，緩解）／D03。RED 在 c2ae88b → GREEN（`evidence/STATE_CHECK_*`） |
| 0e5b470（F1） | 證據與狀態對齊 |

產品程式沒有任何改動。

## 5. Negative Gate：11 個案例（ROLL-001）
證據為 run 42348102897（c2ae88b，強化後的 collector）：
- `evidence/NEGATIVE_GATE_EVIDENCE.json`：all_match＝true、continue_on_error_found＝false、problems 為空。
- 強化前的 run 42343824459 保存在 `NEGATIVE_GATE_EVIDENCE_45713dc_pre_hardening.json`。

| 案例 | job／gate step | tool／comparator／gate exit |
|---|---|---|
| positive_control | success／success | 0／0／0 |
| tool_nonzero_output_all_pass | failure／failure | 1／1／1 |
| comparator_nonzero_new_fail | failure／failure | 1／1／1 |
| new_skip、new_todo、missing_output、truncated_report | failure／failure | 0／1／1 |
| frontend_exit1_all_pass | failure／failure | 1／1／1 |
| wrong_sha256 | failure／failure | `sha256sum -c \| tee`，靠 pipefail 傳遞 |
| build_failure | failure／failure | 真實的 buildx 失敗：`COPY missing-file`，"/missing-file": not found |
| smoke_failure | failure／failure | 真實容器 `exit 3` |

workflow 整體 conclusion 是 **failure**，這是預期結果，不代表產品 CI 失敗；collect job＝success。

## 6. Office RED／GREEN（Browser＋PG，ROLL-002）
詳見 `OFFICE_E2E_VERIFICATION.md`。最新證據為 run 42348102966：`evidence/OFFICE_STALE_RED_V51_run42348102966.json`、`OFFICE_STALE_GREEN_c2ae88b.json`。

- **RED**（V5.1 `2cc9e93` image）：
  - A 的內容被寫進 B；PG 裡 B 的 rev 2 md5 等於 A 的內容。
  - 審批未就緒時就送出決定，D 被以 C 的內容核准。
  - 兩次 run 結果一致。
  - 審批的正向段落逾時，**不列為已重現**。
- **GREEN**（c2ae88b image）：10 項檢查全部通過。
  - 四個負向情境的攔截都實際命中，6 個情境都完整執行，driver exit 0。
  - PG 版號、內容、approval、audit 全部一致。
- **雙架構 delivery GREEN**：見 §9。
- **已知限制**（OCR-V531-04）：審批這一半的 PG 狀態分不出缺陷與正常行為，判定只靠瀏覽器偵測器。

## 7. ACC／OPS 資料正確性與效能
- **ACC 手算 golden**：獨立 Reviewer 重算後一致；單元測試 7/7；真 PG 三格式匯出一致（`evidence/PG_ACC_OPS_TESTS.txt`）。
- **OPS**：
  - 非法日期回 400 且不寫入；併發閘門滿時回 429；用戶端中止時不寫入。
  - 5 萬列同站衝突：45713dc 時 542 ms／CPU 640 ms／RSS 201 MB；F1 時 715 ms／CPU 853 ms／RSS 203 MB；結果 JSON 6.4 MB（`evidence/OPS_RESOURCE_PROBE.json`，只記錄不設門檻）。
  - 6.4 MB 這點保留在 DEC-05 待決，沒有改規則。
- 會計規則沒有變更，不需要 ADR。

## 8. OCR（第 8 項）
詳見 `OCR_REVIEW.md`，原始輸出在 `ocr/`。

- **模式**：OCR delegate 負責選檔，由隔離 Reviewer 做語意審查。`ocr review` 的 LLM 模式**沒有執行**（DEC-OCR-01）。
- **覆蓋**：55/55，其中 38 檔語意審查、17 檔完整性審查。
- **Findings**：首審 10 項（High 1、Medium 3、Low 6）；delta 複驗又發現 5 項（High 2、Medium 1、Low 2）。
- **處置**：
  - 已修：01、02、03、05、09、D03。
  - 緩解：D01、D02。
  - 記錄不改：04、06、10、D04、D05。
  - 已更新文件：07、08（本次 docs）。

## 9. 最終 GitHub CI
F1 `0e5b470776c38c44e322057ed3bbae132fa2cce6`，attempt 1：

| Workflow | Run | 結論 | Jobs |
|---|---|---|---|
| enterprise-verify | [42349084781](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42349084781) | success | postgres-integration 128333153403 success、static-and-unit 128333153533 success、csv-spreadsheet-safety 128334253438 success |
| enterprise-image-build | [42349084776](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42349084776) | success | build-arm64 128333153616 success、build-amd64 128333153833 success、delivery-arm64 / delivery 128333817245 success、delivery-amd64 / delivery 128333890302 success、upgrade-rollback-amd64 128333890371 success |
| repo-coverage | [42349084813](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42349084813) | success | coverage-contract 128333153680 success |
| office-e2e-evidence（c2ae88b） | 42348102966 | success | red-v51 128330146126、green-current 128330145971 |
| negative-gate-evidence（c2ae88b） | 42348102897 | failure（預期） | collect 128330204686 success |

完整 job／artifact id／digest／到期日：`CI_MATRIX.json`。delivery 內的 Office E2E GREEN：amd64 10/10、arm64 10/10。

- 另外，828a763 單獨推送時，verify 被 SHA 混用閘門擋下（run 42348453024，job 128331283056）。這是 fail-closed 的實證。
- 本報告所在 docs commit（F2）自己的 CI run ID 記在 PR #14 留言中，因為文件無法包含自己那次 commit 的 run。

## 10. Image／SBOM／Trivy／來源追溯
| arch | image id | tar sha256 | archive artifact（到期） | report／SBOM artifact |
|---|---|---|---|---|
| amd64 | `sha256:b1569cc3e68b320774b77ec4851b40387cef9f6ff2b69006dddb34a5f9461e68` | `dc95b5343b183e4eb122f6b5c1d38d195782018324627940a05fb06bc0453c45` | 13564593892（2026-11-08T06:58:39Z） | 13564798331 |
| arm64 | `sha256:269013852e2ff36910933359eacf0e3abd903738d8fb18ba73aea60006cebefb` | `5c89131c888dfe1b09f68d1ce5e8a29a5c3c675b102eaf119cb8142c49ef021c` | 13565136328（2026-11-08T06:58:34Z） | 13564404185 |

source revision＝`0e5b470776c38c44e322057ed3bbae132fa2cce6`（label），runtime base `node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`，授權 AGPL-3.0-or-later；建置指令見 `SUPPLY_CHAIN_PROVENANCE.json`。

- Trivy 結果與 V5.2 相同：OS 層 CRITICAL 1（zlib1g CVE-2023-45853，will_not_fix）、HIGH 34，語言套件 0／0，屬 SC-OWNER 範圍。
- **長期保存建議**：image archive artifact 會在 2026-11-08 到期（見上表）。若需要精確二進位，建議由人類核准後，在 GitHub 端推到 GHCR，用 private package 並以 digest 釘選，再加 attestation。不在使用者的 Mac 上保存 image。
- 目前保存的是：建置指令、image id、tar sha256、SBOM、Trivy 與 artifact id（`SUPPLY_CHAIN_PROVENANCE.json`、`CI_MATRIX.json`）。

## 11. 51 項 Finding 的當前狀態
完整清單見 `coordination/FINDING_LEDGER.json`。

| closure_class | 數量 | 說明 |
|---|---|---|
| AUDITOR_VERIFIED | 1 | RG-006，Astra PASS，且之後修正檔沒有再被改 |
| BUILDER_FIXED_PENDING_REAUDIT | 12 | ROLL-001..009、011、RG-003、RG-007：V5.2 才修，Astra 還沒看過 |
| RETEST_REQUIRED | 27 | Astra 給 PARTIAL，或 Astra PASS 後修正檔又被改（例如 RG-V5-01、BD-*、ASTRA-004/005/006/016/018） |
| EVIDENCE_MISSING | 2 | ASTRA-012、013（Astra NOT_RUN） |
| NOT_IMPLEMENTED | 4 | ROLL-012、013、RG-002（DeID 工單）、RG-V5-07 |
| HUMAN_DECISION_BLOCKED | 5 | RG-001、RG-005、RG-008、RG-V5-06、BD-REJECTED |

- **仍開著的 Critical／High**：ASTRA-ROLL-001、ASTRA-ROLL-002、RG-001、RG-V5-01、RG-V5-06。
- **嚴重度未知**：原 18 項 UNRATED_IN_SNAPSHOT、BD-* 為 UNRATED_IN_REGISTRY，都保留為未知，沒有推定為 LOW。

## 12. 66 項 UAT
來源：`uat/UAT_TRACEABILITY_V5.json`。

- 工程判定：GENERIC_VERIFIED 42、PARTIAL 17、NOT_IMPLEMENTED 4、CUSTOMER_UAT_PENDING 3。
- **客戶判定：PASS 0**，需要真人依權限簽認。
- BLOCKED_PRODUCT_DECISION：UAT-L03、UAT-L05。

## 13. 尚未解決的 Gate
詳見 `DECISION_PROPOSALS.md`，全部 PENDING：
- **安全**：SEC-01（remote-agent）；SEC-02（DEID-01..10，含 ROLL-012／013）；SC-OWNER；以及 D01／D02 需要 Auditor 錨點（CODEOWNERS＋branch protection 或簽章摘要）。
- **授權**：IP／AGPL／SDK／DAS。
- **產品**：DEC-05、DEC-07、RD-002／003、條款比對。
- **商務**：SOW、價格、到期、維護，以及 GHCR 正式發布。

## 14. 與架構圖、路線圖的差異
- **V5.3**：路線圖新增 NEW_IN_V53 五項；`DEPLOYMENT_CI_ARCHITECTURE.mmd` 加入隔離證據 workflow。
- **V5.3.1**：只強化 CI 與狀態檢查，產品架構沒有變動。新增的部分：
  - CI static-and-unit 改用 `fetch-depth: 0`；
  - 協作狀態 schema 2；
  - collector fail closed。

  這些變更都在 CI 層，所以路線圖項目沿用 V53-NEG／V53-COORD，不另立新項。

## 15. 下一位 Agent 接手
1. 先讀 `v53/CLOSURE_CHECKPOINT.md` 與 `coordination/STATE.json`，再用 `gh pr view 14` 核對 HEAD。
2. 本機驗證：
   ```bash
   cd web-ui
   python3 -B scripts/enterprise/coordination/check_state.py --require-git
   python3 -B scripts/enterprise/coordination/test_check_state.py --require-git
   python3 -B scripts/enterprise/ci/test_collect_negative_gate.py
   ```
3. 每次改程式，都要把**程式 commit 與重產的 STATE commit 一起 push**。只推程式 commit，CI 會被協作狀態閘門正確擋下。
   ```bash
   python3 -B scripts/enterprise/coordination/build_state.py --product-sha <產品> --base-sha 601dbb3… --pr-head-sha <最後程式 commit>
   ```
4. 要重跑證據時，把同一個 SHA push 到 `ci-evidence/<名稱>`，再更新 `EVIDENCE_SOURCES.json`。
5. 收到 Astra 報告時：
   1. `sync_auditor_snapshot.py` 只抄錄，不改判。
   2. 更新 `check_state.py` 的 `PINNED_AUDITOR_REPORTS`。
   3. 重新產生狀態。
6. 禁止事項：
   - 不改 #10～#13
   - 不 Force Push、不 Merge、不 Release
   - 不改 remote-agent／DeID
   - 不碰本機 QA VM
   - Builder 不得標 AUDIT_VERIFIED

交接文件：`HANDOFF_TO_ASTRA.md`、`HANDOFF_TO_CHATGPT.md`、`NEXT_SESSION_HANDOFF.md`、`CLOSURE_CHECKPOINT.md`；完整性檢查用 `SHA256SUMS`（在 `docs/enterprise/` 執行 `shasum -a 256 -c v53/SHA256SUMS`）。

## 16. 判定的條件對照
| 條件 | 結果 |
|---|---|
| 最終 HEAD 正式 CI 全綠 | ✅ F1 全綠（§9）；F2（只有文件）的 CI 記在 PR 留言 |
| Negative Gate 有有效的 job／step 反例 | ✅ §5 |
| Office RED／GREEN 有真 Browser＋PG 證據 | ✅ §6（RED 審批正向段除外） |
| 沒有未處理的 Builder-confirmed Critical／High | ✅ OCR-01 已修；D01／D02 已緩解並轉人類決策（殘餘風險已明列） |
| OCR 已完成或明確標記 | ✅ 隔離 Reviewer＋delta 複驗；LLM 模式 NOT_RUN（有理由） |
| SHA、State、Finding、Receipt 對帳一致 | ✅ `check_state.py --require-git` 在 CI 執行 |
| 交接文件足以讓下一位 Agent 恢復 | ✅ §15 |
