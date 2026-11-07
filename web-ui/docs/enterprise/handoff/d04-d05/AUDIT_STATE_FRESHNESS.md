# AUDIT-STATE-D04/D05 — 變更影響與驗證收據

- 工作包：OCR-V531-D04（非 PASS 項 closure_class 可互換）／OCR-V531-D05（CI 讀取的 docs JSON 仍被當文件，證據 SHA 後變更不觸發過期）
- 固定對照：PR #14 HEAD `38c7293d3764f61a967b2bd2e90526e218b77793`；本分支 `fix/ai-office-state-freshness`
- Commits：`7dfd7c7`（fix）→ `d27a37f`（STATE 重產）→ 本檔所在 commit（handoff 文件）
- 產品碼／測試／部署／workflow／golden／LEDGER：零變更（git diff 確認）

## 設計

### D04 — closure_class 完整機械推導（check_state.py）
- 每個 Finding：`closure_class` 由 `builder_status`＋AUDITOR_SNAPSHOT 最新判定＋「修正 commit 是否晚於審核 SHA」機械推導（規則與 build_state.py 同）：
  1. `BLOCKED_DECISION`／`HUMAN_DECISION_REQUIRED` → `HUMAN_DECISION_BLOCKED`
  2. `WORK_ORDER_ISSUED`／`OPEN` → `NOT_IMPLEMENTED`
  3. 修正 commit 不在審核 SHA 之內 → `BUILDER_FIXED_PENDING_REAUDIT`
  4. PASS（或 `AUDIT_VERIFIED`）→ 再檢「修正 commit 碰過的檔案於 `reviewed_sha..product_sha` 是否又被改」→ `RETEST_REQUIRED`，否則 `AUDITOR_VERIFIED`
  5. 狀態含 `NOT_RUN` → `EVIDENCE_MISSING`
  6. 否則 `RETEST_REQUIRED`
- `--require-git`（CI 必帶）時要求**精確一致**；無 git 歷史時退回候選集合檢查（不排除需要祖先資訊才能區分的類別）。
- 另：`closure_class＝AUDITOR_VERIFIED` 仍需 SNAPSHOT PASS（既有）；`builder_status`↔registry、severity↔來源、open_critical_high、closure_counts 推導（既有）不變。

### D05 — Checker 實際讀取的輸入納入證據新鮮度閘門（check_state.py）
- 新增 `CHECKER_INPUTS`（18 個路徑）：UAT Index、UAT_TRACEABILITY、roadmap.json、v51/v52 registry、AUDITOR_SNAPSHOT、EVIDENCE_SOURCES、golden `scenarios/*`、`gate.sh`、`compare_known_failures.py`、`known-v32-baseline-failures.json`、`collect_negative_gate.py`、`negative_gate_case.py`、`test_gate.py`、`office_e2e_redgreen.py`、`uat_evidence_index.py`、`render_roadmap.py`。
- 每個證據（`pending_rerun` 除外）在其 SHA 之後有 `CHECKER_INPUTS` 變更 → 該證據過期（需 Recheck），與既有 depends_on 規則同級。
- `pr_stack[PR #14].head` 固定為里程碑快照 `38c7293…`（不再隨分支產生時 HEAD 改寫）；`shas.pr_head_sha` 維持「產生本 STATE 的分支 HEAD」語意，必須是 HEAD 的祖先且其後只改 `docs/enterprise/`。

## 影響表（Impact Matrix）

