# Next Session Handoff — V5.3

- Repo：hades60414-sys/DHC-AI-SYSTEM（public）
- 分支：`fix/ai-office-v53-closure`（PR #14 Draft）
- 證據分支：`ci-evidence/v53-closure`，與 PR 同 SHA，只用來觸發隔離的證據 workflow
- 狀態：BUILDER_SUBMITTED / CI_EVIDENCE_READY / ASTRA_REAUDIT_PENDING

## 狀態怎麼更新（沒有背景輪詢）
```bash
cd web-ui
python3 -B scripts/enterprise/coordination/build_state.py --product-sha <產品 SHA> --head-sha <CI 驗證 SHA> --base-sha 601dbb3ee1d75f94ce75947af6e1cb2eea17661c \
  --ci "enterprise_verify=<run>:<attempt>:<artifact>,image_build=…,repo_coverage=…,negative_gate_evidence=…,office_e2e_evidence=…"
python3 -B scripts/enterprise/coordination/check_state.py
python3 -B scripts/enterprise/render_roadmap.py --check
```
收到 Astra 收據時：依 `coordination/AUDIT_INTAKE.md` 只抄錄到 `AUDITOR_SNAPSHOT.json`，再重新產生狀態。

## 證據 workflow 怎麼重跑
把同一個 SHA push 到 `ci-evidence/<名稱>`，或用 workflow_dispatch。

- `negative-gate-evidence`：整體 conclusion 是 failure，這是設計上的預期；請看 collect job 與 `NEGATIVE_GATE_EVIDENCE.json` 的 `all_match`。
- PR branch 的 concurrency 設定是 cancel-in-progress：CI 還在跑時不要 push，否則會取消正在進行的 run。

## 禁止事項
- 不改 #10～#13
- 不 Force Push、不 Merge、不 Release、不部署客戶環境
- 不直接修改 remote-agent／DeID
- 不啟動或清理本機 QA VM
- Builder 不得標 AUDIT_VERIFIED
