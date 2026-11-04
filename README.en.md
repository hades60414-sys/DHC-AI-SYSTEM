# DAS (DHC AI System) V3 — A Shared AI Agent Workspace for Teams

> English translation of [README.md](README.md). The Chinese original is authoritative. Terminology: [docs/GLOSSARY.md](docs/GLOSSARY.md).

DAS grew out of the full set of practices a middle-office team at a securities firm uses to run Claude Code on one shared host (internal codename TAS): behaviour rules, skills, subagents, safety guardrails, services around the web version, a remote agent, and everyday utilities. This repo is the version with company information removed, for cross-department reference and collaboration.

> Compared with V2, V3 adds approval tickets, secure input, a Codex de-identification proxy, Gemini takeover, conversation search, distillation-mode evaluation and other tools (see `tools/`). **V3.1 (2026-11-03)** aligns the harness with the state of the internal TAS on that day: `install-hooks.cjs` registers the same 18 hooks as the original host (new: turn budget, turn-end guard, REA reminder, maintenance drain, timed keep-going, prompt-injection warning, and more). It also adds prompt-injection defence (`prompt-injection/`), grant / resume / wake-up for approval tickets, project-level Claude↔Codex rule sync (`rulesync/`), and weekly decision-load metrics (`metrics/`).

> Name mapping: in these documents "a securities firm", "a financial group", `DHC`, `EKB` (enterprise knowledge base), host codes such as `srv-db` / `srv-rag`, and `userA`–`userG` / "Colleague A"–"Colleague G" are all substituted placeholders. IPs are always in the fake `10.255.0.x` subnet and emails use `example.*` domains.

## Contents

**2026-11-04 update:** [Autonomy distillation](docs/AUTONOMY.en.md) is now part of both rule sets. Hooks now read a local `das-hooks.json`, and the Codex-only checks no longer wrongly inspect Claude. Gemini automatic hand-back is now an optional install, with a blank allowlist template for what it needs. For the full scan scope, findings and limitations, see the [Package Audit report](docs/PACKAGE_AUDIT.en.md).

| Folder | What it is | For whom | Entry point |
|---|---|---|---|
| `harness/` | Rules (CLAUDE.md / AGENTS.md), about 50 skills (overview in [SKILLS.md](SKILLS.md)), 9 subagents, hooks, the `dhc-guard` dangerous-command interception mod, sync and health-check scripts | Everyone | [harness/README.md](harness/README.md) |
| `web-ops/` | Resident services and scheduled operations (`cc-hosts/`) that run alongside the web version (DHC CLI): de-identifying model proxy, seal-proxy gate, Cloudflare Worker, guardrails / reminders / memory tidy-up for the team assistant, auto-resume after hitting usage limits, restart only when idle | People who run the shared host | Header comment of each file |
| `remote-agent/` | Remote agent: the controller sends "signed and encrypted" jobs through a public mailbox to an intranet host, and the agent only performs allowlisted actions (read-only SQL, document Q&A, restricted CMD, migration sandbox); includes an MCP server | Advanced: remote operation across network segments | [remote-agent/README.md](remote-agent/README.md) |
| `local-model/` | Install and test scripts for an offline local model (llama.cpp server) | People with a GPU who want to run models offline | [local-model/DELIVERY.md](local-model/DELIVERY.md) |
| `tools/` | Action gate (let a proposed action through or stop it), local document Q&A and evaluation, intranet web test sandbox, document scanning, reminders, third-party skill update check, skill usage statistics, project memory template. New in V3: remote-action approval tickets (`approvals/`), one-time link for entering credentials (`secure-input/`), de-identification proxy before sending to Codex (`codex-deid/`), Gemini takeover when usage limits are hit (`gemini-takeover/`), cloud offload (`cloud-offload/`), full-text search and summary cards over past conversations (`conversation-search/`), distillation-mode evaluation (`distill-eval/`), NotebookLM browser automation (`nblm/`). New in V3.1: prompt-injection warning (`prompt-injection/`), rule sync (`rulesync/`), decision-load metrics (`metrics/`) | Pick what you need | README in each folder |
| `migration/` | Host migration tools: encrypted, chunked packaging, path rewriting, a Cloudflare Worker for migration | Advanced: host migration | Header comment of each file |
| `web-ui/` | Web version of DHC CLI (modified CloudCLI: multi-user chat room, planning whiteboard, stopping also stops subagents, de-identification layer hook-in); AGPL-3.0, license file inside the folder | Teams that want to drive Claude Code from a browser | [web-ui/README.md](web-ui/README.md) |
| `vendor/` | Third-party plugins included as-is: pstack, ctx-handoff (MIT), frontend-design (Apache-2.0); license files in each folder | People who want the complete workflow | [SKILLS.md](SKILLS.md) |
| `scripts/` | `scan-sensitive.mjs`: sensitive-term scan before uploading | Everyone, before sharing | See below |

The web version itself (a fork of CloudCLI, AGPL-3.0) has its own repo, "DHC CLI"; this repo also includes a snapshot in `web-ui/`, and `web-ops/` holds the services around it.

## How to use it

> [!TIP]
> **First time? Just pick one path:**
> - **Let the AI install it for you (easiest):** open Claude Code in this folder and paste the whole of [SETUP_PROMPT.en.md](SETUP_PROMPT.en.md). It first asks what you want to use it for, shows you which files it will change, only acts after you agree, and teaches you how to restore.
> - **Just want to try a few skills:** use [SKILLS.md](SKILLS.md) to pick by job; copying a single folder is enough and does not touch your existing setup.
> - **Install step by step yourself:** read the [Installation Guide](安裝說明.en.md).

1. **Just borrow the rules and skills:** read [harness/README.md](harness/README.md), run `harness\ops\sync-harness.ps1 -Target All` on Windows, then run `harness\ops\healthcheck.ps1` and check for `RESULT: OK`. New Claude Code sessions load it automatically.
2. **Understand the design:** start with [ARCHITECTURE.md](ARCHITECTURE.md), then read the header comments of the components that interest you; every script starts with its purpose and limitations.
3. **Move it to your own environment:** paths in the code (`D:\TAS\...`, `C:\Users\demo\...`), host codes and IPs all need to be replaced with real values. Most scripts are Windows + Node.js; PowerShell scripts target Windows PowerShell 5.1.

Not included: the Claude Code executable, model weights, any keys or tokens, conversation logs and memory, database contents, internal company documents.

## Check before uploading

```bash
node scripts/scan-sensitive.mjs
```

Built-in rules look for user paths, private IPs, host codes of the form "dot + two or three digits", emails, and strings that look like keys. Organisation-specific terms go in a JSON file outside the repo, pointed to by the environment variable `SCAN_SENSITIVE_TERMS` (format in `scripts/scan-sensitive.example.json`; do not put the list itself in the repo). Upload only when it prints `clean`.

## License

Sources and licenses of third-party content are listed in [THIRD-PARTY.md](THIRD-PARTY.md); MIT-licensed third-party skills keep their original license files in their own folders. `web-ui/` is a modified CloudCLI and stays under AGPL-3.0 (if you run the modified version as a public service you must provide the source); this applies only to that folder. Everything else written in-house is for internal collaboration and reference only; confirm the licensing before distributing it externally.
