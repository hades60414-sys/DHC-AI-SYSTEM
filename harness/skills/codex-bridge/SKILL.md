---
name: codex-bridge
description: Route substantive work from any non-FABLE Claude session to Sol as planning lead, or diagnose the local Claude Code-to-Codex bridge. Use before planning when the active model is not explicitly claude-fable-5 or is unknown, when a Codex delegation fails, or when the user asks to test the bridge. Scout, worker, and verifier lanes use their dedicated skills.
allowed-tools: Bash Read
disable-model-invocation: true
---

# Codex Bridge

Run Codex through `scripts/run_codex_subagent.ps1`. This PowerShell broker is required on this machine because EndpointGuard kills long-running `python.exe`, and the WindowsApps `codex.exe` alias may be non-executable.

The broker resolves the real desktop CLI, enforces a timeout, uses ephemeral Codex sessions, and returns one compact JSON object. Roles:

- `scout`: Luna/medium/read-only.
- `worker`: Terra/high/workspace-write with reviewed approvals.
- `verifier`: Sol/high/read-only.
- `pm`: Sol/high/read-only. Mandatory planning lead for substantive work when Claude is not explicitly FABLE (`claude-fable-5`) or the model is unknown; returns at most eight ordered bullets with acceptance checks. Tracks model state, not session: a mid-session switch away from FABLE (quota, fallback, blocked feature, manual `/model`) re-arms it.

`-Effort low|medium|high|xhigh|max|ultra` overrides the role default for one call; `-ServiceTier default|priority` sets the speed tier. Both are passed explicitly to Codex, so a later `config.toml` change cannot silently alter bridge behavior. `priority` is roughly 1.5x speed at increased usage, so it stays opt-in per call and never a default. Luna has no `ultra`; asking for it fails with exit code 2 instead of silently downgrading.

Pass a narrow prompt containing outcome, scope, evidence, and stop condition. Never include credentials, secrets, customer/order/position/flow data, or company DB row values.

Example:

```powershell
& "$env:USERPROFILE\.claude\skills\codex-bridge\scripts\run_codex_subagent.ps1" `
  -Role scout -Prompt "Trace X across the repository; return file:line evidence; do not edit." `
  -Cwd (Get-Location).Path
```

Use `-ResolveOnly` for a zero-network diagnostic. Treat `status=error` or `status=timeout` as a real coverage gap; do not silently claim delegation happened.
