# TAS Setup Guide (paste the whole thing into your AI agent)

> English translation of [SETUP_PROMPT.md](SETUP_PROMPT.md). The Chinese original is authoritative. Terminology: [docs/GLOSSARY.md](docs/GLOSSARY.md). Differences from the original: replies default to English, and the agent reads the English versions of the docs first.

> For humans: open Claude Code (or Codex) in the repo folder and paste this entire document. It will first ask what you want to use it for, then tell you which parts of your computer it will change, and only act once you agree. You can say "stop" or "restore" at any time.

---

Please help me install this repo (TAS: the Claude Code working environment of a middle-office team at a securities firm) on my computer. The repo is the current working directory; if it isn't, ask me where it is first.

I may not be an engineer. Please talk to me in plain English, and explain each technical term in one sentence the first time it appears.

## Step 0: Look for yourself first, don't ask me

1. Read `README.en.md`, `安裝說明.en.md` (Installation Guide) and `SKILLS.md` to get a rough idea of what this package contains. If an English file is missing, read the Chinese original (`README.md`, `安裝說明.md`).
2. Check my computer (read-only, change nothing):
   - `node --version` (needs 22 or later), `git --version`, `claude --version` (or `codex --version`)
   - Whether `%USERPROFILE%\.claude\` contains `CLAUDE.md`, `AGENTS.md`, `settings.json`, `skills\`; if so, list the names of the existing skills
3. Tell me the results in three to five lines. If a tool is missing, tell me where to install it from; **do not download or run installers for me**.

## Step 1: Ask about my use case (one question at a time, each with a suggested answer)

1. **What do you want to use it for?**
   - A. I only want to try a few skills (e.g. charts, writing reports, reconciliation checks) without touching my existing setup ← recommended for first-time users
   - B. I want the whole way of working (reply rules, verification habits, subagents, skills)
   - C. I run a shared host for my team and also want to look at the web version, remote agent and local model
   - D. I only want to understand the design for now, no installation
2. **What kind of work do you do?** (decides which skills to recommend) Middle office / risk management / finance, trading, operations, IT, other.
3. **What language and style should replies use?** Default: English, conclusion first, concise. (The original package defaults to Traditional Chinese.)
4. **Install the safety guardrails?** (prevents sending keys or national ID numbers out; dangerous commands only run after I reply `確認執行`, which means "confirm execution") Default: yes.
5. Only if I chose B or C: **Is this computer used by you alone, or shared by several people?**

After asking, restate in one paragraph the use case you understood, and continue only after I confirm.

## Step 2: Show me "what will change" first, and only act once I say yes

Based on my answers, list in a table: which files will be added, which will be overwritten (mark the ones I already had), where backups go, and how to restore. If nothing will be overwritten, say so explicitly.

- **A (trial):** only copy the skill folders I pick into `%USERPROFILE%\.claude\skills\`. From `SKILLS.md`, recommend 3–5 skills for my job category, each with one sentence on how it helps me. If a skill with the same name already exists, ask me first.
- **B / C (full setup):**
  1. First read `harness\rules\CLAUDE.md`, `AGENTS.md` and `MIDOFFICE.md`, pick out the parts that only apply to the original team (e.g. GPT delegation is disabled, the pstack plugin, middle-office red lines), and ask me whether to keep, change or delete each. Edit the copy in the repo, not the copy in `.claude`.
  2. Change the `Communication` section to the language and style I chose (the original says Traditional Chinese; change it if I chose English).
  3. First run `powershell -NoProfile -ExecutionPolicy Bypass -File harness\ops\sync-harness.ps1 -Target Claude -Check` (compare only, no changes) and show me the list of changes.
- **D:** walk me through `ARCHITECTURE.md`, using my own work as examples to explain what each layer does; do not install anything.

## Step 3: Do it

- A: copy the selected folders.
- B / C: run `sync-harness.ps1 -Target Claude` (people who use only Codex use `-Target Codex`); it automatically backs up overwritten files to `%USERPROFILE%\.claude\backups\harness-sync-<timestamp>\`.
- Guardrails: first run `node harness\ops\install-hooks.cjs --check` and show me the preview; once I agree, run `node harness\ops\install-hooks.cjs --guard` (it backs up `settings.json` first and keeps my existing hooks). If I don't want the Traditional Chinese reply check, add `--no-zh`; **if I chose English replies in step 1, add `--no-zh` by default**, otherwise that check will keep asking for replies to be rewritten in Chinese.
- If the rules contain the pstack plugin section: ask me whether to install pstack (explain what it does; it is bundled in the repo under `vendor\pstack`, MIT license). If yes, run `claude plugin marketplace add <repo>\vendor` and then `claude plugin install pstack@dhc-vendor --scope user`; if no, delete the "pstack workflow" section and the `@pstack-models.md` line from `rules\CLAUDE.md`, then sync again.
- C: the web version, remote agent and local model all need extra machines or accounts. First explain what is needed and roughly how long it takes, and ask whether to do it today; if not, add it to the to-do list at the end.

## Step 4: Verify, then teach me how to use it

1. For B / C, run `harness\ops\healthcheck.ps1` with the same `-Target` as the install (Claude, Codex or All); the last line must be `RESULT: OK`. An Ollama INFO line on its own can be ignored; any other failure must be fixed or clearly explained. The old Codex PM bridge is optional; add `-CheckCodexBridge` only if it is configured.
2. If the guardrails are installed, ask me to open a new session and give me the two "Try it out" prompts from step 2 of the Installation Guide (`安裝說明.en.md`) to paste directly, to confirm they get blocked.
3. Based on my job category, give me **3 opening prompts I can copy directly** (e.g. "Turn the daily P&L in this Excel file into a trend chart"), and say which skill each one uses.
4. Finally, in five lines or fewer, tell me: what was installed, where the backups are, how to restore (one command or steps), and what is still left to do.

## Rules

- Ask one question at a time; every question comes with a suggested answer, and if I say "go with the suggestion" use the suggested value.
- Back up any existing file on my computer before changing it, and tell me where the backup is.
- Never write passwords, tokens or keys into any file or the conversation; when one is needed, ask me to store it myself as an environment variable with `setx`.
- Do not push, do not send anything externally, and do not install third-party packages or plugins outside this repo (ask me first, and explain the source).
- When I say "stop" (先停), stop; when I say "restore" (還原), uninstall following step 6 of the Installation Guide (`安裝說明.en.md`), then confirm the result of the restore.
