# Harness project instructions

For Codex work on this harness, read `rules/CODEX-AGENTS.md` before substantial changes. It is the source for the installed global Codex AGENTS policy; preserve the existing baseline rules. Then read `.astra/PROJECT_STATE.md` and `.astra/TODO.md`, plus `.astra/HANDOFF.md` on recovery. Retrieve architecture and decisions only when relevant.

This is the harness project root, currently without Git metadata. Keep this project's memory here; future application projects own their own `.astra` state. The portable `memory/MEMORY.md` remains a reference policy, not live state. Use the source pointer and manifest to resolve installation paths instead of assuming the shell's current directory is the harness root.

Codex policy source: `rules/CODEX-AGENTS.md`. Claude policy sources remain `rules/AGENTS.md`, `rules/CLAUDE.md`, and `rules/MIDOFFICE.md`. Sync only the requested platform and run the matching drift check; use `-SkipSkills` for rules-only changes. Local `~/.codex/config.toml` is machine configuration, not a portable model capability promise.
