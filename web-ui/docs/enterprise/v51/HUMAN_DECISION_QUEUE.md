# V5.1 待人類決策

| ID | 事項 | 為何需要人 | 目前處置 |
|---|---|---|---|
| DEC-05 | OPS-REPORT 多來源合計列數的業務契約 | 規格未定義；5 萬列為工程上限 | 超過即 TOTAL_ROWS_EXCEEDED |
| SEC-01 | remote-agent `ragent_cmd` 預設提供、字面禁止清單可繞過 | 改預設或協定影響 DAS 其他用途；需模組 owner 以 Grill-Me 決策 | 未修改；提案 P1–P5 |
| SEC-02 | deid-proxy／codex-deid 大小、逾時、背壓、斷線、路徑政策 | 模組 owner 排程 | 工單 DEID-01..08 |
| SC-OWNER | 無修補的 Debian OS HIGH 風險接受 | 需具名 owner 簽認 | 隨 base digest 更新重掃 |
| DEC-07 | 被拒絕的 OPS Report 是否也去重 | 稽核保留政策 | 每次拒收留一筆 |
| UAT-EV | OP-UAT-26、OP-UAT-36、ACC-UAT-11 無證據引用 | 需確認原判定或補證據 | 索引標 EVIDENCE_MISSING |
| PERF-SLO | 效能 SLO 門檻與負載測試 | 需客戶期望與流量基線 | 只記錄不判定 |
| 既有 | 條款比對、RD-002／003、IP／授權、價格與 SOW、GHCR 發布、ACC-MATCH 擴充規則 | 見 V5 HUMAN_DECISION_QUEUE | 不變 |
