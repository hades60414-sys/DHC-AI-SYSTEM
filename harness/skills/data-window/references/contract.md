# 窗口契約（每個窗口都一樣）

所有窗口都照這份契約實作。這樣撈資料的 AI 換一台機器也是同一套做法，只有網址、資料集和欄位不同。範例見 `example-DATA_API.md`。

## 端點（前綴 `/data/api/v1`，全部是 JSON）

| 端點 | 內容 |
|---|---|
| `GET /v1/doc` | 回傳最新版 `DATA_API.md`（純文字）。manifest 裡的 `doc_version` 不一樣時，AI 就換讀新版 |
| `GET /v1/me` | 連線探測，回傳 `{"auth":"none"\|..., "quota":{...}}` |
| `GET /v1/manifest` | `data_version`、`doc_version`、`coverage`（各資料集的列數與期間）、`freshness`、`known_defects[{id,severity,what,impact,do}]`、`limits`。支援 ETag 和 `If-None-Match`，資料沒變時回 304 |
| `GET /v1/schema` | 每個資料集的主鍵、可篩選條件，以及全部欄位 `{key,label(單位),group,required,in_default_set,note}`；另附 `quality_vocabulary`（每個旗標的說明） |
| `POST /v1/extract` | 查詢條件放在 body 裡，見下節 |

## extract

```json
{ "dataset": "<名稱>", "keys": ["..."], "cols": ["..."], "from": "yyyy-MM-dd", "to": "yyyy-MM-dd",
  "limit": 1000, "cursor": null, "quality": "strict" }
```

- `keys` 是主要識別碼的清單，例如股票代號。每個資料集可以給它取自己的名字（範例用 `symbols`），但要寫進 schema。清單有上限。
- `cols` 只能從 schema 的白名單裡挑。省略時給預設欄位。主鍵欄一定會回傳，而且排在最前面。
- 回應：`meta{dataset,data_version,columns,row_count,has_more,quality{counts,blocked_cells_nulled},lineage,freshness}`、`rows[]`（每一列是物件）、`next_cursor`。
- 每一列一定帶 `quality_status`（`PASS`/`WARN`/`BLOCK`）和 `quality_flags[]`，而且不能關掉。`strict`（預設）會把受影響的格子清成 null，但保留該列；`annotated` 送出原值，只加旗標，用來調查缺陷。

## 分頁

- 依主鍵排序，用 keyset 分頁（不能用 OFFSET）。
- 游標內容是 base64 JSON，綁定三樣東西：`data_version`、查詢條件的雜湊、上一頁最後一列的主鍵。
- `data_version` 變了回 `409 SNAPSHOT_CHANGED`，查詢條件不同回 `409 CURSOR_MISMATCH`，游標格式壞了回 `400 BAD_CURSOR`。

## 新鮮度

`freshness.status` 有三種狀態。`CURRENT`：資料已到最新一個應有日。`PENDING_EOD`：今天的資料還在正常產生中。`STALE`：落後了。只有 `STALE` 要讓撈資料的程式停下來。「最新一個應有日」要依交易日曆或資料本身的節奏計算，不能直接用今天的日期。

## 配額（保護容量，不是認證）

依來源 IP 計算：每分鐘 300 次請求、同時 4 個請求、全站同時最多 2 個大量抽取。超過時回 429，並帶 `Retry-After` 和 `X-RateLimit-*` 標頭。來源 IP 只認 socket 位址；經過受信任代理時，只認代理蓋上的標頭。使用者自己填的標頭一律不信。

## 錯誤

錯誤固定回 `{"error":{"code","message","request_id","details?"}}`。程式判斷要看 `code`，不能看 `message`。常用的 code：`UNKNOWN_DATASET`、`NO_KEYS`、`TOO_MANY_KEYS`、`BAD_REQUEST`（訊息裡要指出是哪個欄位）、`BAD_QUALITY_MODE`、`BAD_CURSOR`、`SNAPSHOT_CHANGED`、`CURSOR_MISMATCH`、`RATE_LIMITED`、`TOO_MANY_CONCURRENT`、`BULK_BUSY`、`INTERNAL`。

## 硬邊界

- 唯讀：沒有任何寫入端點。資料庫帳號也只給讀取權限。
- 不接受 SQL、表名、join 或運算式。SQL 一律由伺服器依白名單產生，值一律用參數帶入。
- 每次呼叫都要寫稽核紀錄：時間、來源、資料集、幾個 key、回傳列數、品質統計。
- `data_version` 是資料內容的指紋，只要有任何匯入或回填就要跟著變。