| 項目 | 變更前 | 變更後 | 風險 |
|---|---|---|---|
| closure_class 互換（D04） | 非 PASS 項可在 `BUILDER_FIXED_PENDING_REAUDIT`/`RETEST_REQUIRED`/`EVIDENCE_MISSING`/`NOT_IMPLEMENTED`/`HUMAN_DECISION_BLOCKED` 間互換不被拒 | git 可用：精確推導比對；無 git：候選集合拒違規 | 推導規則與 build_state.py 需同步修改——已固定同一規則，並有 RED 測試 |
| CI 讀的 docs/JSON（D05） | `docs/enterprise/` 下 roadmap/UAT/registry 被當文件，SHA 後變更不觸發證據過期 | 18 個 checker 輸入納入證據新鮮度；pending_rerun 可豁免 | 誤判敏感度由「路徑」決定；.md 敘述不受限 |
| pr_stack[#14].head 語意 | 產生時 HEAD（平行分支會改寫為自己的 HEAD，偽裝 PR #14） | 固定 `38c7293`（里程碑交接固定） | 舊 STATE 直接不相容 → 已隨本分支重產 STATE（CI_PENDING） |
| 證據狀態 | 5 項證據 `CI_EVIDENCE_READY` | 5 項 `pending_rerun`、`ci_status=CI_PENDING` | 本分支不宣稱證據新鮮；需以最新 HEAD 重跑後才能移除 |
| UAT 證據索引 | 只指 6933d5e／42247102617／27 | 逐列補 `current_evidence`（F2 `38c7293` 之 verify `42349749547`／image `42349749608`／e2e `42348102966@c2ae88b`）；EVIDENCE_MISSING 不補；sec01 local-harness 明示不在 CI | 歷史頂層 SHA 保留；沒有任何全表 SHA 替換 |
| FINDING_LEDGER / 產品碼 / workflow | — | 零變更 | — |
| AUDITOR_SNAPSHOT / D01 D02 | — | 不動（外部信任根缺失，維持 PARTIAL） | — |

## RED（必須拒絕）— 實測結果（2026-11-07，本機 `--require-git`）

| 案例 | 結果 |
|---|---|
| closure_swapped_fixed_to_evidence_missing（ASTRA-ROLL-001→EVIDENCE_MISSING） | exit 1 拒絕 ✓ |
| closure_swapped_fixed_to_not_implemented（→NOT_IMPLEMENTED） | exit 1 拒絕 ✓ |
| closure_swapped_human_blocked_to_not_implemented（RG-001→NOT_IMPLEMENTED） | exit 1 拒絕 ✓ |
| closure_swapped_evidence_missing_to_retest（ASTRA-ROLL-012 WORK_ORDER→RETEST_REQUIRED） | exit 1 拒絕 ✓ |
| checker_inputs_changed_after_evidence_sha（清 pending 後，Office E2E 證據因 UAT Index 變更被判過期） | exit 1 拒絕 ✓（git 案例） |
| roadmap_source_changed_after_evidence_sha（clone 實測） | exit 1 拒絕 ✓ |
| uat_index_changed_after_evidence_sha（clone 實測） | exit 1 拒絕 ✓ |
| 既有 25 個負向案例（含偽造 Auditor PASS、registry 降級、golden 變更） | 全部維持 exit 1 ✓ |

## GREEN / 合法控制 — 實測結果

| 案例 | 結果 |
|---|---|
| baseline（工作樹） | `{"status": "PASS", "findings": 51, "git_checked": true, "problems": []}` ✓ |
| docs_only_change_after_pr_head_positive（純 CHANGELOG.md 變更） | exit 0 ✓ |
| uat_evidence_index.py --check | exit 0（66 列、分布 37/19/10 不變）✓ |
| render_roadmap.py --check | exit 0 ✓ |
| test_check_state.py --require-git 全 suite | `OK`（含新案例）✓ |

## 機器 Schema 驗證
- STATE_KEYS／FINDING_KEYS／CLOSURE／BUILDER／SEVERITY 列舉與必填欄位檢查（既有）不變。
- 新增：`closure_class` 對機械推導值（或無 git 時候選集合）的強制一致性（D04）。
- `pr_stack[PR #14].head` 必須等於 PINNED_PR14_HEAD（38c7293）：里程碑固定。

## 已知限制與未宣稱
- 本分支不產生新的 CI 證據：5 項證據標 `pending_rerun`、`ci_status=CI_PENDING`；本檔不構成任何 AUDIT_VERIFIED。
- D01/D02（Auditor 信任根／外部簽章）未動，維持 PARTIAL；需 Admin/Signer 決策。
- UAT 索引的 `current_evidence` 只證明「同一測試內容於 38c7293 的 F2 CI 全綠」，不構成客戶 UAT 通過；`pass` 一律 `false`。
- `local-harness`（SEC-01）不在 CI；索引保持歷史證據，不補當前連結。
- 證據重跑（移除 pending_rerun）屬下一次證據流程的工作，不在本工作包。
- GitHub 端本分支 push 後的實際 CI 結果以 PR Checks 為準，本檔不預先宣稱綠。

## 重現方式
```bash
cd web-ui
python3 -B scripts/enterprise/coordination/check_state.py --require-git
python3 -B scripts/enterprise/coordination/test_check_state.py --require-git
python3 -B scripts/enterprise/uat_evidence_index.py --check
python3 -B scripts/enterprise/render_roadmap.py --check
```
