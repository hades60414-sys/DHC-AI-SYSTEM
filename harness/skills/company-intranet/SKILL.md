---
name: company-intranet
description: Route to the team's intranet knowledge base (hosts, web server and PHP setup, SQL Server catalogs, page-to-table site map, deploy conventions) when work touches internal web pages, config files, intranet servers, scheduled jobs, or deploying files a colleague handed over. (Template: point it at your own kb folder first.)
---

# Intranet knowledge base (template)

> 給下載者：原團隊版本指向自己公司內網的知識庫（主機、網站原始碼、資料表目錄），不隨 repo 散布。用法：建一個資料夾放你們自己的 kb（結構照下表），把下面的 `<KB_DIR>` 換成實際路徑，或設環境變數 `INTRANET_KB` 指過去。kb 內容是公司內部資料，不要放進這個 repo 或任何公開地方。

Knowledge lives in `<KB_DIR>` (or the folder named by the `INTRANET_KB` environment variable). If neither exists, say so and ask the user where the kb is; do not guess hosts or tables.

Every kb file should carry a `last_verified: YYYY-MM-DD (how)` line. Older than 60 days means re-check before relying on it.

## Suggested kb layout and what to read

| Task mentions | Read |
|---|---|
| which server / what is installed / can host X reach Y | `00-overview.md`, then `hosts/<host>.md` |
| a web page, include chain, which table a page uses | `webapp/site-map.md`, then the page source if you keep a copy |
| table, column, index, row count, scheduled DB job | `db/<server>/<database>.md` |
| how things are deployed, backup naming, allow-lists, config variables | `conventions.md` |
| something nobody has confirmed yet | `unknowns.md` (ask the user, then remove the line) |

## Building the kb

Start small: one `00-overview.md` listing hosts by role name, plus `conventions.md`. Fill the rest from read-only checks run inside the network (installed software, web server config with secrets masked, `INFORMATION_SCHEMA` exports). Keep raw dumps out of chat; summarize them into the files above.

## Boundaries

- kb content is internal: never upload it, paste it into public tools, or commit it to a public repo.
- Never paste connection strings or credentials from the kb into prompts or replies.
- Row-level company data is out of scope here; see `company-environment` for database access rules.
