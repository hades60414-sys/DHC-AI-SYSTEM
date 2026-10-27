---
name: company-environment
description: Apply this machine's runtime limits and the company's database conventions when work mentions running Python or scripts, endpoint security killing processes, company databases, market data feeds, ODBC/SQL Server/PostgreSQL connections, or backtest infrastructure. Read only the relevant reference. (Template: fill in references/ before relying on it.)
---

# Company Environment (template)

> 給下載者：這是填空範本。原團隊版本記錄的是自己公司的主機、資料庫與限制，不隨 repo 散布。把 `references/` 兩份檔案裡的 `<...>` 換成你們的實際情況（不要寫密碼），這個 skill 就會在相關工作時自動提醒 AI 照你們的規矩做。還沒填之前，AI 讀到 `<...>` 應該停下來問你，而不是猜。

Load only the reference the task needs:

- Running Python / Node / PowerShell, processes that die silently, what shell to use on company machines: read [references/runtime.md](references/runtime.md).
- Which database holds what, how to connect, read-only rules, local backtest store: read [references/databases.md](references/databases.md).
- Intranet hosts, web servers, page source, deploy conventions: use the `company-intranet` skill.

## Rules that apply before any reference is filled in

- If a reference still contains `<...>` placeholders for the fact you need, ask the user; never invent a host, database, table, or account name.
- Credentials live only in environment variables on the user's own machine (`setx NAME value`); check that a variable exists, never print or log its value.
- Production databases are read-only unless the user explicitly approves a write for this task.
- Row-level customer or position data stays inside the company network; summaries and code may leave it, raw rows may not.
