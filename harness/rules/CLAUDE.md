# CLAUDE.md

@AGENTS.md
@CLAUDE.local.md

<!-- 核心規則單一來源在 AGENTS.md；中台紅線按任務讀 MIDOFFICE.md，避免無關 session 常駐載入。
     非 Claude Code 工具(如 Grok/Codex)不吃 @import,直接讀 rules/ 下各檔。
     本機專屬狀態只寫 ~/.claude/CLAUDE.local.md；同步器保留它，不回寫可攜包。 -->

## GPT / Codex delegation

- Off since 2026-10-01 (user decision: Opus 5.5 leads planning and execution). Do not route planning, research, implementation, or review to any GPT model; `codex-bridge`, `codex-scout`, `codex-worker`, `codex-verifier`, and `chatgpt-bridge` are disabled. Independent checks use Claude subagents (`verifier`, `scout`) or local tools. The previous rules are archived in the harness package at `docs/archive/codex-delegation-rules-20261001.md`; restore them only when the user asks.

For market data, positions, P&L, risk, company databases, or backtests, read `MIDOFFICE.md` and the matching company/domain skill before acting. Skip them for unrelated work.

## Communication

- Respond in Traditional Chinese by default; if the user writes in another language, follow the user's language. Keep technical terms, commands, and code in their original form.
- Lead with the conclusion / recommendation, then details.
- Resident style = caveman lite: concise full sentences, answer first, number multi-step work, and use one checkpoint line only during long work. Deeper caveman levels or `i-have-adhd` formatting require explicit invocation. Persisted text stays normal prose.

## Safety red lines

- Don't modify money/data logic (calculations, order placement, DB schema) without my OK; UI/presentation tweaks are fine.
- Scan any third-party tool (skill / plugin / MCP / package) before installing - use scan-before-install.
- Irreversible/outward actions (deleting data, payments, permission changes, sending messages) - ask me first.

## pstack workflow

- Complex system work goes through the `pstack` plugin: building or substantially changing a multi-component architecture (RAG, agent/LLM pipelines, multi-service or cross-machine deployments, multi-stage data pipelines), or a bug or perf issue of unknown cause in one. Invoke `pstack:poteto-mode`, name the chosen playbook in one line, and follow it. Contained edits, one-file scripts, questions, and routine data/report work stay on the normal flow.
- For agent or RAG designs, use `agent-patterns` as the pattern catalog inside pstack's design step. Prove behavior on the real running system before reporting done; if a system has no scripted way to do that, create one with `pstack:create-verification-skill`.
- pstack never overrides this file, `AGENTS.md`, or `MIDOFFICE.md`. Its "use any MCP tool", "external actions without asking", and "never block on the human" rules do not cover the Safety red lines above; git push, opening PRs, and messages sent through MCP tools count as outward actions. Replies follow Communication, not pstack's reply-style rules. Skip PR/CI/merge steps with a reason when the project has no git repo.
- Models and hook live in `pstack-models.md` (managed by the harness package): no Fable in automatic roles, panels run opus + sonnet, and the plugin's own SessionStart hook is off because this section does the routing.

@pstack-models.md
