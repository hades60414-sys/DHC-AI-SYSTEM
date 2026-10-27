---
name: codex-scout
description: Delegate broad read-only repository reconnaissance to Codex when tracing behavior across 3+ files, comparing multiple configs, locating dispersed usages, or testing competing hypotheses. Do not use for a one-file lookup or sensitive company data.
allowed-tools: Bash Read
disable-model-invocation: true
---

# Codex Scout

Invoke the PowerShell broker with `-Role scout`. Give it one bounded question, the search scope, the required `file:line` evidence, and a stop condition. Do not duplicate its search while it runs.

Default to one run. Two concurrent scouts are allowed only for genuinely independent hypotheses. Claude must synthesize the returned JSON `result` and verify any load-bearing claim before acting.

Never send secrets, credentials, customer/order/position/flow data, or company DB row values.

```powershell
& "$env:USERPROFILE\.claude\skills\codex-bridge\scripts\run_codex_subagent.ps1" -Role scout -Prompt "<bounded task>" -Cwd (Get-Location).Path
```
