---
name: codex-verifier
description: Ask Codex for an independent adversarial review when security, financial or numeric logic, DB/schema migrations, releases, deployment, or a subtle bug needs evidence-backed verification. Do not use for routine low-risk edits or sensitive company data.
allowed-tools: Bash Read
disable-model-invocation: true
---

# Codex Verifier

Invoke the PowerShell broker with `-Role verifier`. Provide the claim to challenge, exact artifacts, acceptance criteria, and known exclusions; do not give it the intended verdict. Ask for ranked findings with file:line evidence and an explicit unverified list.

Treat failed or partial review as a coverage gap. Claude decides the final outcome after checking the evidence.

Never send secrets, credentials, customer/order/position/flow data, or company DB row values.

```powershell
& "$env:USERPROFILE\.claude\skills\codex-bridge\scripts\run_codex_subagent.ps1" -Role verifier -Prompt "<claim and evidence scope>" -Cwd (Get-Location).Path
```
