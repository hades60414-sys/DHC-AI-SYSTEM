---
name: chatgpt-bridge
description: Route expensive reasoning to ChatGPT over the DevSpace MCP bridge while Claude Code keeps local execution. Use when a task needs reading many files, codebase mapping, architecture or refactor planning, complex bug analysis, broad review, design tradeoffs, task decomposition, or a long continuous build (CHATGPT_ARCHITECT); also when the user asks to start, stop, check, or rotate the ChatGPT bridge. Do not use for small edits, a one-file lookup, or company/customer data.
allowed-tools: Bash PowerShell Read Write Edit Glob Grep
disable-model-invocation: true
---

# ChatGPT Bridge (Claude Code adapter)

Thin adapter over the upstream `codex-chatgpt-bridge` skill (installed at `%USERPROFILE%\.codex\skills\codex-chatgpt-bridge`) and the unmodified `@waishnav/devspace` MCP server. The upstream skill is written for Codex; read "Codex" there as "Claude Code". This file owns only what differs: the Claude-side routing policy, the file-mailbox transport, and the wrapper script.

Division of labor:

- **ChatGPT** reads the workspace through the bridge and does the thinking: codebase mapping, architecture, planning, task decomposition, bug analysis, review, synthesis. Its output is advice until verified locally.
- **Claude Code** owns edits, file creation, commands, tests, lint, build, git, integration, final verification, and the final claim.
- **Bridge** exposes one narrow root (`C:\Users\demo\DevSpace` by default). Off when idle.

## Lifecycle

Every action goes through the wrapper, which forwards to the upstream controller (`On`/`Off`/`Reboot`/`Status`/`Doctor`/`Configure`) or the upstream runtime (`LowDoctor`, `Rotate`):

```powershell
& "$env:USERPROFILE\.claude\skills\chatgpt-bridge\scripts\bridge.ps1" -Action Status
& "$env:USERPROFILE\.claude\skills\chatgpt-bridge\scripts\bridge.ps1" -Action On
& "$env:USERPROFILE\.claude\skills\chatgpt-bridge\scripts\bridge.ps1" -Action Off
```

Rules, in order of leverage:

1. `Off` when the task is done. A reachable public endpoint you are not using is the main attack surface.
2. `On` only after confirming the saved profile's `projectRoot`/`allowedRoots` match the task (`Status`). Changing roots is `Configure`, and needs the user's explicit root approval first. Roots stay inside `C:\Users\demo\DevSpace`; never a drive, the user profile, Desktop, Documents, `Claude Code專案\某證券`, credential dirs, SSH keys, or browser profiles.
3. Public exposure (`-Tunnel cloudflare` / `cloudflare-worker`), ChatGPT app creation, Developer Mode, OAuth approval, the Owner password, and Cloudflare tokens are the user's actions. Stop and hand them the exact step; never read or print `auth.json`.
4. Suspected foreign connection: `Rotate`, then tell the user to re-authorize.

## Routing

Default mode is `TOKEN_SAVING`. Route by marginal cost: one dense ChatGPT turn over a big input is the high-leverage handoff; many small mechanical ops stay local.

| Send to ChatGPT | Keep in Claude Code |
|---|---|
| reading >5 files or long logs, codebase mapping | precise reads of the files you will edit |
| architecture, implementation plan, refactor strategy | edit / create files |
| complex bug hypotheses, design tradeoffs, multi-option comparison | run commands, tests, lint, build |
| broad review, documentation synthesis, task decomposition | git diff / status, integration, final verification |

Skip the bridge when the task is a few short files or one deterministic edit: do it directly.

`CHATGPT_ARCHITECT` mode for long builds: ChatGPT owns spec, architecture, ordered tasks, one Execution Prompt per task, and review of each result; Claude Code runs one task per turn (implement, test, compact report) and feasibility-checks the plan against the real repo before task 1. Advice profile by default (Claude writes all source). ChatGPT source writes (`L3` independent-agent profile) only on an explicit user grant.

Permission ladder (policy, not a sandbox; `run_shell` is not root-scoped): default `L1_READ_ONLY`; `L2_DIAGNOSTIC_COMMANDS` for `rg`/`git status`/`git diff --stat`/test discovery; `L3` report-only writes under the project's `docs/chatgpt/manifests/` are pre-approved because that is how answers come back; anything else at `L3`+ is `ROUTE_HUMAN_APPROVAL`.

## Handoff protocol (file mailbox)

Both directions travel as files inside the exposed root, so no large text crosses the chat UI and no page scraping is needed:

1. **Packet**: write `docs/chatgpt/packets/<task-id>.md` in the project using the Task Packet format in `references/protocol.md`. Paths and goals, not file bodies. Include a tool budget (3 to 8 calls) and the required manifest path.
2. **Kick-off**: one line to ChatGPT, in the per-project ChatGPT thread: `Open <project path> via the bridge, read docs/chatgpt/packets/<task-id>.md, do exactly that, and write the Action Manifest to docs/chatgpt/manifests/<task-id>.md.` Deliver it through Claude in Chrome when available (tab on chatgpt.com), otherwise give the user the line to paste.
3. **Await**: `bridge.ps1 -Action Await -Path <manifest path> -TimeoutSec 600` blocks until the file exists and is stable.
4. **Ingest**: read only the manifest. Classify each item accepted / rejected / needs verification / user decision. Apply accepted items locally, run the verification commands, report files changed plus results. Local evidence beats ChatGPT's verdict.

If ChatGPT loops on tools or returns no manifest, send: `Stop calling tools. Write the Action Manifest now from the evidence you have; put gaps under Missing Evidence.` One retry, then fall back to planning locally.

## Completion checklist

- Bridge state known and `Off` unless the user asked to keep it up.
- Roots narrow, no secrets exposed, permission level stated in every packet.
- Every applied ChatGPT recommendation verified locally before the final claim.
