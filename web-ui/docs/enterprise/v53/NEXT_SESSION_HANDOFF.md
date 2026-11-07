# 下一個 Session 交接 — V5.3.1

- Repo：hades60414-sys/DHC-AI-SYSTEM（public）
- 分支：`fix/ai-office-v53-closure`（PR #14，Draft）
- 證據分支：`ci-evidence/v53-closure`，停在 c2ae88b
- 入口：`FINAL_CLOSURE_REPORT.md`
- 恢復點：`CLOSURE_CHECKPOINT.md`

## 開工前
```bash
gh pr view 14 -R hades60414-sys/DHC-AI-SYSTEM --json headRefOid,isDraft
cd web-ui
python3 -B scripts/enterprise/coordination/check_state.py --require-git
```

## 規則
- 程式 commit 要和重產後的 STATE commit 一起 push。只推程式 commit，CI 的協作狀態閘門會擋下（run 42348453024 已實證）。
- 改了證據依賴的路徑，就要重跑該證據（push 到 `ci-evidence/**`），再更新 `coordination/EVIDENCE_SOURCES.json`。
- 收到 Astra 報告：
  1. 用 `sync_auditor_snapshot.py` 抄錄。
  2. 更新 `check_state.py` 的 `PINNED_AUDITOR_REPORTS`。
  3. 執行 `build_state.py`。
- PR 分支的 workflow concurrency 設定是 cancel-in-progress。CI 還在跑時，不要再 push 同一分支。

## 禁止事項
- 不改 #10～#13
- 不 Force Push、不 Merge、不 Release、不部署
- 不改 remote-agent／DeID
- 不碰本機 QA VM
- Builder 不得標 AUDIT_VERIFIED
