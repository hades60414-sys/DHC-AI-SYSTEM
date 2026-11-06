# RG-V5-07｜去識別代理加固計畫（工單）

> 範圍：`web-ops/deid-proxy/server.cjs`（Claude Code 用，預設 127.0.0.1:3003）、`tools/codex-deid/server.cjs`（Codex 用，127.0.0.1:3004）。模組屬 TAS Team，不在 Enterprise V5.1 產品範圍；V5.1 **未修改**，只交付可執行工單與測試方案。

## 現況與發現

| 面向 | deid-proxy | codex-deid |
|---|---|---|
| 監聽 | 只綁 127.0.0.1 ✅ | 只綁 127.0.0.1 ✅ |
| 無法檢查的內容 | 拒絕不轉送 ✅ | 拒絕；壓縮 body 415、WebSocket 426 ✅ |
| 請求 body 大小 | **無上限**，整份收進記憶體後才判斷路徑 | **無上限** |
| 回應大小 | 非 SSE 回應整份累積成字串（無上限） | 同 |
| 逾時 | 上游請求與 socket **無逾時** | 同 |
| 背壓 | SSE `res.write` 未檢查回傳值；上游未 pause | 同 |
| 用戶端斷線 | 只監聽 `req 'aborted'`；body 收完後斷線不會中止上游 | 同 |
| Header | 轉送全部用戶端 header（含 hop-by-hop：`connection`、`proxy-*`、`transfer-encoding`） | 同 |
| 路徑政策 | 有 body 時 `startsWith('/v1/messages')`（未正規化）；無 body 的任意路徑直接轉送 | 無路徑政策（以 body 形狀判斷） |
| 稽核檔 | `audit.jsonl` 無輪替、寫入錯誤被吞掉 | 同 |

**實測**（本機 127.0.0.1、上游指向不存在的埠）：送 300 MB body 到 `/v1/files`，proxy RSS 由 46 MB 升到 555 MB 後才回 403——請求在判斷路徑前已整份緩衝。

## 工單

| ID | 工作 | 驗收 |
|---|---|---|
| DEID-01 | 先判斷方法＋路徑（正規化後的 exact allowlist），不允許者在讀 body 前回 403 | 對非允許路徑送 300 MB，RSS 增量 < 10 MB |
| DEID-02 | 請求 body 上限（例如 32 MiB，可設定），超過立即 413 並 `req.destroy()` | 超限請求 413、記憶體不隨大小增長 |
| DEID-03 | 非 SSE 回應上限與串流化 restore；超過時中止並回 502 | 上游回 200 MB 時不 OOM |
| DEID-04 | 上游 `timeout`、`server.headersTimeout`／`requestTimeout`、idle socket timeout | 上游無回應時在設定秒數內回 504 |
| DEID-05 | 背壓：`res.write` 回 false 時 `ur.pause()`，`drain` 後 resume | 慢用戶端時 proxy RSS 穩定 |
| DEID-06 | 斷線：監聽 `res 'close'`（未完成）→ `up.destroy()` | 用戶端中途斷線後上游連線在 1 s 內關閉 |
| DEID-07 | Header 允許清單：丟棄 hop-by-hop、`x-forwarded-*`；回應去除 `set-cookie` 等不必要 header | 單元測試比對轉送 header 集合 |
| DEID-08 | `audit.jsonl` 輪替與寫入失敗告警 | 達大小上限時輪替 |

## 測試方案

以本機假上游（`http.createServer`）＋子行程啟動 proxy，量子行程 RSS 與上游連線狀態；每張工單一個 node:test 案例。測試只用合成資料，不連真模型。

**需模組 owner 指派與排程**（HUMAN_DECISION_QUEUE：SEC-02）。
