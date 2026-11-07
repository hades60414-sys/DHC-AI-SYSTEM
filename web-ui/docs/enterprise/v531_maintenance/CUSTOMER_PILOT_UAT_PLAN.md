# 客戶試點 UAT 執行準備（沿用既有 66 項）

> **這份文件不是 UAT 結果。** 表中的「工程狀態」是合成環境的工程判定，**不能轉成客戶 PASS**。客戶 PASS 必須由試點組織中具權限的真人簽認。目前 PASS＝0（`CUSTOMER_UAT_NOT_APPROVED`）。

## 最小試點流程
1. **前置準備**
   - 試點環境：客戶核准的主機，或隔離的試點主機；不使用 Astra 的 QA VM。
   - 部署：用固定 image 部署。digest 見 `v53/SUPPLY_CHAIN_PROVENANCE.json`；如果採用 GHCR 封存，則改用封存的 digest。
   - 帳號：用 `dhc-office.py bootstrap` 建立試點組織，並為管理員、營運人員、會計人員、審核者、員工各開 1 個帳號。
   - 資料：客戶提供去識別後的試點資料；另放一組合成對照資料（golden），用來辨別問題出在環境還是資料。
   - 部署前先完成一次 backup。
2. **執行**：依下表分層執行，T1 → T2。每一項都要保存截圖、API 回應與稽核事件匯出，放在客戶受控位置；不得放進公開 repo。
3. **簽認**：每項由對應角色的真人勾選結果並簽名。整份由客戶專案負責人總簽。
4. **失敗與回退**
   - 單項 FAIL：記錄 issue（重現步驟、資料版本、image digest），不得修改資料讓它「變成 PASS」。
   - 阻斷型 FAIL（資料錯誤或權限越界）：立即停止試點，用 `dhc-office.py restore` 還原到部署前的 backup；或依 upgrade-rollback 驗證過的流程回退到前一版 image。
   - 修補後要以新的 image digest 重跑受影響的項目，不沿用舊簽認。
5. **結案**：彙整成試點報告（受控位置）。commercial release 仍要另行決策。

## 分層統計

- T1 客戶專屬（只能客戶執行）：3
- T1 試點必測：42
- T2 試點測（已知缺口需事先揭露）：17
- 排除（BLOCKED_PRODUCT_DECISION）：2
- 排除（未實作）：2

## 66 項執行表

