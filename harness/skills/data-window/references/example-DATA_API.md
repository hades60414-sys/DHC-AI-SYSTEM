# 台股市場資料窗口 — 給 agent 的接入說明

**讀者**：要寫程式抓這個庫的 AI agent 或工程師。假設你對這個平台一無所知。

**這個窗口是什麼**：一組唯讀 HTTP JSON 端點，提供台股的日 K（原始價與還原價）、單季財報、月營收、公司行動。
資料來自券商內網的 MktData 匯出、TWSE／TPEx 官方報表，以及本地的日更管線。

**這個窗口不是什麼**：不是下單通道、不是即時行情、不是委託流或部位查詢。
它只有 PostgreSQL schema `market` 的市場資料。交易室的委託流、部位、客戶資料不在這裡，也不會接進來。

---

## 0. 三十秒版本

```
Base URL   <BASE_URL>
認證       沒有。不需要金鑰、token 或登入。
格式       全部 JSON
錯誤       {"error":{"code":"...","message":"...","request_id":"..."}}
```

```bash
curl <BASE_URL>/manifest
```

**這個站沒有認證——網址本身就是權限。**
拿到網址的人就拿得到全部市場資料，所以：網址只在內部流通，不要貼到公開場合、
不要放進會外送的工具設定、不要寫進任何會被推上外部 repo 的檔案。

**唯一入口就是上面這個固定網址**（2026-08-31 起）：
- 伺服器的 IP:port 不對網路開放，掃描器連 TCP 都握不到。
- 背後的臨時隧道網址（`*.trycloudflare.com`）已被邊緣封條封死，直打回 403。
  如果你在哪裡看到那種網址，忽略它——它每次重啟都會換，而且不能用。
- 把固定網址寫死在程式裡即可，它不會變。

---

## 1. 先讀這一節，否則你算出來的數字會是錯的

這個庫有**已知缺陷**。缺陷不只寫在文件裡，而是跟著**每一列資料**走。

### 1.1 每一列都有 `quality_status` 與 `quality_flags`

這兩個欄位一定存在，無法用 `cols` 取消。

| `quality_status` | 意思 |
|---|---|
| `PASS` | 這一列沒有已知問題 |
| `WARN` | 可用，但有限制。看 `quality_flags` |
| `BLOCK` | 這一列的**原始價**不可用 |

`quality_flags` 是字串陣列，可能的值與意思由 `GET /v1/schema` 的 `quality_vocabulary` 提供（程式可直接讀，不要抄）：

| flag | 意思 |
|---|---|
| `CA_GAP_BLOCK` | 這天的原始價跨過**未收錄的減資／反分割**，用原始價算報酬會憑空多賺 |
| `CA_GAP_WARN` | 這天有配股類事件尚未收錄，用原始價算報酬會低估（方向保守） |
| `RAW_PRICE_MISALIGNED` | 本地管線把**前一場**的收盤與成交量蓋上了這天的日期，這格是錯的 |
| `NO_ANNOUNCE_DATE` | 來源沒給公告日，不可假設當時已公開；做 PIT 回測要自己處理 |
| `OFFICIAL_VALUE_CONFLICT` | 這筆現金股利與官方 TPEx 值不同（尚未採用官方值） |

### 1.2 `strict`（預設）會把壞掉的格子清成 null，但保留列與旗標

- `quality: "strict"`（預設）：受缺陷影響的 `open`/`high`/`low`/`close` 會是 `null`，
  該列 `quality_status = "BLOCK"`，旗標說明原因。**列不會消失**——時間序列不會無聲產生破洞。
- `quality: "annotated"`：原值照樣送出，只加旗標。
  這是**拿來調查缺陷本身**用的，不是拿來算績效的。

為什麼不是整批擋掉？因為全市場一定踩得到（庫裡有 4,072 筆 block），整批 409 等於 API 不能用；
而靜靜把錯的值送出去更糟。清值 + 留旗標是兩者之間唯一誠實的選項。

### 1.3 要算報酬請用 `adj_close` / `adj_return`，**不要**用 `close`

本地原始價序列的還原狀態不一致：**對無償配股已經還原，對現金股利沒有**。
這是為什麼 `corporate_action` 目前不含任何 `split`——在原始價序列重建之前，寫進去只會讓事情更糟。

還原價（`adj_*`）來自另一條資料線（券商內網 MktData），不受這個問題影響。
`adj_return` 已經在庫裡算好：`adj_close[t] / adj_close[t-1] - 1`，其中 t−1 是**上一個有收盤價的交易日**。

> 來源的 `漲幅(%)` 欄位（`chg_pct_unadj`）**沒有**折入股利，不要拿它算績效。

### 1.4 `STALE` 不能直接進結論

`meta.freshness.status` 是 `STALE` 時，代表資料落後最後一個交易日。
依中台紀律，STALE 價格只能**回報並要求人工確認**，不得直接送進自動化結論。你的程式應該在這時候停下來。

