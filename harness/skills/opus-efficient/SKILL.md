---
name: opus-efficient
description: Evidence-first, bounded execution for scoped coding tasks. Reduces repeated exploration without weakening correctness checks.
disable-model-invocation: true
argument-hint: "[bounded task and acceptance checks]"
---

# Evidence-first execution

Task: $ARGUMENTS

Preserve the actual model, user authorization, project rules and all existing safety boundaries. This skill does not set a runtime effort value. Verify the actual effort through the host controls; a recommendation is not an applied setting. Start routine work at medium only when the user has selected it. Reserve higher effort for demonstrated complexity or failed lower-effort evaluation, not for every task.

## Work loop

1. Establish the deliverable, relevant invariants and concrete acceptance check. For a small task, at most three short plan steps are enough. This limits plan narration, not necessary reasoning. Do not invent missing safety-critical requirements.
2. Inspect the smallest relevant file ranges or symbols. Prefer an existing precise tool over broad repository dumps. Reuse unchanged evidence. Explain the new information need before repeating a read or search.
3. Implement one evidence-backed approach. Run the narrow reproducer and required regression checks. Broaden the investigation only when a failing check or new evidence justifies it.

Do not start a multi-agent workflow for a small patch. Do not delegate to another model or open another conversation automatically. Do not expand a repair into a redesign, introduce dependencies for convenience, or generate speculative documentation.

If two attempts hit the same failure with no new evidence, stop the loop: produce a bounded diagnosis and the next discriminating test. Request higher effort or human authorization where needed; never silently change runtime settings, models or permissions. A complex task may need more work; express that as a scoped next unit instead of repeating the whole plan.

## Evidence and stopping

A plausible explanation is not a passing test. Record the actual command, exit code and relevant result or artifact path. Never alter frozen tests, gold data, scorers, numerical tolerances, guards or acceptance criteria to make a candidate pass. Missing evidence is UNKNOWN or UNVERIFIED. Budget exhaustion is HOLD, not success.

Stop when the agreed deliverable and required verification are satisfied. Keep the final report to outcome, evidence, unresolved risks and next action. Expand it only when the user requested a report. Do not reveal or reconstruct private chain-of-thought; supply a concise decision/evidence summary.

Before compaction or a task boundary, preserve only current goal, files, hashes where relevant, verified results, unresolved failures and one next action. Keep full logs in approved local artifacts, not repeated in chat.

For DHC CLI / E4B work only, read `references/dhc-safety.md`. Do not load the research report or unrelated skills into every task.
