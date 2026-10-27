# 查詢規格（spec）與回傳格式

這份契約是兩種執行端共用的，MCP `ragent_sql` 和本機 `nldb.cjs` 都照這裡實作。規格必須是 JSON 物件；多出未定義的欄位會被拒絕。

## 共通規則

- `database`：必須在執行端設定的白名單裡。`master`、`msdb` 這類系統庫不能放進白名單。
- `table`：可寫 `name` 或 `schema.name`。名稱有重複時會被拒絕，錯誤會列出各個 schema。
- 欄位名稱要先在系統目錄裡存在才會使用；不存在時，錯誤會列出前 40 個欄位。
- 值一律當參數傳入，依欄位型別轉換。日期用 `yyyy-MM-dd`，可帶 ` HH:mm:ss`。
- 輸出：Decimal、money、float 以字串回傳，避免失真；日期轉成字串；binary 只回前 16 bytes 的十六進位；單一格超過 200 字會截斷並標出原長度。
- 整份結果上限 15900 字。超過時從尾端砍資料列，並設 `truncated_to_fit: true`。
- 無法回傳的型別：geography、geometry、hierarchyid、sql_variant、timestamp、image、varbinary、binary。

## where 條件（最多 10 個，全部用 AND）

```json
{"column": "TradeDate", "op": ">=", "value": "2026-10-01"}
```

| op | 參數 |
|---|---|
| `=` `<>` `!=` `<` `<=` `>` `>=` | `value` |
| `like` `not like`（只能用在文字欄） | `value`，萬用字元用 `%` `_` |
| `in` `not in` | `values`：1–100 項 |
| `between` | `values`：`[低, 高]` |
| `is null` `is not null` | 不帶值 |

`value` 不能是 null；要比對 null 請用 `is null`。

## actions

### ping `{}`
回傳 `kind:"sql_ping"`、`server{server,version,edition,login,sysadmin}`、`databases[{database,user,write_capable,updateability}|{database,error}]`、`read_only_enforced_by`：`account_permissions_and_agent_templates` 或 `agent_templates_only`。

### tables `{database, schema?, like?, top? 1–200 預設 100}`
`kind:"sql_tables"`，`columns:["schema","name","type","rows","size_mb","modified"]`。只列出資料表和檢視；`rows` 是 sys.partitions 的統計值。

### columns `{database, table}`
`kind:"sql_columns"`，`table`、`object_type`、`primary_key[]`，以及 `columns:["name","type","nullable","identity"]`。`type` 會帶長度，例如 `nvarchar(50)`、`decimal(18,4)`。

### select `{database, table, columns?[≤50], where?, order_by?[{column, desc?}] ≤5, top? 1–200 預設 50}`
`kind:"sql_rows"`。沒指定 `columns` 時，取前 40 個可回傳的欄位，跳過的欄位列在 `skipped_columns`。沒有 `order_by` 時加上 `note`。

### agg `{database, table, group_by?[≤5], aggregates[1–8 項 {fn, column?}], where?, order_by?[{column|aggregate:<索引>, desc?}], top? 預設 100}`
`fn`：`count`（不帶 column 表示 COUNT(*)）、`count_distinct`、`min`、`max`、`sum`、`avg`。`sum` 和 `avg` 只能用在數值欄，算的時候先 CAST 成 decimal(38,6) 或 float。`order_by` 的 column 必須在 `group_by` 裡；`aggregate` 是 `aggregates` 陣列的索引，從 0 起算。回傳 `kind:"sql_agg"`，`columns` 是分組欄加 `fn(欄位)`。

### date_gaps `{database, table, date_column, from, to, where?, reference?{database, table, date_column, where?}}`
`date_column` 可以是 date/datetime、int yyyyMMdd，或文字 yyyyMMdd、yyyy-MM-dd、yyyy/MM/dd。區間最多 3700 天。沒給 `reference` 時，預期日期是週一到五，不扣國定假日。回傳 `days_present`、`first_day`、`last_day`、`missing_count`、`missing[≤150]`、`extra_count`、`extra[≤50]`、`lists_truncated`。

### fingerprint `{database, tables?[≤50]}`
逐表回傳 `{table, rows, fingerprint, schema_fingerprint, seconds}`。`fingerprint` 跟資料列順序無關，做法是對每一列的標準化內容算 SHA-256，再彙總 sum64 和 xor64。全部表加總有時間上限，超過就請對方分批。

## 資料列結果共通欄位

`more_rows`（還有下一筆沒拿）、`truncated_to_fit`（為了字數上限被砍）、`returned_rows`、`rows`（二維陣列，順序同 `columns`）、`elapsed_ms`。

## 錯誤

本機執行端回傳 `{"ok":false,"error":"..."}`，exit code 是 1。MCP 執行端回傳 isError 和訊息文字。錯誤訊息要具體到能直接修正規格，例如不在白名單時列出白名單，欄位不存在時列出欄位，op 不支援時列出支援的 op。
