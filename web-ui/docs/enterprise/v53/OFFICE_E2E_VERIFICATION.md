# ROLL-002 Office E2E 逐項核對（run 42343824443，attempt 1）

證據檔：`evidence/OFFICE_STALE_RED_V51.json`、`evidence/OFFICE_STALE_GREEN_45713dc.json`、`evidence/OFFICE_STALE_DELIVERY_{AMD64,ARM64}.json`（原始 artifact：`office-stale-red-v51` 13562971307、`office-stale-green-current` 13562439293）。

| 檢查 | 結果 | 依據 |
|---|---|---|
| RED 使用固定 `2cc9e93` 的 image | ✅ | job 128317125314 log：`ref: 2cc9e93e…`、`HEAD is now at 2cc9e93`；image label revision＝`2cc9e93e…`，image id `sha256:ddaa5c5d…` |
| GREEN 使用 `45713dc` 的 image | ✅ | job 128317125119；image label revision＝`45713dce…`，image id `sha256:172f76ad…` |
| Chromium 實際執行 | ✅ | 兩個 job 都裝了 `chromium_headless_shell-1248`，log 中有 Chrome Headless；driver 以 Playwright 實際點擊、實際攔截網路 |
| PostgreSQL 實際寫入 | ✅ | harness 以 `psql` 直接查 `draft_revisions`／`drafts`／`approvals`／`audit_events` |
| RED 重現 A 的內容寫入 B | ✅ | `PUT drafts/<B> {expectedRevision:1, body:<A 的內容>}`；PG 中 B rev 2 的 md5＝A 的內容；`draft.revised`(B)=2 |
| RED 不同版號（丁） | ✅（伺服器擋下） | `PUT drafts/<丁> {expectedRevision:1}` 未產生新版號（丁為 rev 2） |
| RED 審批情境 | ⚠️ **只完成一部分，不算完整重現** | 負向部分：D 回 503、畫面仍顯示 C 時，按「核准」送出 `approvals/<D>/decision`，帶的是 C 的 revision 與 sha（C、D 內容相同、sha 相同），PG 中 D 變成 approved、`draft.approv*`(D)=1。正向部分：逾時（等不到「審核D」）。可能原因是 D 已被前一步錯誤核准而離開待審清單，但這只是推論、尚未證實。原始逾時紀錄保留在 `scenario_errors`。 |
| GREEN 沒有寫錯資源 | ✅ | violations 0；未就緒期間「儲存／送審／核准／退回」按鈕都不存在（attempts＝absent），沒有任何 PUT／POST |
| GREEN 正向合法儲存與核准 | ✅ | `PUT drafts/<B>`，帶 B 自己的 expectedRevision 1 與修改後內容；`approvals/<D>/decision`，帶 D 的 revision 與 sha256 |
| DB 版號／內容／approval／audit 一致 | ✅ | B 有 rev 1、2 且都≠A；revised 1、submitted 0；B 仍為 draft；D approved、C pending；決策稽核 D=1、C=0；A 只有 1 版 |
| GREEN 每個情境都完整執行 | ✅ | 6 個情境全部記錄，scenarioErrors＝[]；harness 檢查「每個情境都完整執行」通過 |
| 雙架構 delivery GREEN | ✅ | run 42343825894：amd64 8/8、arm64 8/8 |

## 判定（Builder，非獨立）
- 已確認（真實瀏覽器＋PG）：RED 草稿錯寫（同版號）、RED 審批未就緒時送出決定（D 被以 C 的內容核准），以及 GREEN 全部 6 個情境。
- 不宣稱已確認：RED 審批正向段落，因為它逾時了。
- 測試程式與受測內容在 45713dc 之後沒有變動，所以沒有重建 image。
