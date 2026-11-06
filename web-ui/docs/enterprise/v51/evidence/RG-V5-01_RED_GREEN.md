# RG-V5-01 RED／GREEN 證據（本機 darwin-arm64，Node 22；合成資料）

| 情境 | RED（V5 `877525f`） | GREEN（V5.1） |
|---|---|---|
| 單一來源 50,000 列 | completed，1,149 ms，結果 JSON **74.8 MB**（450,000 個來源參照） | completed，約 450 ms，結果 JSON **0.4 MB**（每主張最多 200 參照＋總數／truncated） |
| 五來源 × 50,000 列 | completed，**65,001 ms**（`Array.includes` O(n²)），504 MB | 拒收 `TOTAL_ROWS_EXCEEDED`，287 ms |
| 五來源各約 14 MB（合計 70 MB） | completed，77,839 ms，**1,865 MB** | 拒收 `TOTAL_BYTES_EXCEEDED`，412 ms |
| 單行 25 MiB | 解碼後才拒收 `COLUMN_COUNT`，1,351 ms，**1,016 MB** | 拒收 `TOTAL_BYTES_EXCEEDED`，6 ms |
| 單行 20 MiB | （未量） | 解碼前拒收 `LINE_TOO_LONG`，2 ms |
| 五來源合計 50,000 列（合法） | — | completed，514 ms |

RSS 為子行程峰值，含產生合成輸入本身的記憶體。原始輸出：`RG-V5-01_ops-probe_RED_877525f.json`、`RG-V5-01_ops-probe_GREEN.json`；CI 每次以 `scripts/enterprise/ci/ops-resource-probe.ts` 重跑並以預期結果把關。

結果 JSON 大小的 RED 由一次性腳本量測（同一 50,000 列合成輸入，`JSON.stringify(result)`）。
