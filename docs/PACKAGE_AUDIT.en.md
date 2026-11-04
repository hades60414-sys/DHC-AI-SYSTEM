# DAS V3 Packaging and Personal-Data Audit

> English translation of [PACKAGE_AUDIT.md](PACKAGE_AUDIT.md). The Chinese original is authoritative. Terminology: [GLOSSARY.md](GLOSSARY.md). This translation reproduces the audit as written on 2026-11-04; it is not a new audit.

Audit date: 2026-11-04. Baseline: `b2b7ef0`; local and remote main were identical, and V3 / V3.1 had both been released. This round covers specified features and fixes to the public package; it does not re-export the entire original environment.

## Scope and method

- Baseline of 2206 Git entries, 7 reachable commits and 2300 unique historical file versions; scanned the working tree and historical text, including the scanner itself and lock files that the existing scanner used to skip.
- Used the general rules, an organisation-specific list kept outside the repo, and a second de-identification detector; each hit was reviewed in context, and real identifying values are not repeated in this report.
- Inventoried 35 binary image files: local OCR on 33 PNG / JPEG / WebP images, plus OCR after parsing the ICNS and ICO icon containers. SVGs were scanned as text. The images were blocked by an attachment protection layer when sent to the model, so no claim is made that every image was manually reviewed visually; OCR may miss or misread characters.
- Checked the manifest: all 54 skill sources exist; rule, agent and hook entry points all exist. Also traced the installer, health checks, workspace restrictions, external service settings and Git submodule pointers.

## Findings and actions

| Finding | Confidence / impact | Action taken |
|---|---|---|
| The scanner's own user allowlist contained an employee identifier | High / personal data | Removed from the current version, keeping generic example accounts; the identifier is not repeated in the docs |
| An upstream mobile demo screenshot contained a personal home-directory path | High / personal data | Removed the image and its nine embedded references; kept the license and required author attribution |
| The scanner missed macOS / Linux home-directory paths | High / detection gap | Added path checks, and verified that Chinese punctuation and example paths do not cause false positives |
| Autonomy hooks were bound to the original host's workspace and tools paths | High / feature non-functional | Added a local `das-hooks.json` with toolsRoot filled in by the installer; workspace and keep-going features are explicit opt-in, and the maintenance service root is configurable |
| The Gemini hook was registered by default, but its external dependencies and allowlist were incomplete | High / feature non-functional | Made it an optional `--gemini` install with a blank allowlist template; clearly marked the runner, EKB, services and schedules that are not included |
| Codex-only health check wrongly required Claude and the disabled PM bridge | High / false acceptance failure | Checks now follow the install target; the old bridge is checked separately with the optional `-CheckCodexBridge` |
| The approval service and Codex rules pointed to the original host's settings | High / portability | MCP configuration moved to an environment variable and the conversation directory now uses the current user; shared memory is now project-configured and falls back to the project state when unset |
| Submodule settings were still in the included web-ui subdirectory | High / missing pieces on download | Added the correct `.gitmodules` at the Git root; did not download or run the third-party submodule |

Other hits included synthetic ID numbers / phones / names used by the de-identification tests, fake certificates, example IPs, package maintainers' contact details, npm package names, and commit hashes mistaken for phone numbers; these were not treated as real credentials and were not deleted. This audit did not confirm any leak of real, valid passwords or API tokens; suspicious strings were not used to attempt logins.

## Verification

- `node scripts/test-package.cjs`: 26 isolated checks passed, covering install preview, re-running, keeping local configuration, removing hooks, workspace boundaries, the maintenance flag, Codex-only / dual-platform install and health check, and sensitive-path detection.
- `whitelist-unit.cjs`, `grant-unit.cjs`, `conv-unit.cjs` and `keepgoing-unit.cjs` in `tools/approvals/test/` passed, including concurrent use-count decrements and revocation checks.
- `node scripts/scan-sensitive.mjs --summary` passed with the organisation-specific list; syntax of the changed files and `git diff --check` passed.
- Not installed into real user settings, no real remote agent was called, no cloud deployment and no real Gemini hand-back were performed; these services still need integration acceptance in each environment.

> Translator's note: 26 is the count on Windows, where `test-package.cjs` also runs the PowerShell sync / health-check cases. On Linux/macOS those cases are skipped and the script reports 21 checks.

## Historical data and limitations not yet removed

**This cleanup does not erase Git history.** The employee identifier, the original organisation-abbreviation comments and the removed screenshot can still be read from old commits; old tags, existing clones and GitHub caches do not disappear just because of new commits. Rewriting history / force-pushing would affect existing users and was not done this time. Clearing the history requires separately confirming the scope, backups and how collaborators migrate.

Automated rules and OCR cannot prove that no personal data remains, and historical images were not visually reviewed version by version. This report is an audit of the public package's content, configuration and identified personal data; it is not a guarantee that every service works out of the box, nor a complete application security audit.