| ID | 分層 | 操作角色 | 前置資料 | 測試情境／Expected Result（取自既有 UAT 描述） | 工程狀態 | Evidence | 客戶簽認 | 失敗處理 |
|---|---|---|---|---|---|---|---|---|
| OP-UAT-01 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | API 登入、/identity/me；組織來自 session（BLOCKED_RD：身份主檔未批准） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-02 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | API／SEC 無憑證 401、偽造 401、legacy 403 | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-03 | T1 試點必測 | 稽核員／管理員 | 客戶提供的試點資料（去識別）＋合成對照組 | API 稽核者上傳 403；PLAN 到期唯讀 402（WF） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-04 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | API／DOC／WF 跨組織 404、搜尋空、引用 404 | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-05 | T1 試點必測 | 員工（staff） | 客戶提供的試點資料（去識別）＋合成對照組 | WF 員工不能決定審批（403） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-06 | T1 試點必測 | 組織管理員 | 客戶提供的試點資料（去識別）＋合成對照組 | API 停權後舊 token 401；SEC REVOKED_SESSION | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-07 | T2 試點測（已知缺口需事先揭露） | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | HTTP 與 Run worker 撤權已驗（API、WF）；企業模式無 WS（無長連線可測） | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-08 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | SEC legacy/WS/Agent/MCP 全拒；企業無 platform 模式 | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-09 | T2 試點測（已知缺口需事先揭露） | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 營運明細依明示案例集只納入 BASE 六筆（selectedRows 6／excludedRows 1）、丙站缺值旗標保留；合成事項紀錄（備註）導入仍未實作 | PARTIAL（工程，非客戶判定） | server/modules/enterprise-persistence/tests/ops-report-v1.test.ts；server/modules/enterprise-api/tests/ops-report.integra | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-10 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 同內容同組織重用 blob（E05）；擷取冪等 reused（DOC） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-11 | T1 試點必測 | 稽核員／管理員 | 客戶提供的試點資料（去識別）＋合成對照組 | 移除期間或 owner 欄 → HEADER_MISMATCH 整批拒收；owner／識別欄空白 → MISSING_*；拒收留紀錄與稽核，原文件版本不變 | GENERIC_VERIFIED（工程，非客戶判定） | server/modules/enterprise-persistence/tests/ops-report-v1.test.ts；server/modules/enterprise-api/tests/ops-report.integra | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-12 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | E05 版本鏈、DOC 舊版 history 檢索 | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-13 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | DOC 引用版本／位置／hash 驗證；「回答 210」需數值能力（見 14） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-14 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 確定性引擎 210／180／+30／16.67%、待辦 61／46／+15；BigInt＋最後一步 ROUND_HALF_UP；引擎不產生因果文字；與規格 oracle 逐項比對 | GENERIC_VERIFIED（工程，非客戶判定） | server/modules/enterprise-persistence/tests/ops-report-v1.test.ts；server/modules/enterprise-api/tests/ops-report.integra | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-15 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 甲乙 150/160＝93.75%、前週 130/140＝92.86%、差 0.89 百分點（未四捨五入比率相減）；全體 UNKNOWN；分子分母與子集合 sites 明示 | GENERIC_VERIFIED（工程，非客戶判定） | server/modules/enterprise-persistence/tests/ops-report-v1.test.ts；server/modules/enterprise-api/tests/ops-report.integra | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-16 | T2 試點測（已知缺口需事先揭露） | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 缺值為 UNKNOWN（不補 0／平均／前值），原因 FIELD_UNKNOWN 指出據點與欄位、其餘主張照常；owner 需經來源列查得，未在主張直接列出，UI 未呈現 | PARTIAL（工程，非客戶判定） | server/modules/enterprise-persistence/tests/ops-report-v1.test.ts | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-17 | T2 試點測（已知缺口需事先揭露） | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 同週同站 70／72 → CONFLICT、列出雙方來源、受影響主張值為空，不自動挑選；週報定稿流程尚未實作（無法驗「停止定稿」） | PARTIAL（工程，非客戶判定） | server/modules/enterprise-persistence/tests/ops-report-v1.test.ts；server/modules/enterprise-api/tests/ops-report.integra | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-18 | T2 試點測（已知缺口需事先揭露） | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 敘述數字守門 validateOpsNarrative 擋下引擎未產生的數字（如 35%）；但恰等於某主張值的數字擋不住（語意限制），敘述生成未實作 | PARTIAL（工程，非客戶判定） | server/modules/enterprise-persistence/tests/ops-report-v1.test.ts | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-19 | T1 試點必測 | 審核者（approver） | 客戶提供的試點資料（去識別）＋合成對照組 | 引用來源 hash 漂移後核准與匯出被拒（ENTERPRISE_CITATION_INVALID）：server/modules/enterprise-api/tests/citation-integrity.integration.test.ts（evidence/RCFIX_V3_007） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-20 | T1 試點必測 | 審核者（approver） | 客戶提供的試點資料（去識別）＋合成對照組 | 未核准不能匯出（WF 409）；文件內容只作資料（系統提示要求，未對 prompt injection 做評測） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-21 | T2 試點測（已知缺口需事先揭露） | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 作業分鐘以「營運負荷，非工時節省」標示，引擎不計算 ROI／節省；敘述守門擋無來源數字；ROI 要求的明確拒絕回覆未實作 | PARTIAL（工程，非客戶判定） | server/modules/enterprise-persistence/tests/ops-report-v1.test.ts | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-22 | T2 試點測（已知缺口需事先揭露） | 審核者（approver） | 客戶提供的試點資料（去識別）＋合成對照組 | 「無引用主張阻止定稿」已做（UNCITED／INVALID 不能送審核准匯出，server/modules/enterprise-api/tests/citation-integrity.integration.test.ts（evidence/RCFIX_V3_007））；差異檢視 UI 仍未實作 | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-23 | T2 試點測（已知缺口需事先揭露） | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 退回 API 存在、可修改再送審；退回路徑未有自動化測試 | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-24 | T1 試點必測 | 審核者（approver） | 客戶提供的試點資料（去識別）＋合成對照組 | 核准綁定修訂號、具名、時間、意見（WF、匯出含核准修訂） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-25 | T1 試點必測 | 審核者（approver） | 客戶提供的試點資料（去識別）＋合成對照組 | 自我核准 403（WF）；DB CHECK 亦禁止 | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-26 | T2 試點測（已知缺口需事先揭露） | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 新修訂必須重新送審（狀態機）；「V2 重新 PENDING」未有專門測試 | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-27 | T1 試點必測 | 審核者（approver） | 客戶提供的試點資料（去識別）＋合成對照組 | 未核准匯出 409（WF） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-28 | T1 試點必測 | 審核者（approver） | 客戶提供的試點資料（去識別）＋合成對照組 | 匯出內容＝核准修訂、含來源附錄、SHA 標頭與 draft_exports（WF、DLV） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-29 | T2 試點測（已知缺口需事先揭露） | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | Run 冪等（WF）；匯出每次記一筆（可辨識），無冪等鍵 | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-30 | T1 試點必測 | 稽核員／管理員 | 客戶提供的試點資料（去識別）＋合成對照組 | 全鏈稽核事件（DLV、API） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-31 | T1 試點必測 | 員工（staff） | 客戶提供的試點資料（去識別）＋合成對照組 | 員工讀稽核 403；runtime 無 UPDATE/DELETE audit（E02b） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-32 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | Run 重試／逾時（WF）；備份還原（DLV） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-33 | 排除（未實作） | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 完成率／修正率／工時量測 | NOT_IMPLEMENTED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-34 | T1 客戶專屬（只能客戶執行） | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 需真人操作與回饋 | CUSTOMER_UAT_PENDING（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-35 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 只取指定 ISO 週與前一週，其他週別列不入算（excludedRows 計數）；列的起訖與週別不符 → PERIOD_MISMATCH 拒收；結果含固定起迄、前週範圍與 Asia/Taipei | GENERIC_VERIFIED（工程，非客戶判定） | server/modules/enterprise-persistence/tests/ops-report-v1.test.ts；server/modules/enterprise-api/tests/ops-report.integra | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| OP-UAT-36 | T1 試點必測 | 營運人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 本矩陣與 GATE_BOARD 區分 fixture／系統／歷史 | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-01 | T1 試點必測 | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 兩份 CSV 以文件版本導入，結果顯示 9＋9 列與兩個版本 hash；同版重送回原結果（reused），不變 18＋18：server/modules/enterprise-api/tests/reconciliation.integration.test.ts（真 PG＋HTTP） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-02 | T1 試點必測 | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 非整數、空值、負值、指數、未知幣別、跨組織、重複資料列ID、期間外／不存在日期、欄名錯誤、小數位數不符 → 整批拒收、逐行原因、無部分案件：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（ | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-03 | T1 試點必測 | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 恰 3 個完全匹配，TWD 350000／USD 12345 分列，逐列來源可見：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（對 預期對帳結果.csv／來源行索引.csv 逐欄）；se | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-04 | T1 試點必測 | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 003 缺收款明細、009 缺內部單據，差額留空（不補 0），不自動建單：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（對 預期對帳結果.csv／來源行索引.csv 逐欄）；tests/ | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-05 | T1 試點必測 | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 004：80000 對 75000，差額 -5000 最小單位，不判定原因：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（對 預期對帳結果.csv／來源行索引.csv 逐欄）；serve | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-06 | T1 試點必測 | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 005 幣別不一致、差額空白、原值保留；數字相等但幣別不同的變體同樣判不一致；無匯率：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（對 預期對帳結果.csv／來源行索引.csv 逐欄） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-07 | T1 試點必測 | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 006 單據ID重複、007 收款ID重複，相關 6 列整組隔離、不選首列、不加總進完全匹配；同側混幣改判未支援：server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts（對 預期對帳結果.csv／ | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-08 | T2 試點測（已知缺口需事先揭露） | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 草稿引用可驗（WF、DOC）；月報數值需對帳引擎 | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-09 | T2 試點測（已知缺口需事先揭露） | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 系統提示要求只依來源；無 prompt-injection 評測 | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-10 | T1 試點必測 | 員工（staff） | 客戶提供的試點資料（去識別）＋合成對照組 | 員工不能核准；退回保留理由（API 存在） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-11 | T2 試點測（已知缺口需事先揭露） | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 修訂需重新送審；「改版使舊簽認失效」未專測 | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-12 | T1 試點必測 | 審核者（approver） | 客戶提供的試點資料（去識別）＋合成對照組 | 無核准不能匯出（WF） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-13 | T1 試點必測 | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | 跨組織、撤權（API、WF、SEC） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-14 | T1 試點必測 | 稽核員／管理員 | 客戶提供的試點資料（去識別）＋合成對照組 | 稽核鏈與匯出 hash（DLV） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| ACC-UAT-15 | 排除（未實作） | 會計人員 | 客戶提供的試點資料（去識別）＋合成對照組 | KPI 計算 | NOT_IMPLEMENTED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L01 | T2 試點測（已知缺口需事先揭露） | 業務使用者 | 試點組織帳號（各角色各 1） | 兩版上傳與 hash（E05、DOC）；「基線／候選」指定與條款比對未實作 | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L02 | T1 試點必測 | 業務使用者 | 試點組織帳號（各角色各 1） | 重送相同內容去重、版本鏈（E05） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L03 | 排除（BLOCKED_PRODUCT_DECISION） | 業務使用者 | 試點組織帳號（各角色各 1） | 條款逐條比對：DEC-W6-SCOPE-01 使用者決定本輪不做（BLOCKED_PRODUCT_DECISION） | NOT_IMPLEMENTED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L04 | T2 試點測（已知缺口需事先揭露） | 業務使用者 | 試點組織帳號（各角色各 1） | 引用版本／位置／hash（DOC）；clause ID 解析未實作 | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L05 | 排除（BLOCKED_PRODUCT_DECISION） | 業務使用者 | 試點組織帳號（各角色各 1） | 矛盾標記阻止輸出：DEC-W6-SCOPE-01 本輪不做（BLOCKED_PRODUCT_DECISION） | NOT_IMPLEMENTED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L06 | T1 試點必測 | 業務使用者 | 試點組織帳號（各角色各 1） | 錯 hash（expectedSha256 不符 400）、未知版本 404（API、E05） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L07 | T2 試點測（已知缺口需事先揭露） | 業務使用者 | 試點組織帳號（各角色各 1） | 不存在的引用編號（如 [999]）阻擋送審（server/modules/enterprise-api/tests/citation-integrity.integration.test.ts（evidence/RCFIX_V3_007））；條款 ID 層級的「不存在條款」檢查仍未實作 | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L08 | T1 試點必測 | 業務使用者 | 試點組織帳號（各角色各 1） | 送審前伺服器自動核對每個 [n] 與 metadata、來源存在、版本與 hash：server/modules/enterprise-api/tests/citation-integrity.integration.test.ts（evidence/RCFIX_V3_007） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L09 | T1 試點必測 | 業務使用者 | 試點組織帳號（各角色各 1） | 跨組織、API key／Agent 入口（SEC、API） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L10 | T1 試點必測 | 員工（staff） | 試點組織帳號（各角色各 1） | 未核准匯出 409、員工不能核准（WF） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L11 | T1 客戶專屬（只能客戶執行） | 業務使用者 | 試點組織帳號（各角色各 1） | 真人逐條覆核 | CUSTOMER_UAT_PENDING（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L12 | T2 試點測（已知缺口需事先揭露） | 業務使用者 | 試點組織帳號（各角色各 1） | 匯出可回查引用（WF）；覆核摘要格式未實作 | PARTIAL（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L13 | T1 試點必測 | 組織管理員 | 試點組織帳號（各角色各 1） | 停權後 HTTP／Run 拒絕（API、WF）；企業模式無 WS | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L14 | T1 試點必測 | 業務使用者 | 試點組織帳號（各角色各 1） | Run 取消／逾時／重試（WF）；備份還原（DLV） | GENERIC_VERIFIED（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |
| UAT-L15 | T1 客戶專屬（只能客戶執行） | 非技術 reviewer | 試點組織帳號（各角色各 1） | 非技術 reviewer 獨立完成與簽認 | CUSTOMER_UAT_PENDING（工程，非客戶判定） | 試點時截圖＋稽核事件匯出＋API 回應 | ☐ PASS ☐ FAIL ☐ N/A　簽認人：＿＿ 日期：＿＿ | FAIL→記錄 issue、保留資料、依 §回退 |

## 總簽

| 項目 | 內容 |
|---|---|
| 試點組織 |  |
| image digest（amd64／arm64） |  |
| 執行期間 |  |
| T1 結果（PASS／FAIL／N/A 件數） |  |
| T2 結果與已揭露缺口 |  |
| 客戶專案負責人簽認 |  |
| 日期 |  |
