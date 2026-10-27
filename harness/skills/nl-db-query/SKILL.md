---
name: nl-db-query
description: 用自然語言問公司資料庫（SQL Server 等）並給出有出處的答案。問題先轉成結構化查詢 JSON（不寫 SQL 文字），交給唯讀執行端跑，再根據回傳的資料列作答。使用者說「查資料庫」「某表有沒有某天的資料」「某欄位最大／最小／筆數」「哪張表有某欄位」「缺哪幾天」，或要查 srv-db／srv-rag／srv-main／pc-mgr／本機資料庫時使用。不用於改資料、建表、搬庫。
---

# 自然語言查資料庫

模型只負責「問題 → 查詢規格 JSON → 讀結果 → 作答」。SQL 由執行端依規格自己組，執行端只做唯讀查詢。規格與回傳格式見 `references/spec.md`。

## 執行端（先確認用哪一個）

| 環境 | 怎麼呼叫 |
|---|---|
| Claude Code／DHC CLI，查遠端機器 | MCP 工具 `mcp__<host>__ragent_sql`，參數 `{action, spec}`；host 例：`ragent`（srv-db）、`rag1`（srv-rag）、`pcmain`、`pcmgr` |
| Codex 或任何 agent，查本機資料庫 | `node <本 skill>/scripts/nldb.cjs <action> <spec.json 路徑>`，stdout 是一行 JSON。設定檔路徑放在環境變數 `NLDB_CONFIG`。腳本不存在就停下，說明要先照 `references/executor.md` 建好 |

兩種執行端的 action、spec、回傳格式完全相同。差別只有呼叫方式。

## 每一題的流程

1. **連線與權限**：同一段對話裡第一次查詢先跑 `ping`。結果裡有 `write_capable: true`，或 `read_only_enforced_by` 是 `agent_templates_only` 時，要告訴使用者：「這個帳號有寫入權，唯讀只靠執行端的查詢範本保證」。
2. **找表**：用 `tables`（`like` 帶中英文關鍵字，例：`%部位%`、`%price%`）。不要憑記憶猜表名。
3. **認欄位**：用 `columns` 看欄位名稱、型別和主鍵。日期欄可能是 date、int yyyyMMdd 或文字，條件值要配合欄位型別。
4. **查**：
   - 看幾筆明細：`select`，要加 `order_by`，`top` 要小（預設 50，上限 200）。
   - 筆數、最大、最小、加總、平均、分組：`agg`，不要把明細抓回來自己算。
   - 「缺哪幾天」「資料到哪天」：`date_gaps`。交易日要扣假日時，用 `reference` 指向交易日曆表。
   - 證明兩邊資料一致（例如搬遷驗收）：`fingerprint`，兩邊都跑，比對 `rows` 和 `fingerprint`。
5. **作答**：先講結論，再列根據。每個數字標出 `資料庫.schema.表`、查詢條件、查詢時間。金額和小數照回傳字串原樣引用，不要四捨五入或換算，除非使用者要求，而且要寫出算法。

## 判讀規則

- `more_rows: true` 或 `truncated_to_fit: true` 表示結果不完整。要明講，然後改用 `agg`、縮小條件或減少欄位。不能把部分結果說成全部。
- `tables` 的 `rows` 是系統統計數，不是即時 COUNT。要精確筆數就用 `agg` 加 `{fn:"count"}`。
- 沒有 `order_by` 時，資料列順序不保證。「最新一筆」一定要用 `order_by` 加 `desc`。
- 錯誤訊息會列出可用的表、欄位或白名單。照錯誤修正規格再試一次；同一個錯誤連續兩次就停下來回報。
- 執行端回覆「還有工作在等結果」（MCP 通道）時，先呼叫同一個 host 的 `ragent_job_result`，再重送。
- 查不到就說查不到，附上查過的表和條件。不推測數值。

## 範圍

- 只查詢。使用者要求寫入、刪除、建表、改權限，或要求執行任意 SQL 文字時，說明這個 skill 不做，並請使用者改用有人工覆核的流程。
- 遇到損益、客戶、個資類的表，先確認使用者有權看、用途正當，再查。結果只引用回答需要的欄位，不整理成名單。
- 數字對不上就照實回報差異和證據，不要調整到相符。
