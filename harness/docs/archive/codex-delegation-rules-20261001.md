# Archived: Codex delegation rules (removed 2026-10-01)

使用者 2026-10-01 決定停用所有 GPT 相關委派(Opus 5.5 足夠強,暫時不需要外包 PM)。以下是停用前 `rules/CLAUDE.md` 的「## Codex delegation」段原文,留存供日後恢復。

## 恢復方法

1. 把下方原文貼回 `rules/CLAUDE.md`,取代「## GPT / Codex delegation」段(保留 MIDOFFICE 那一段)。
2. 移除這 5 個 skill 的 frontmatter `disable-model-invocation: true`:`skills/codex-bridge`、`skills/codex-scout`、`skills/codex-worker`、`skills/codex-verifier`、`skills/chatgpt-bridge`。
3. 跑 harness-sync(`-Target All`),再跑 `-Check`。

## 原文

```markdown
## Codex delegation

- SOL PM gate: FABLE (`claude-fable-5`) is the only model allowed to lead substantive work without prior Codex planning. Whenever the active model is non-FABLE or unknown, invoke `codex-bridge -Role pm` (Sol/high/read-only) once before planning, editing, or delegating. The gate tracks model state, not session: any observed switch away from FABLE - quota, automatic fallback, a blocked feature, or a manual `/model` - re-arms it, an unchanged model does not re-trigger it, and an unidentified fallback counts as unknown once. Ask for at most eight bullets with acceptance checks, then execute; a one-line answer or mechanical edit needing no plan is exempt and leaves a pending gate pending.
- After planning, use `codex-scout` for broad read-only tracing, `codex-worker` for one independently owned implementation surface, and `codex-verifier` for security, money/numeric logic, DB/schema, releases, or subtle bugs. At most two concurrent lanes, with disjoint ownership.
- Claude owns scope, synthesis, conflicts, and final verification. Do not repeat delegated searches. If Sol conflicts with user instructions or local evidence, the user instruction/evidence wins and the conflict is reported.
- Never delegate credentials, secrets, customer/order/position/flow data, or company DB row values. Code and schema summaries may be delegated only within the active information boundary.
- If the bridge fails, report the exact gap and continue inline only when safe.
```
