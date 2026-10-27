---
name: codex-worker
description: Delegate one independently ownable implementation or test surface to Codex for a non-trivial change with clear file ownership and acceptance checks. Do not use for tiny edits, sequential work, overlapping writes, or sensitive company data.
allowed-tools: Bash Read
disable-model-invocation: true
---

# Codex Worker

Invoke the PowerShell broker with `-Role worker`. State the exact owned files/surface, non-goals, acceptance checks, and stop condition. Default to one worker. Parallel workers require disjoint files and a stable shared contract.

Claude remains responsible for reviewing the diff, resolving conflicts, and running the final centralized verification. A successful broker response is not proof that the repository is correct.

Never send secrets, credentials, customer/order/position/flow data, or company DB row values.

```powershell
& "$env:USERPROFILE\.claude\skills\codex-bridge\scripts\run_codex_subagent.ps1" -Role worker -Prompt "<bounded task>" -Cwd (Get-Location).Path
```
