# UAT 追溯（V5）

共 66 項。來源：V4 RC 機器生成狀態＋本輪 V5 變更（`scripts/enterprise/uat_v5.py`）。**GENERIC_VERIFIED 只代表 Builder 以合成資料工程驗證，不是情境 PASS；PASS 需要真人簽認，目前 0。**

| 狀態 | V4 | V5 |
|---|---|---|
| GENERIC_VERIFIED | 38 | 42 |
| PARTIAL | 14 | 17 |
| NOT_IMPLEMENTED | 11 | 4 |
| CUSTOMER_UAT_PENDING | 3 | 3 |
| PASS | 0 | 0 |

條款比對（UAT-L03、UAT-L05）維持 **BLOCKED_PRODUCT_DECISION**（DEC-W6-SCOPE-01）。

## V5 變更列

| ID | V4 | V5 | 說明 | 證據 |
|---|---|---|---|---|
| OP-UAT-09 | PARTIAL | PARTIAL | 營運明細依明示案例集只納入 BASE 六筆（selectedRows 6／excludedRows 1）、丙站缺值旗標保留；合成事項紀錄（備註）導入仍未實作 | `server/modules/enterprise-persistence/tests/ops-report-v1.test.ts`<br/>`server/modules/enterprise-api/tests/ops-report.integration.test.ts` |
| OP-UAT-11 | NOT_IMPLEMENTED | GENERIC_VERIFIED | 移除期間或 owner 欄 → HEADER_MISMATCH 整批拒收；owner／識別欄空白 → MISSING_*；拒收留紀錄與稽核，原文件版本不變 | `server/modules/enterprise-persistence/tests/ops-report-v1.test.ts`<br/>`server/modules/enterprise-api/tests/ops-report.integration.test.ts` |
| OP-UAT-14 | NOT_IMPLEMENTED | GENERIC_VERIFIED | 確定性引擎 210／180／+30／16.67%、待辦 61／46／+15；BigInt＋最後一步 ROUND_HALF_UP；引擎不產生因果文字；與規格 oracle 逐項比對 | `server/modules/enterprise-persistence/tests/ops-report-v1.test.ts`<br/>`server/modules/enterprise-api/tests/ops-report.integration.test.ts` |
| OP-UAT-15 | NOT_IMPLEMENTED | GENERIC_VERIFIED | 甲乙 150/160＝93.75%、前週 130/140＝92.86%、差 0.89 百分點（未四捨五入比率相減）；全體 UNKNOWN；分子分母與子集合 sites 明示 | `server/modules/enterprise-persistence/tests/ops-report-v1.test.ts`<br/>`server/modules/enterprise-api/tests/ops-report.integration.test.ts` |
| OP-UAT-16 | NOT_IMPLEMENTED | PARTIAL | 缺值為 UNKNOWN（不補 0／平均／前值），原因 FIELD_UNKNOWN 指出據點與欄位、其餘主張照常；owner 需經來源列查得，未在主張直接列出，UI 未呈現 | `server/modules/enterprise-persistence/tests/ops-report-v1.test.ts` |
| OP-UAT-17 | NOT_IMPLEMENTED | PARTIAL | 同週同站 70／72 → CONFLICT、列出雙方來源、受影響主張值為空，不自動挑選；週報定稿流程尚未實作（無法驗「停止定稿」） | `server/modules/enterprise-persistence/tests/ops-report-v1.test.ts`<br/>`server/modules/enterprise-api/tests/ops-report.integration.test.ts` |
| OP-UAT-18 | PARTIAL | PARTIAL | 敘述數字守門 validateOpsNarrative 擋下引擎未產生的數字（如 35%）；但恰等於某主張值的數字擋不住（語意限制），敘述生成未實作 | `server/modules/enterprise-persistence/tests/ops-report-v1.test.ts` |
| OP-UAT-21 | NOT_IMPLEMENTED | PARTIAL | 作業分鐘以「營運負荷，非工時節省」標示，引擎不計算 ROI／節省；敘述守門擋無來源數字；ROI 要求的明確拒絕回覆未實作 | `server/modules/enterprise-persistence/tests/ops-report-v1.test.ts` |
| OP-UAT-35 | NOT_IMPLEMENTED | GENERIC_VERIFIED | 只取指定 ISO 週與前一週，其他週別列不入算（excludedRows 計數）；列的起訖與週別不符 → PERIOD_MISMATCH 拒收；結果含固定起迄、前週範圍與 Asia/Taipei | `server/modules/enterprise-persistence/tests/ops-report-v1.test.ts`<br/>`server/modules/enterprise-api/tests/ops-report.integration.test.ts` |

