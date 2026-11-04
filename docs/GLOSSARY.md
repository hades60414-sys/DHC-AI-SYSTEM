# Glossary / 術語對照表

This glossary fixes the English wording used in the `*.en.md` translations so the same Chinese term is always rendered the same way. The Chinese files remain the source of truth; when the two disagree, follow the Chinese original and fix the translation.

本表固定 `*.en.md` 英文版的用詞，同一個中文術語只對應一種英文寫法。中文檔為準；兩者不一致時以中文原文為準，再修正英文版。

English translations covered: [README.en.md](../README.en.md), [安裝說明.en.md](../安裝說明.en.md) (Installation Guide), [SETUP_PROMPT.en.md](../SETUP_PROMPT.en.md), [docs/AUTONOMY.en.md](AUTONOMY.en.md), [docs/PACKAGE_AUDIT.en.md](PACKAGE_AUDIT.en.md).

## Conventions / 翻譯慣例

- **Code, paths, commands, file names, flags and config keys are never translated** (`sync-harness.ps1`, `--guard`, `das-hooks.json`, `keepgoingEnabled`, `RESULT: OK`).
- **Literal strings that tools match on stay in Chinese.** The confirmation phrase `確認執行` is compared character-for-character by `dhc-guard` (`harness/mods/dhc-guard/hooks/rules.js`, `CONFIRM_WORD`), so the English docs quote it verbatim and add a gloss: `確認執行` ("confirm execution").
- **Placeholders stay as they are** (`srv-db`, `userA`, `10.255.0.x`, `D:\TAS\...`); see [Placeholders](#placeholders--代稱).
- Links in English docs point to the `.en.md` version when one exists, otherwise to the Chinese original (for example `SKILLS.md`, `ARCHITECTURE.md`, `harness/README.md`).
- "Traditional Chinese" for 繁體中文／繁中; "Windows PowerShell 5.1" as written.

## Project and product names / 專案與產品名稱

| 中文 | English | Notes |
|---|---|---|
| DAS（DHC AI System） | DAS (DHC AI System) | This repo, the de-identified public package |
| TAS | TAS | Internal codename of the original environment; not translated |
| DHC CLI／網頁版 | DHC CLI / the web version | Web front end for Claude Code (CloudCLI fork, AGPL-3.0) |
| EKB（企業知識庫） | EKB (enterprise knowledge base) | |
| 某證券 | a securities firm | Anonymised organisation name |
| 某金融集團 | a financial group | Anonymised organisation name |
| 中台 | middle office | e.g. 中台團隊 → middle-office team |
| 風控 | risk management | |
| 作業 | operations | Job category in SETUP_PROMPT |

## Core concepts / 核心概念

| 中文 | English | Notes |
|---|---|---|
| harness | harness | Rules + skills + subagents + hooks bundle; not translated |
| 規則 | rules | `CLAUDE.md`, `AGENTS.md`, `MIDOFFICE.md` |
| skill | skill | Not translated |
| 子代理 | subagent | |
| hook | hook | |
| 外掛 | plugin | |
| mod | mod | e.g. `dhc-guard` mod |
| session | session | |
| 安全護欄／護欄 | safety guardrails / guardrails | |
| 危險指令攔截 | dangerous-command interception | `dhc-guard` |
| 同步 | sync | `sync-harness.ps1` |
| 健康檢查 | health check | `healthcheck.ps1` |
| 預覽／只比對、不改 | preview / dry run (compare only, no changes) | `-Check`, `--check` |
| 備份 | backup | |
| 還原 | restore | |
| 解除安裝 | uninstall | |
| 白名單 | allowlist | |
| 去識別 | de-identification (adj. de-identified, de-identifying) | |
| 去識別模型代理 | de-identifying model proxy | `web-ops/` |
| 去識別層接口 | de-identification layer hook-in | `web-ui/` |
| 敏感字掃描 | sensitive-term scan | `scan-sensitive.mjs` |
| 個資 | personal data | |
| 代稱 | placeholder | |
| 假網段／假 IP | fake subnet / fake IP | |
| 對外傳資料 | outbound data transfer (egress) | `egress-log` |
| 授權 | authorization (permission) **or** license | Context decides: 使用者已授權 → authorized by the user; AGPL 授權 → license |
| 驗收（條件） | acceptance (criteria) | |
| 驗證 | verification / verify | |
| 交付 | deliverable | |
| 共用主機／共用機 | shared host | |

## Components / 元件

| 中文 | English | Where |
|---|---|---|
| 核准單 | approval ticket | `tools/approvals/` |
| 授權／續做／喚醒（核准單） | grant / resume / wake-up | `tools/approvals/` |
| 常設授權 | standing grant | `tools/approvals/grant.cjs` |
| 核准後續接 | resume after approval | |
| 安全輸入／一次性連結填帳密 | secure input / one-time link for entering credentials | `tools/secure-input/` |
| Codex 去識別代理 | Codex de-identification proxy | `tools/codex-deid/` |
| Gemini 接手 | Gemini takeover | `tools/gemini-takeover/` |
| Gemini 自動交工 | Gemini automatic hand-back | |
| 雲端分流 | cloud offload | `tools/cloud-offload/` |
| 對話搜尋 | conversation search | `tools/conversation-search/` |
| 摘要卡 | summary card | |
| 蒸餾模式評測 | distillation-mode evaluation | `tools/distill-eval/` |
| 自主執行（蒸餾） | autonomy (distillation) / autonomous execution | `docs/AUTONOMY.md` |
| 提示詞注入（防護／警示） | prompt injection (defence / warning) | `tools/prompt-injection/` |
| 規則同步 | rule sync | `tools/rulesync/` |
| 決策負擔（週）量測 | (weekly) decision-load metrics | `tools/metrics/` |
| 動作閘門 | action gate | `tools/action_gate/` |
| 本地文件問答 | local document Q&A | |
| 內網網頁測試沙盒 | intranet web test sandbox | |
| 提醒 | reminders | `tools/reminders/` |
| 專案記憶範本 | project memory template | |
| 第三方技能更新檢查 | third-party skill update check | |
| skill 用量統計 | skill usage statistics | |
| 遠端代理程式 | remote agent | `remote-agent/` |
| 控制端 | controller | |
| 公開信箱 | public mailbox | |
| 簽章＋加密 | signed and encrypted | |
| 受限 CMD | restricted CMD | |
| 搬遷沙盒 | migration sandbox | |
| 主機搬家 | host migration | `migration/` |
| 加密分段打包 | encrypted, chunked packaging | |
| 離線本地模型 | offline local model | `local-model/` |
| 常駐服務 | resident (always-on) services | `web-ops/` |
| 排程維運 | scheduled operations | `cc-hosts/` |
| seal-proxy 閘門 | seal-proxy gate | |
| 團隊小助手 | team assistant | |
| 撞額度自動續跑 | auto-resume after hitting usage limits | |
| 閒置才重啟 | restart only when idle | |
| 多人聊天室 | multi-user chat room | `web-ui/` |
| 規劃白板 | planning whiteboard | `web-ui/` |
| 停止時連子代理一起收 | stopping also stops subagents | `web-ui/` |

## Hooks and runtime behaviour / Hook 與執行行為

| 中文 | English | Where |
|---|---|---|
| 回合 | turn | |
| 回合預算 | turn budget | |
| 回合結束守門 | turn-end guard | `harness/hooks/turn-end-guard.js` |
| 手動交棒 | manual handoff | |
| 過早放棄 | premature give-up | |
| REA 提醒 | REA reminder | Name kept |
| 計畫性暫停／維護暫停 | maintenance drain (planned pause) | `harness/hooks/drain-guard.js` |
| 時限續做 | timed keep-going | `keepgoing-detect.js`, `keepgoingEnabled` |
| 叫醒 | wake-up | |
| 卡住／阻礙 | blocked / blocker | "When blocked" rule in `AGENTS.md` |
| 繁中回覆檢查 | Traditional Chinese reply check | `zh-reply-guard` |
| 選裝 | optional install (opt-in) | e.g. `--gemini` |
| 明確選開 | explicit opt-in | |

## Placeholders / 代稱

These identifiers are substitutes in the public package and are kept unchanged in English.

| Placeholder | Meaning |
|---|---|
| `D:\TAS\...`, `C:\Users\demo\...` | Install path and account of the original environment |
| `srv-main` | control host |
| `srv-db` | database host |
| `srv-rag` | local-model host |
| `srv-src` | source database |
| `srv-nas` | file server |
| `srv-old` | old host |
| `srv-db2` | second database |
| `pc-mgr` | manager's PC |
| `10.255.0.x` | fake IP |
| `DHC`, `EKB`, `RAG1`, `ragent` | company CLI name, enterprise knowledge base, local-model host, remote agent |
| `TRADE_DB`, `TRADE_DB_TEST` | production and test databases |
| `userA`–`userG`, 同事A–同事G (Colleague A–G) | team members |
| `<worker>.<account>.workers.dev`, `__KV_ID__` | Cloudflare Worker URL and KV ID |

## Literal strings kept in Chinese / 保留中文原文的字串

| String | Gloss | Why it stays |
|---|---|---|
| `確認執行` | "confirm execution" | `dhc-guard` requires this exact reply to release a blocked command once |
| `再做兩小時` and similar | "keep going for two more hours" | Example prompt that `keepgoing-detect.js` recognises (Chinese patterns) |
| `安裝說明.md` | Installation Guide | File name; English version is `安裝說明.en.md` |
