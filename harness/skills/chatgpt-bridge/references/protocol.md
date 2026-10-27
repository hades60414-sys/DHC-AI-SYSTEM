# Bridge protocol formats

Adapted from upstream `references/router-policy.md` (Codex renamed to Claude Code). Read the upstream file for the full rationale; these are the shapes Claude Code writes and reads.

## Task Packet (Claude Code to ChatGPT), `docs/chatgpt/packets/<task-id>.md`

```markdown
# ChatGPT Task Packet
## Task ID
<task-id>
## Route
CHATGPT_LOCAL_READ | CHATGPT_REASONING | CHATGPT_PLAN | CHATGPT_VISION
## Permission Level
L0_NO_TOOL | L1_READ_ONLY | L2_DIAGNOSTIC_COMMANDS
## Goal
<one sentence>
## Background
<minimal context; what Claude Code already knows or tried>
## Workspace
<absolute project path inside the allowed root>
## What to inspect
- <paths / categories>
## What not to inspect
- secrets, auth files, .env, anything outside the workspace
## Allowed actions
- list/read/search inside the workspace
- <L2 only: rg, git status, git diff --stat, test discovery>
- write exactly one file: docs/chatgpt/manifests/<task-id>.md
## Tool budget
- Maximum bridge tool calls: <3-8>
- Stop condition: evidence gathered, or one failed/repeated call, then write the manifest
## Forbidden actions
- edit or create any other file, delete, format, install, commit/push, leave the workspace
## Exact request to ChatGPT
<precise question or planning request>
## Required output
Write the Action Manifest (format below) to docs/chatgpt/manifests/<task-id>.md, then reply in chat with one line: "manifest written".
```

## Action Manifest (ChatGPT to Claude Code), `docs/chatgpt/manifests/<task-id>.md`

```markdown
# ChatGPT Action Manifest
## Final Verdict
<go | no-go | needs-more-evidence>
## Evidence Inspected
- <file / command>
## Must-Fix Issues
1. <issue> : Evidence / Risk / Recommended Claude Code action / Verification
## Should-Fix Issues
1. <same shape>
## Acceptable Risks
- <risk and rationale>
## Missing Evidence
- <exact gap>
## Recommended Claude Code Actions
1. <ready-to-apply: exact path, unified diff or full file, exact command>
## Suggested Verification Commands
<commands, one per line>
## Permission Escalation Requests
None. | Requested level / exact action / reason / risk / rollback / fallback
```

## Execution Prompt (ChatGPT to Claude Code, CHATGPT_ARCHITECT), one per task

```markdown
# Claude Code Execution Prompt
## Task ID
<project-taskN>
## Single Goal
<one outcome; if it needs "and", split>
## Context / Spec
<only the slice this task needs>
## Files In Scope
- <paths>
## Out Of Scope
- <paths / features for later tasks>
## Constraints
- <language, style, deps, perf>
## Acceptance Criteria
- <observable, checkable>
## Verification Commands
- <commands; Claude Code may add or replace>
## Done Means
- diff applied, listed checks pass locally, compact result reported
```

Claude Code's reply per task stays compact: files changed, commands run with pass/fail, deviations, whether acceptance criteria pass. Failures are reported, never declared done.

## Architect loop

1. Frame (user): direction, hard constraints, approval gates.
2. Plan (ChatGPT, `CHATGPT_PLAN`, `L1`): spec, design, ordered small tasks, Execution Prompt for task 1. Written to `docs/chatgpt/manifests/<project>-plan.md`.
3. Feasibility (Claude Code): paths exist, APIs real, dependency order sane. Defects go back to ChatGPT before code.
4. Per task: ChatGPT prompt, Claude Code executes and tests, compact result written to `docs/chatgpt/results/<task-id>.md`, ChatGPT reviews (reads the result file over the bridge), accept or fix prompt.
5. Gate (user): L4/L5, releases, pushes, any write scope not granted.

Keep one ChatGPT thread per project so it retains repo context; send deltas, never full re-reads.
