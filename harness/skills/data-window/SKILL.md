---
name: data-window
description: 「資料窗口」做法：把一個資料庫包成唯讀 HTTP JSON API（doc/me/manifest/schema/extract），附一份給 AI 讀的 DATA_API.md，使用者講自然語言，AI 讀規格後自己寫程式撈資料。兩種用途——(1) 撈：從已有的窗口抓資料（例：srv-old 回測平台的台股日K＋財報窗口 backtest）；(2) 建：替另一台機器的資料庫建同樣的窗口。使用者說「撈資料」「照 DATA_API 抓」「資料窗口」「讓 AI 能撈某台的資料庫」時使用。
---

# 資料窗口

一個窗口 = 唯讀 HTTP JSON 端點 + 一份自足的 `DATA_API.md`。AI 只讀那份文件就能自己寫程式撈資料；不接受 SQL，欄位只能從白名單挑。範本：srv-old（回測平台主機）的台股窗口，規格見 `references/example-DATA_API.md`。

先判斷是哪一種工作：

- **撈資料** → 照下面「撈」。
- **替某台的資料庫建窗口** → 讀 `references/contract.md`（所有窗口共用的契約）和 `references/build.md`（施工步驟與踩過的雷），照做。

## 撈

1. 先讀那個窗口的 `DATA_API.md`（或 `GET /v1/doc` 取最新版）。不要憑記憶或這份 skill 猜欄位。
2. `GET /v1/manifest`：記下 `data_version`。`freshness.status` 是 `STALE` 就停下來回報，不產出。
3. 欄位不確定先 `GET /v1/schema`，欄位清單以它為準，不抄進程式。
4. 寫程式 `POST /v1/extract`，規則不可省：
   - 照 `next_cursor` 翻到 `null`，不可只抓第一頁。
   - `429` 等 `Retry-After` 秒重試同一請求；錯誤回應不可當資料接下去。
   - `409 SNAPSHOT_CHANGED` 從第一頁重抓，不拼兩個快照。
   - `BLOCK` 列的 null 保留，不補值、不刪列。代號一律當字串（0050 不是 50）。
5. 輸出資料檔＋`summary.json`（`data_version`、總列數、`quality_status` 各狀態筆數、freshness）。
6. 回答先給結論，附 `data_version` 與資料集／條件。數字對不上回報 break（`data_version`、代號、日期、算的值、預期值），不自己湊。

## 紅線

- 窗口網址沒有認證時，網址就是權限：不貼公開場合、不寫進會上傳的檔案或外送的工具設定。
- 窗口只放市場／參考資料；部位、損益、委託、客戶資料不接進窗口。
- 撈回的資料留在公司環境內。
