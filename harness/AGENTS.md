# Harness project instructions

For Codex work on this harness, read `rules/CODEX-AGENTS.md` before substantial changes. It is the source for the installed global Codex AGENTS policy; preserve the existing baseline rules. Then read `.astra/PROJECT_STATE.md` and `.astra/TODO.md`, plus `.astra/HANDOFF.md` on recovery. Retrieve architecture and decisions only when relevant.

This harness lives inside the DAS Git repository. Resolve its actual root with Git and keep project state in that root's `.astra` directory; initialize it if absent. The portable `memory/MEMORY.md` is an empty template, not the source team's private memory. Use the source pointer and manifest to resolve installation paths instead of assuming the shell's current directory is the harness root.

Codex policy source: `rules/CODEX-AGENTS.md`. Claude policy sources remain `rules/AGENTS.md`, `rules/CLAUDE.md`, and `rules/MIDOFFICE.md`. Sync only the requested platform and run the matching drift check; use `-SkipSkills` for rules-only changes. Local `~/.codex/config.toml` is machine configuration, not a portable model capability promise.