---

## 2. 端點

### `GET /v1/me`
探測用：連得上嗎、流量額度剩多少。沒有帳號可回，回的是 `{"auth":"none", ...}`。

### `GET /v1/manifest`
資料版本、涵蓋範圍、新鮮度、**已知缺陷清單**。支援 `If-None-Match`（相同回 `304`）。

```json
{
  "data_version": "ef12fa3d0cff9769",
  "coverage": { "securities": 3167, "price_rows": 7557172, "gap_block": 4072, "gap_warn": 2240, "raw_flagged": 764 },
  "freshness": { "adj_to": "2026-08-26", "raw_to": "2026-08-26", "session_to": "2026-08-26", "status": "CURRENT" },
  "known_defects": [ { "id": "...", "severity": "high", "what": "...", "impact": "...", "do": "..." } ],
  "limits": { "page_default": 1000, "page_max": 5000, "max_symbols": 3200 }
}
```

`data_version` 只要有任何一次匯入或回填就會變。把它記下來——你的下游資料要能講出「這是哪一版」。

### `GET /v1/schema`
四個資料集的**全部欄位**與語意。這是欄位的**唯一真實來源**，不要把欄位清單抄進你的程式碼。

每個欄位有：`key`、中文 `label`（單位寫在括號裡）、`group`/`sub`（分組）、`required`（必含）、
`in_default_set`（省略 `cols` 時會不會給）、`note`（踩雷提示）。

### `POST /v1/extract`

```json
{
  "dataset": "prices",             // prices | fundamentals | revenue | actions
  "symbols": ["2330", "2317"],     // 必填，最多 3200 檔
  "cols":    ["adj_close", "volume"],  // 省略 = 該資料集的預設欄位集
  "from":    "2020-01-01",         // 只有 prices 看這兩個
  "to":      "2026-08-26",
  "limit":   1000,                 // 預設 1000，上限 5000
  "cursor":  null,                 // 上一頁回的 next_cursor
  "quality": "strict"              // strict（預設）| annotated
}
```

回應：

```json
{
  "meta": {
    "dataset": "prices",
    "data_version": "ef12fa3d0cff9769",
    "columns": ["symbol","trade_date","adj_close","volume","quality_status","quality_flags"],
    "row_count": 1000,
    "has_more": true,
    "quality": { "counts": { "PASS": 995, "WARN": 4, "BLOCK": 1 }, "blocked_cells_nulled": 1, "vocabulary": {...} },
    "lineage": { "adj_*, volume, ...": "mktdata_intranet…", "open/high/low/close": "twse + tpex…" },
    "freshness": { "status": "CURRENT", ... }
  },
  "rows": [ { "symbol": "2330", "trade_date": "2026-08-26", "adj_close": 2415, "volume": 19467000,
              "quality_status": "PASS", "quality_flags": [] } ],
  "next_cursor": "eyJ2IjoiZWY..."
}
```

`symbol` 與日期／期別欄位**一定**會在，而且一定在最前面——多檔合併時沒有代號欄就分不出誰是誰。

---

## 3. 分頁

照 `next_cursor` 走，直到它是 `null`。

```
page1 = extract({...})           → next_cursor = "A"
page2 = extract({..., cursor:"A"}) → next_cursor = "B"
...直到 next_cursor === null
```

**游標綁三件事**：資料版本、查詢條件、上一頁的最後一個主鍵。

| 情況 | 回應 |
|---|---|
| 資料在你翻頁途中被回填 | `409 SNAPSHOT_CHANGED` → **從第一頁重抓**，不要把兩個快照拼起來 |
| 拿游標配上不同的 symbols／cols／期間 | `409 CURSOR_MISMATCH` |
| 游標格式壞掉 | `400 BAD_CURSOR` |

分頁順序即主鍵順序：prices 是 `(symbol, trade_date)`、fundamentals 是 `(symbol, period)`、
revenue 是 `(symbol, ym)`、actions 是 `(symbol, ex_date, action_type)`。

---

## 4. 配額

額度是**依來源 IP** 算的容量保護，不是認證——它擋的是「迴圈寫壞了把資料庫吃光」。

| 閘門 | 預設 | 超過時 |
|---|---|---|
| 每分鐘請求數 | 300 | `429 RATE_LIMITED` |
| 同來源並行 | 4 | `429 TOO_MANY_CONCURRENT` |
| 全站同時大抽取 | 2 | `429 BULK_BUSY` |

