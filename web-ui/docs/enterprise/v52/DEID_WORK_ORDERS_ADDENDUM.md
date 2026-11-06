# V5.2｜去識別代理工單補充（ASTRA-ROLL-012／013、RG-002）

> 模組屬 TAS Team（`web-ops/deid-proxy`、`tools/codex-deid`），不在 Enterprise 產品範圍（不在 enterprise image 內，見 `.github/repo-coverage-contract.json`）。依先前指示不直接重構，只交可執行工單。V5.1 的 DEID-01..08（大小、逾時、背壓、斷線、header、路徑、稽核輪替）即 RG-002，維持有效。

| ID | 來源 | 問題（依程式） | 工單 | 驗收（合成資料、本機 collector） |
|---|---|---|---|---|
| DEID-09 | ASTRA-ROLL-012 | `tools/codex-deid/server.cjs:24,35`：`KEEP` 欄名集合（`name`、`id`、`model`…）是全域的；`arguments` 被解析成 JSON 後遞迴時仍套用 `KEEP`，業務 JSON 中鍵名為 `name`／`id` 的值原文外送 | `KEEP` 只套用在 Responses API envelope 的已知位置；`arguments`／tool 輸入等業務 JSON 一律遞迴去識別；無法解析的 `arguments` 文字整段去識別 | `function_call.arguments={"name":"合成人名","id":"合成識別號"}` → upstream collector 收不到原值；envelope 的 `type`／`call_id`／工具名稱保留 |
| DEID-10 | ASTRA-ROLL-013 | `web-ops/deid-proxy/deid.cjs`：未識別的 content block 只計數（UNSCANNED）後原樣回傳，server 照樣轉送 | 明定支援的 block 型別清單與版本；未知且可能含文字的 block 預設 **fail-closed**（拒絕或改為提示文字）；只有政策明示允許時放行並記稽核 | 合成未知 block（含文字）→ 請求被拒或內容被替換，collector 收不到原文；text／tool_use／tool_result／image 型別回歸不變 |

需要模組 owner 指派與排程（HUMAN_DECISION_QUEUE：SEC-02）；未知 block 的資料政策需 RD 決定。
