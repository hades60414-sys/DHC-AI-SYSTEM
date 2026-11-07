# HANDOFF_TO_CLAUDE — AUDIT-STATE-D04/D05（fix/ai-office-state-freshness）

- base_sha：`38c7293d3764f61a967b2bd2e90526e218b77793`（PR #14 固定快照，未動）
- head_sha：本分支 HEAD（handoff 文件 commit 之後）
- 分支：`fix/ai-office-state-freshness`（建立於 38c7293；未碰 main、未改 PR #14～#14 內容）
- PR：Draft（base = `fix/ai-office-v53-closure`）

## 固定點（恢復用）
1. PR #14 維持 `38c7293`；本分支不覆蓋 PR #14 的歷史基線。
2. 三個 HEAD 對照（整合前必讀）：
   - PR #14 HEAD：`38c7293d3764f61a967b2bd2e90526e218b77793`
   - DSH（Builder A）DR-E02B 分支 HEAD：待產生（.github/workflows/enterprise-pgdr-evidence.yml；未見 PR 時保持 PENDING，不臆測）
   - 本分支 HEAD：見 `git rev-parse HEAD`
3. 本分支產物：D04 完整 closure_class 機械推導＋D05 Checker 輸入新鮮度閘門＋UAT 索引 current_evidence 連結；證據已標 pending_rerun、`ci_status=CI_PENDING`。
4. Astra 複驗通過前不可合流、不可移除 pending_rerun、不可宣稱 AUDIT_VERIFIED／RELEASE GO。

## 整合順序建議（供 Claude 接手）
1. 讀 DSH 的 `HANDOFF_TO_CLAUDE.md`＋本檔＋`OWNERSHIP_MANIFEST.json`；核對 SHA／Files／CI／Ownership（本分支檔案僅 handoff 允許的範圍）。
2. 僅整合 D04/D05（本 PR）與 DSH 已通過 Astra 複驗的 DR PR；不得在同一 PR 覆寫或重建 V5.3.1 已 PASS 的證據。
3. 合流後：以最新 main/合流 SHA 重跑 enterprise-verify（含 coordination gate）、image-build、repo-coverage、office-e2e、negative-gate；5 項證據綠了才允許移除 pending_rerun 並將 ci_status 恢復 CI_EVIDENCE_READY（由 CI/Builder 流程執行，非手動改 STATE 宣稱）。
4. 更新 STATE 的 Auditor Intake 時保留原始外部審核 hash 與「未簽章」限制；不可讓 Builder 代改 Verdict。
5. 無獨立簽章前維持 AUDITOR_TRUST_ROOT_PENDING；全部工程測試通過也不得宣告 COMMERCIAL_RELEASE_NO_GO 解除。

## 注意事項
- 本分支 `test_check_state.py` 以 clone 實測 D05（roadmap／UAT Index 變更→拒絕）；合流後若重跑證據綠、移除 pending，需重新確認 clone 案例仍有效（pending 清掉後 staleness 才會觸發，測試已內建 `clear_pending_rerun`）。
- `.github/workflows/enterprise-verify.yml` 中 coordination gate 的步驟未改；本分支對 verify 的影響僅限 `web-ui/scripts/enterprise/coordination/*.py`（gate 入口不變）。
- 若 Astra 要求修改 PINNED_PR14_HEAD 或 CHECKER_INPUTS，交回本分支（或由 Claude 開新整合分支），兩人不得直接在整合分支改。

## Next Command（Claude）
```bash
git fetch origin fix/ai-office-state-freshness fix/ai-office-v53-closure fix/ai-office-dr-evidence
gh pr view <本 PR 編號> --json headRefOid,statusCheckRollup,reviews
cat web-ui/docs/enterprise/handoff/d04-d05/HANDOFF_TO_ASTRA.md
```