## 全部 66 項

| ID | V5 狀態 | 說明 |
|---|---|---|
| OP-UAT-01 | GENERIC_VERIFIED | API 登入、/identity/me；組織來自 session（BLOCKED_RD：身份主檔未批准） |
| OP-UAT-02 | GENERIC_VERIFIED | API／SEC 無憑證 401、偽造 401、legacy 403 |
| OP-UAT-03 | GENERIC_VERIFIED | API 稽核者上傳 403；PLAN 到期唯讀 402（WF） |
| OP-UAT-04 | GENERIC_VERIFIED | API／DOC／WF 跨組織 404、搜尋空、引用 404 |
| OP-UAT-05 | GENERIC_VERIFIED | WF 員工不能決定審批（403） |
| OP-UAT-06 | GENERIC_VERIFIED | API 停權後舊 token 401；SEC REVOKED_SESSION |
| OP-UAT-07 | PARTIAL | HTTP 與 Run worker 撤權已驗（API、WF）；企業模式無 WS（無長連線可測） |
| OP-UAT-08 | GENERIC_VERIFIED | SEC legacy/WS/Agent/MCP 全拒；企業無 platform 模式 |
| OP-UAT-09 | PARTIAL | 營運明細依明示案例集只納入 BASE 六筆（selectedRows 6／excludedRows 1）、丙站缺值旗標保留；合成事項紀錄（備註）導入仍未實作 |
| OP-UAT-10 | GENERIC_VERIFIED | 同內容同組織重用 blob（E05）；擷取冪等 reused（DOC） |
| OP-UAT-11 | GENERIC_VERIFIED | 移除期間或 owner 欄 → HEADER_MISMATCH 整批拒收；owner／識別欄空白 → MISSING_*；拒收留紀錄與稽核，原文件版本不變 |
| OP-UAT-12 | GENERIC_VERIFIED | E05 版本鏈、DOC 舊版 history 檢索 |
| OP-UAT-13 | GENERIC_VERIFIED | DOC 引用版本／位置／hash 驗證；「回答 210」需數值能力（見 14） |
| OP-UAT-14 | GENERIC_VERIFIED | 確定性引擎 210／180／+30／16.67%、待辦 61／46／+15；BigInt＋最後一步 ROUND_HALF_UP；引擎不產生因果文字；與規格 oracle 逐項比對 |
| OP-UAT-15 | GENERIC_VERIFIED | 甲乙 150/160＝93.75%、前週 130/140＝92.86%、差 0.89 百分點（未四捨五入比率相減）；全體 UNKNOWN；分子分母與子集合 sites 明示 |
| OP-UAT-16 | PARTIAL | 缺值為 UNKNOWN（不補 0／平均／前值），原因 FIELD_UNKNOWN 指出據點與欄位、其餘主張照常；owner 需經來源列查得，未在主張直接列出，UI 未呈現 |
| OP-UAT-17 | PARTIAL | 同週同站 70／72 → CONFLICT、列出雙方來源、受影響主張值為空，不自動挑選；週報定稿流程尚未實作（無法驗「停止定稿」） |
| OP-UAT-18 | PARTIAL | 敘述數字守門 validateOpsNarrative 擋下引擎未產生的數字（如 35%）；但恰等於某主張值的數字擋不住（語意限制），敘述生成未實作 |
| OP-UAT-19 | GENERIC_VERIFIED | 引用來源 hash 漂移後核准與匯出被拒（ENTERPRISE_CITATION_INVALID）：server/modules/enterprise-api/tests/citation-integrity.integration.test.ts（evidence/RCFIX_V3_007） |
| OP-UAT-20 | GENERIC_VERIFIED | 未核准不能匯出（WF 409）；文件內容只作資料（系統提示要求，未對 prompt injection 做評測） |
| OP-UAT-21 | PARTIAL | 作業分鐘以「營運負荷，非工時節省」標示，引擎不計算 ROI／節省；敘述守門擋無來源數字；ROI 要求的明確拒絕回覆未實作 |
| OP-UAT-22 | PARTIAL | 「無引用主張阻止定稿」已做（UNCITED／INVALID 不能送審核准匯出，server/modules/enterprise-api/tests/citation-integrity.integration.test.ts（evidence/RCFIX_V3_007））；差異檢視 UI 仍未實作 |
| OP-UAT-23 | PARTIAL | 退回 API 存在、可修改再送審；退回路徑未有自動化測試 |
| OP-UAT-24 | GENERIC_VERIFIED | 核准綁定修訂號、具名、時間、意見（WF、匯出含核准修訂） |
| OP-UAT-25 | GENERIC_VERIFIED | 自我核准 403（WF）；DB CHECK 亦禁止 |
| OP-UAT-26 | PARTIAL | 新修訂必須重新送審（狀態機）；「V2 重新 PENDING」未有專門測試 |
| OP-UAT-27 | GENERIC_VERIFIED | 未核准匯出 409（WF） |
| OP-UAT-28 | GENERIC_VERIFIED | 匯出內容＝核准修訂、含來源附錄、SHA 標頭與 draft_exports（WF、DLV） |
| OP-UAT-29 | PARTIAL | Run 冪等（WF）；匯出每次記一筆（可辨識），無冪等鍵 |
| OP-UAT-30 | GENERIC_VERIFIED | 全鏈稽核事件（DLV、API） |
| OP-UAT-31 | GENERIC_VERIFIED | 員工讀稽核 403；runtime 無 UPDATE/DELETE audit（E02b） |
| OP-UAT-32 | GENERIC_VERIFIED | Run 重試／逾時（WF）；備份還原（DLV） |
| OP-UAT-33 | NOT_IMPLEMENTED | 完成率／修正率／工時量測 |
| OP-UAT-34 | CUSTOMER_UAT_PENDING | 需真人操作與回饋 |
| OP-UAT-35 | GENERIC_VERIFIED | 只取指定 ISO 週與前一週，其他週別列不入算（excludedRows 計數）；列的起訖與週別不符 → PERIOD_MISMATCH 拒收；結果含固定起迄、前週範圍與 Asia/Taipei |
| OP-UAT-36 | GENERIC_VERIFIED | 本矩陣與 GATE_BOARD 區分 fixture／系統／歷史 |
| ACC-UAT-01 | GENERIC_VERIFIED | 兩份 CSV 以文件版本導入，結果顯示 9＋9 列與兩個版本 hash；同版重送回原結果（reused），不變 18＋18：server/modules/enterprise-api/tests/reconciliation.integration.test.ts（真 PG＋HTTP） |
| ACC-UAT-02 | GENERIC_VERIFIED | 非整數、空值、負值、指數、未知幣別、跨組織、重複資料列ID、期間外／不存在日期、欄名錯誤、小數位數不符 → 整批拒收、逐行原因、無部分案件：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（對 預期對帳結果.csv／來源行索引.csv 逐欄）；server/modules/enterprise-api/tests/reconciliation.integration.test.ts（真 PG＋HTTP） |
| ACC-UAT-03 | GENERIC_VERIFIED | 恰 3 個完全匹配，TWD 350000／USD 12345 分列，逐列來源可見：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（對 預期對帳結果.csv／來源行索引.csv 逐欄）；server/modules/enterprise-api/tests/reconciliation.integration.test.ts（真 PG＋HTTP）；tests/enterprise/e2e/office_e2e.mjs「W6-B 對帳」步驟（真瀏覽器，見交付驗證證據） |
| ACC-UAT-04 | GENERIC_VERIFIED | 003 缺收款明細、009 缺內部單據，差額留空（不補 0），不自動建單：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（對 預期對帳結果.csv／來源行索引.csv 逐欄）；tests/enterprise/e2e/office_e2e.mjs「W6-B 對帳」步驟（真瀏覽器，見交付驗證證據） |
| ACC-UAT-05 | GENERIC_VERIFIED | 004：80000 對 75000，差額 -5000 最小單位，不判定原因：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（對 預期對帳結果.csv／來源行索引.csv 逐欄）；server/modules/enterprise-api/tests/reconciliation.integration.test.ts（真 PG＋HTTP）；tests/enterprise/e2e/office_e2e.mjs「W6-B 對帳」步驟（真瀏覽器，見交付驗證證據） |
| ACC-UAT-06 | GENERIC_VERIFIED | 005 幣別不一致、差額空白、原值保留；數字相等但幣別不同的變體同樣判不一致；無匯率：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（對 預期對帳結果.csv／來源行索引.csv 逐欄） |
| ACC-UAT-07 | GENERIC_VERIFIED | 006 單據ID重複、007 收款ID重複，相關 6 列整組隔離、不選首列、不加總進完全匹配；同側混幣改判未支援：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（對 預期對帳結果.csv／來源行索引.csv 逐欄）；tests/enterprise/e2e/office_e2e.mjs「W6-B 對帳」步驟（真瀏覽器，見交付驗證證據） |
| ACC-UAT-08 | PARTIAL | 草稿引用可驗（WF、DOC）；月報數值需對帳引擎 |
| ACC-UAT-09 | PARTIAL | 系統提示要求只依來源；無 prompt-injection 評測 |
| ACC-UAT-10 | GENERIC_VERIFIED | 員工不能核准；退回保留理由（API 存在） |
| ACC-UAT-11 | PARTIAL | 修訂需重新送審；「改版使舊簽認失效」未專測 |
| ACC-UAT-12 | GENERIC_VERIFIED | 無核准不能匯出（WF） |
| ACC-UAT-13 | GENERIC_VERIFIED | 跨組織、撤權（API、WF、SEC） |
| ACC-UAT-14 | GENERIC_VERIFIED | 稽核鏈與匯出 hash（DLV） |
| ACC-UAT-15 | NOT_IMPLEMENTED | KPI 計算 |
| UAT-L01 | PARTIAL | 兩版上傳與 hash（E05、DOC）；「基線／候選」指定與條款比對未實作 |
| UAT-L02 | GENERIC_VERIFIED | 重送相同內容去重、版本鏈（E05） |
| UAT-L03 | NOT_IMPLEMENTED | 條款逐條比對：DEC-W6-SCOPE-01 使用者決定本輪不做（BLOCKED_PRODUCT_DECISION） |
| UAT-L04 | PARTIAL | 引用版本／位置／hash（DOC）；clause ID 解析未實作 |
| UAT-L05 | NOT_IMPLEMENTED | 矛盾標記阻止輸出：DEC-W6-SCOPE-01 本輪不做（BLOCKED_PRODUCT_DECISION） |
| UAT-L06 | GENERIC_VERIFIED | 錯 hash（expectedSha256 不符 400）、未知版本 404（API、E05） |
| UAT-L07 | PARTIAL | 不存在的引用編號（如 [999]）阻擋送審（server/modules/enterprise-api/tests/citation-integrity.integration.test.ts（evidence/RCFIX_V3_007））；條款 ID 層級的「不存在條款」檢查仍未實作 |
| UAT-L08 | GENERIC_VERIFIED | 送審前伺服器自動核對每個 [n] 與 metadata、來源存在、版本與 hash：server/modules/enterprise-api/tests/citation-integrity.integration.test.ts（evidence/RCFIX_V3_007） |
| UAT-L09 | GENERIC_VERIFIED | 跨組織、API key／Agent 入口（SEC、API） |
| UAT-L10 | GENERIC_VERIFIED | 未核准匯出 409、員工不能核准（WF） |
| UAT-L11 | CUSTOMER_UAT_PENDING | 真人逐條覆核 |
| UAT-L12 | PARTIAL | 匯出可回查引用（WF）；覆核摘要格式未實作 |
| UAT-L13 | GENERIC_VERIFIED | 停權後 HTTP／Run 拒絕（API、WF）；企業模式無 WS |
| UAT-L14 | GENERIC_VERIFIED | Run 取消／逾時／重試（WF）；備份還原（DLV） |
| UAT-L15 | CUSTOMER_UAT_PENDING | 非技術 reviewer 獨立完成與簽認 |
