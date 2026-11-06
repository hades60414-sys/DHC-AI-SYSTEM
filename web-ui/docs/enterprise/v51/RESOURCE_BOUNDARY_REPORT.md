# RG-V5-01｜OPS-REPORT 資源邊界報告（V5.1）

## 規格狀態

營運週報情境規格只固定兩週、三據點的合成資料，**沒有定義單次週報的列數或多來源合計上限**。V5 的「單一來源 5 萬列」沿用 ACC-MATCH-v1 的工程上限，不是業務契約。因此 V5.1 只設工程安全上限，並把業務列數契約列入待決（DEC-05）。

| 上限 | 值 | 判定時點 | 拒收代碼 |
|---|---|---|---|
| 單一來源資料列 | 50,000（V5 既有） | 解碼前 bytes 掃描 | `TOO_MANY_ROWS` |
| 全部來源合計資料列 | 50,000（**工程上限，待業務決策**） | 解碼前，依剩餘預算 | `TOTAL_ROWS_EXCEEDED` |
| 全部來源合計 bytes | 25 MiB（＝單一文件上限） | ① prepare 交易依已存 `byte_size`（不讀 blob）② 引擎內再檢查 | HTTP 413 `ENTERPRISE_OPS_REPORT_TOO_LARGE`／`TOTAL_BYTES_EXCEEDED` |
| 單行 bytes | 16 KiB | 解碼前 bytes 掃描 | `LINE_TOO_LONG` |
| 單一欄位 | 200 字（V5 既有） | 解析時 | `TOO_LONG_<欄位>` |
| 結果中每主張的來源列／據點／原因 | 各 200 筆＋總數＋`truncated` | 計算後 | —（相容的追加欄位） |
| 同時計算數 | 2（佇列 8） | 路由 | HTTP 429 `ENTERPRISE_RATE_LIMITED` |

## RED → GREEN（合成資料）

| 情境 | RED（V5 `877525f`） | GREEN（V5.1） |
|---|---|---|
| 單一來源 5 萬列（合法） | 完成，1.15 s；結果 JSON **74.8 MB**（45 萬個來源參照，寫入 jsonb） | 完成，約 0.45 s；結果 JSON **0.4 MB** |
| 五來源 × 5 萬列 | 完成，**65 s**（準時率子集合用 `Array.includes`，O(n²)），504 MB | `TOTAL_ROWS_EXCEEDED`，0.3 s |
| 五來源各約 14 MB | 完成，78 s，**1.86 GB** RSS | `TOTAL_BYTES_EXCEEDED`，0.4 s |
| 單行 25 MiB | 解碼後才拒收，1 GB RSS | `TOTAL_BYTES_EXCEEDED`，6 ms |
| 單行 20 MiB | — | 解碼前 `LINE_TOO_LONG`，2 ms |
| 五來源合計 5 萬列（合法） | — | 完成，約 0.5 s |

原始數據：`evidence/RG-V5-01_ops-probe_RED_877525f.json`、`evidence/RG-V5-01_ops-probe_GREEN.json`。CI 每次執行 `scripts/enterprise/ci/ops-resource-probe.ts`，合法輸入未完成或超限輸入未以預期代碼拒收即失敗（耗時與 RSS 只記錄，不設門檻）。

## 結構變更

1. **有界解析**：`createOpsReportAccumulator` 逐來源累積，只保留選中列的精簡欄位；解碼前掃描 bytes 判斷單行長度與列數預算。
2. **不同時持有多份大型 Buffer**：`computeOpsReportFromStore` 依序讀 blob、驗 hash、交給累積器後即釋放；任一來源拒收即不再讀後續來源。
3. **交易持有時間**：`prepareOpsReport`（短交易）→ 交易外計算 → `commitOpsReport`（新交易，重驗 session 與權益）。計算期間不持有成員列 `FOR SHARE` 鎖，停權／改角色立即生效，commit 時回 401 且不寫入（PG 整合測試證明：在 commit 前停權 < 5 s 完成）。
4. **取消**：用戶端斷線（`res` close 且未完成）→ AbortSignal，在來源之間與 commit 前檢查；佇列中等待的請求取得名額後也先檢查。
5. **並行使用者**：行程內計算閘門（預設 2 併發／8 等待），滿了立即 429，不無限排隊。
6. **結果大小**：每主張的 `sources`／`sites`／`reasons` 與頂層 `sites`／`conflicts`／`anomalies` 最多 200 筆；新增 `sourceCount`、`sourcesTruncated` 等欄位（相容追加）。截斷時，完整來源可由綁定的來源版本 hash ＋ `sites`／週別重算。

## 未做／限制

- Worker 記憶體峰值只在本機與 CI 的引擎探針量測（子行程 maxRSS）；HTTP 層的行程峰值未在 CI 單獨量測（NOT_RUN）。
- 計算閘門是單一行程內；多副本部署需外部協調（單客戶單實例部署不受影響）。
- ACC-MATCH-v1 建立對帳仍在單一交易內讀兩個來源（各 ≤ 25 MiB，5 萬列約 0.8 s）；未改為兩階段（V4 已審程式，列為後續）。
- 快速拒絕的行為變更：多來源時只回報第一個出錯來源的錯誤（V5 會回報全部來源的錯誤）。
