---
name: harness-sync
description: Synchronize the shared agent harness to both Claude Code and Codex, check drift, or update shared skills. Use when the user says sync harness, keep CC and Codex aligned, install harness skills for both agents, or asks why their harness copies differ.
argument-hint: "[sync|check] [all|claude|codex]"
---

# Harness Sync

Use the installed wrapper so both agents resolve the same source-of-truth path.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-sync.ps1 -Target All
```

For a read-only drift check:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-sync.ps1 -Target All -Check
```

Rules:

- The source manifest classifies every skill as shared, Claude-only, or Codex-only.
- Never copy `CLAUDE.md` into Codex. Codex receives `AGENTS.md`; Claude receives its import wrapper.
- Preserve `~/.claude/CLAUDE.local.md`. Machine-specific handoffs belong there.
- Unknown target skills are never pruned. Managed skill directories are backed up before replacement.
- Run `-Check` after sync and report the exact drift or failure.
