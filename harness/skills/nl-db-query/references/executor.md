# 本機執行端 `scripts/nldb.cjs` 實作需求

這份文件給要在新機器上建立執行端的 agent 看。目標是讓那台機器的資料庫，也能用 `spec.md` 定義的同一套 action 和 spec 查詢。

## 介面

```
node scripts/nldb.cjs <action> <spec.json 路徑>
node scripts/nldb.cjs selftest
```

- `action` 是 `ping`、`tables`、`columns`、`select`、`agg`、`date_gaps`、`fingerprint` 其中之一。spec 從檔案讀，避免 shell 吃掉引號和反斜線。
- 成功時，stdout 輸出一行 JSON，內容跟 `spec.md` 的回傳格式相同，exit code 0。
- 失敗時，stdout 輸出 `{"ok":false,"error":"..."}`，exit code 1。錯誤訊息不能帶出密碼或連線字串。
- 設定檔路徑由環境變數 `NLDB_CONFIG` 指定，檔案放在 skill 資料夾以外：

```json
{ "engine": "mssql", "server": "HOST\\INSTANCE", "port": 1433,
  "auth": "sql", "userEnv": "NLDB_USER", "passwordEnv": "NLDB_PWD",
  "databases": ["DbA", "DbB"], "maxResultChars": 15900 }
```

  `auth` 可以是 `sql` 或 `windows`。密碼只能從環境變數讀，設定檔裡不能存密碼。

## 一定要做到（安全）

1. **不接受 SQL 文字。** 所有 SQL 都由程式依 spec 組出來。spec 裡出現未定義的欄位時直接拒絕。
2. **資料庫要在白名單內，而且大小寫不敏感的比對要完全相符。** 系統庫（master、msdb、tempdb、model）就算寫進設定檔也要拒絕。
3. **表名和欄名要先查系統目錄**（sys.objects、sys.columns，或其他引擎的 information_schema），確認存在後再用。SQL 裡用目錄回傳的正式名稱，並依引擎規則加引號跳脫：SQL Server 用 `[` `]`，`]` 要寫成 `]]`；PostgreSQL 用 `"`，`"` 要寫成 `""`。使用者給的字串絕對不能直接拼進 SQL。
4. **值一律用參數傳入**，並依欄位型別轉換：日期要合法，整數不能超出範圍，decimal 用字串解析。
5. **唯讀**：每次查詢都開交易，結束時一律 ROLLBACK。SQL Server 要設 `SET LOCK_TIMEOUT 5000; SET DEADLOCK_PRIORITY LOW`，CommandTimeout 15 秒（fingerprint 例外，120 秒），連線要帶 ApplicationIntent=ReadOnly。建議 DBA 另外開一個只有 db_datareader 權限的帳號。
6. **上限**：`top` 不超過 200，where 條件不超過 10 個，`in` 不超過 100 個值，單一格不超過 200 字，整份結果不超過 `maxResultChars`。超過時逐列砍除，並標上 `truncated_to_fit`。查詢時多抓 1 列來判斷 `more_rows`。
7. **ping 要老實回報權限**：回報帳號是否為 sysadmin，以及每個庫是否有 db_owner、db_datawriter、db_ddladmin 或 INSERT、UPDATE、DELETE、ALTER 權限。只要有任何一項，`read_only_enforced_by` 就填 `agent_templates_only`。

## fingerprint 演算法（要能跟其他機器的結果比對，必須逐位元一致）

- 每一列的每個值依序轉成標準文字，用 `\t` 串起來後算 UTF-8 的 SHA-256。取前 8 bytes（big-endian）當成 uint64 v，然後 `rows++`、`sum += v`（mod 2^64）、`xor ^= v`。結果寫成 `rows:sum(16 位小寫 hex):xor(16 位小寫 hex)`。
- 值的標準化：NULL 寫成 `\N`。decimal 用 invariant 格式並去掉小數尾端的 0（`-0` 改成 `0`）。bit 寫成 `1` 或 `0`。date 寫成 `yyyy-MM-dd`。datetime 類先轉 UTC（只有 datetimeoffset 需要轉），寫成 `yyyy-MM-dd HH:mm:ss.fffffff` 再去掉尾端的 0 和小數點。time 寫成 `hh:mm:ss.fffffff` 並同樣去尾。float 和 real 用最短可還原的表示（round-trip）。binary 寫成 `0x` 加大寫 hex。GUID 寫成小寫 `D` 格式。文字要跳脫 `\` → `\\`、Tab → `\t`、LF → `\n`、CR → `\r`。
- `schema_fingerprint`：每個欄位寫成 `欄名:型別族`，用 `,` 串起來，算 SHA-256 後取前 16 位小寫 hex。型別族：int（bigint、int、smallint、tinyint）、dec（decimal、numeric、money、smallmoney）、float、bool、date、ts（datetime、datetime2、smalldatetime、datetimeoffset）、time、bin、text（各種字元型別、xml、uniqueidentifier、sysname）。其他型別寫成 `other:<型別>`。

## 驗收（`selftest` 加上真資料庫測試）

`selftest` 不需要資料庫，至少要驗這些：
- spec 驗證：未知欄位、白名單外的庫、系統庫、不支援的 op、`like` 用在非文字欄、`between` 的值不是 2 個、`is null` 帶了值、`top` 等於 0 或 201，都要被拒絕，而且錯誤訊息要具體。
- 注入：表名、欄名、值裡帶 `'; DROP TABLE x;--`、`]`、`"` 時，產生的 SQL 不會改變語意（比對產生的 SQL 字串和參數）。
- 截斷：一個寬表要正確標出 `truncated_to_fit` 和 `more_rows`。
- fingerprint：同一組資料換順序，結果相同；改一個值，結果不同。

連上真資料庫後，對每一個 action 至少跑一個查詢，並用 ping 確認帳號權限。測試資料庫和測試案例檔要放在 skill 資料夾以外。
