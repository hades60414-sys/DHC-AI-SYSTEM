# V5.3 WP5 剩餘產品化閘門——決策提案（不核准、不代簽）

> 本文件只陳述選項與 Builder 建議；**所有項目狀態維持 PENDING**，需具名人類 owner 決策。
> 公開 Repo：本文件不含價格數字、客戶名稱、內部策略或個人資訊；具體商務內容只放受控交接位置。
> Builder 未修改 remote-agent／DeID 程式碼。

| ID | 事項 | 選項 | Builder 建議（非核准） | 決策者 | 狀態 |
|---|---|---|---|---|---|
| SEC-01 | remote-agent `ragent_cmd` 預設暴露給模型、字面禁止清單可繞過 | P1 預設關閉＋顯式啟用；P2 allowlist 指令；P3 每次人工確認；P4 僅限隔離 sandbox；P5 維持現狀＋風險接受 | P1＋P2 組合；變更需 DAS 其他用途的回歸清單 | remote-agent 模組 owner／Security | PENDING |
| SEC-02 | deid-proxy／codex-deid：DEID-01..08（大小、逾時、背壓、斷線、路徑）＋DEID-09（KEEP 規則穿透 arguments，ROLL-012）＋DEID-10（未知 block 原樣外送，ROLL-013） | 依工單逐項修；或先以 fail-closed（未知 block 拒送）止血 | DEID-10 先 fail-closed；其餘依工單排程，每項附 RED/GREEN | DeID 模組 owner（TAS Team） | PENDING（工單見 v52/DEID_WORK_ORDERS_ADDENDUM.md） |
| DEC-05 | OPS-REPORT 多來源合計列數上限（工程上限 5 萬列／25 MiB） | 維持 5 萬；依客戶資料量調整；改串流架構 | 維持 5 萬直到有客戶基線；V5.3 已量測 5 萬列同站衝突 CPU／RSS／延遲（見 v53 ACC_OPS_GOLDEN_RESULTS.md） | 產品 owner | PENDING |
| DEC-07 | 被拒絕的 OPS Report 是否也去重 | 每次拒收留一筆（現狀）；同內容去重 | 維持現狀（稽核完整性優先），保留期限另訂 | 稽核／法遵 owner | PENDING |
| SC-OWNER | 無修補的 Debian OS HIGH 風險接受 | 具名 owner＋期限接受；換 base image；等待上游 | 具名 owner＋90 天重評期限，base digest 每次更新重掃 | Security owner | PENDING |
| UAT-66 | 66 項 UAT 實際執行（目前 PASS 0） | 客戶環境執行；合成環境預演 | 先合成環境預演，正式結果只能由客戶 UAT 產生 | 客戶／專案 owner | PENDING（Builder 不得宣稱 UAT 通過） |
| RD-002／RD-003 | 未批准契約 | — | Builder 不更動契約；待 RD 決策 | RD owner | PENDING |
| IP／AGPL／SDK／DAS | 上游授權、AGPL 義務、SDK 條款、DAS 歸屬 | 法務審閱後決定散布方式 | 正式散布前完成授權盤點與法務簽核 | Legal | PENDING |
| SOW／價格／到期／維護 | 商務條件 | — | 只在受控位置討論；Repo 內不放數字 | Business owner | PENDING |

## 不變的限制
- 不 Merge、不 Release、不部署客戶環境；正式獨立驗收只能來自 Astra 的收據。
- 任何會改變會計規則版本的決策需另立 ADR。