`429` 一定帶 `Retry-After`（秒）。回應也帶 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Policy`。

**連續翻頁本來就會撞到配額**，這是正常的。你的客戶端必須：
看到 `429` 就等 `Retry-After` 秒再重試同一個請求，**不要把錯誤回應當成資料接下去**。

---

## 5. 錯誤

一律是這個形狀：

```json
{ "error": { "code": "SNAPSHOT_CHANGED", "message": "…", "request_id": "a1b2c3d4e5f6a7b8", "details": {...} } }
```

程式請判斷 `code`，不要判斷 `message`（訊息是給人看的，會改）。

| HTTP | code | 意思 |
|---|---|---|
| 400 | `UNKNOWN_DATASET` / `NO_SYMBOLS` / `TOO_MANY_SYMBOLS` / `BAD_QUALITY_MODE` / `BAD_CURSOR` | 參數不對 |
| 400 | `BAD_REQUEST` | 欄位不在白名單（訊息會指出是哪一個） |
| 409 | `SNAPSHOT_CHANGED` / `CURSOR_MISMATCH` | 見第 3 節 |
| 429 | `RATE_LIMITED` / `TOO_MANY_CONCURRENT` / `BULK_BUSY` | 見第 4 節 |
| 500 | `INTERNAL` | 帶 `request_id` 找平台維運方 |

---

## 6. 完整範例（Node，不需要任何套件）

```js
const BASE = '<BASE_URL>';

async function call(path, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) {
      if (attempt >= 5) throw new Error('rate limited too many times');
      await new Promise(s => setTimeout(s, (Number(r.headers.get('retry-after')) || 1) * 1000));
      continue;
    }
    const j = await r.json();
    if (!r.ok) throw new Error(`${j.error.code}: ${j.error.message} (${j.error.request_id})`);
    return j;
  }
}

const mf = await call('/manifest');
if (mf.freshness.status === 'STALE') throw new Error('資料落後最後一個交易日，不可直接進結論');

const rows = [];
let cursor = null;
do {
  const page = await call('/extract', {
    dataset: 'prices',
    symbols: ['2330', '2317'],
    cols: ['adj_close', 'adj_return', 'volume'],
    from: '2024-01-01',
    limit: 5000,
    cursor,
  });
  rows.push(...page.rows);
  cursor = page.next_cursor;
} while (cursor);

const blocked = rows.filter(r => r.quality_status === 'BLOCK');
if (blocked.length) console.warn(`${blocked.length} 列被標 BLOCK，原始價已被清成 null`);
```

PowerShell 5.1 版本在窗口頁上（`/data/api` → 「怎麼接」→ 範例）。
注意公司環境只有 Windows PowerShell 5.1：不能用 `&&`、`||`、三元、`??`、`-Parallel`。

---

## 7. 資料集與已知涵蓋範圍

| dataset | 內容 | 主鍵 | 期間 | 欄位數 |
|---|---|---|---|---|
| `prices` | 日 K：原始四價 + 還原四價 + 還原報酬 + 量能 + 估值 | `(symbol, trade_date)` | 2012-01-02 起 | 25 |
| `fundamentals` | 單季損益／資產負債／現金流量／財務比率 | `(symbol, period)` | 依個股 | 112 |
| `revenue` | 月營收（含已修正的公告日） | `(symbol, ym)` | 依個股 | 7 |
| `actions` | 公司行動（現金股利為主） | `(symbol, ex_date, action_type)` | 依個股 | 8 |

台股個股宇宙：上市 1,078 + 上櫃 887 + **已下市櫃 160** = 2,125 檔。
做回測請把已下市櫃的也放進宇宙，否則報酬會系統性偏高（生存者偏誤）。

另有 25 檔 `kind='stock'` 但市場別對不到（興櫃／創新板／早年下市），不在上述 2,125 檔內。

### 幾個容易誤用的欄位

| 欄位 | 陷阱 |
|---|---|
| `revenue_k`、所有 `*_k` | 單位是**千元**，不是元 |
| `mktcap`、`capital` | 單位是**元**（庫裡是億／百萬，API 已換算） |
| `volume` | 單位是**股**（庫裡是張，API 已 ×1000） |
| `chg_pct_unadj` | 來源原欄位，**沒折入股利**，不要拿來算報酬 |
| `announce_date` | 空白代表來源沒給，**不可假設當時已公開** |
| `period` | 格式 `2026Q2`，代表**單季**不是累季 |
| `limit_flag` | `1` = 漲停、`-1` = 跌停、`0` = 都不是 |

---

## 8. 硬邊界

這些不是「還沒做」，是**不會做**：

- **唯讀**。沒有任何寫入端點。
- 不接受 SQL、表名、join 或運算式。欄位只能從 `/v1/schema` 的白名單挑。
- 只有 schema `market` 的市場資料。交易室的委託流、部位、客戶資料不在這裡，也不會接進來。
- 每一次呼叫都寫稽核紀錄（誰、什麼時候、抓了哪個資料集幾檔幾列、品質統計）。

---

## 9. 出事找誰

- **網址外流** → 這是這個站唯一的機密。外流等於全部市場資料外流，立刻通知平台維運方換網址。
- 收到 `500` → 帶著 `request_id` 找平台維運方。
- 覺得數字不對 → **不要自己湊**。回報 break，附上 `data_version`、`symbol`、日期、你算的值與你預期的值。
