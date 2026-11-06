# 後端路線圖（TUI 檢視）

> 由 `scripts/enterprise/render_roadmap.py` 依 `roadmap.json` 產生；CURRENT／NEW_IN_V5 項目的 evidence 路徑皆經存在性檢查。

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│ DHC AI Office 後端路線圖（由 roadmap.json 產生，勿手改）                       │
│                                                                                │
│ 完成度 [███████████████████████░░░░░░░░░░░░░░░░░] 13/23                        │
│ ■ CURRENT 7  ◆ NEW_IN_V5 6  □ PLANNED 6  ✕ BLOCKED_DECISION 4                  │
├────────────────────────────────────────────────────────────────────────────────┤
│ ▸ 身分與隔離                                                                   │
│   ■ ID-01   企業身分、RBAC、session epoch 撤權、legacy 路由隔離                │
│   ■ ID-02   PostgreSQL FORCE RLS（31 張表）＋每請求交易                        │
│                                                                                │
│ ▸ 文件與草稿                                                                   │
│   ■ DOC-01  文件版本、SHA-256、擷取沙箱、引用、草稿審批與匯出                  │
│                                                                                │
│ ▸ Run 與模型                                                                   │
│   ■ RUN-01  Run 冪等、取消、隔離、BYOK、egress 政策、用量帳本                  │
│                                                                                │
│ ▸ 商務權益                                                                     │
│   ■ BIZ-01  套餐、配額、到期唯讀（商務寫入政策）                               │
│                                                                                │
│ ▸ 確定性計算                                                                   │
│   ■ ACC-01  ACC-MATCH-v1 一對一確定性對帳                                      │
│   ◆ ACC-02  ACC-MATCH-v1 結構化匯出（json／csv／markdown）＋匯出紀錄（0014）   │
│   ◆ OPS-01  OPS-REPORT-v1 營運週報引擎＋API（0013）                            │
│   ◆ OPS-02  模型敘述數字守門（validateOpsNarrative）                           │
│   □ OPS-03  週報敘述生成（模型只寫文字）                                       │
│   □ OPS-04  週報送審／簽認／正式匯出（沿用草稿審批鏈）                         │
│                                                                                │
│ ▸ 可靠性與可觀測性                                                             │
│   ◆ OBS-01  低基數 metrics、結構化日誌、request id、/metrics token             │
│   □ OBS-02  OpenTelemetry 追蹤、告警與 SLO（需實測流量基線）                   │
│                                                                                │
│ ▸ 品質與 CI                                                                    │
│   ◆ QA-01   CI 基線比對器 v2（fail closed）＋5 個 legacy 失敗修復              │
│   ■ CI-01   原生 amd64／arm64 image build、SBOM、Trivy、交付冒煙               │
│   □ PERF-01 CI 效能量測：API p50／p95、5 萬列對帳、匯出耗時、記憶體            │
│                                                                                │
│ ▸ 供應鏈                                                                       │
│   ◆ SC-01   企業 runtime 移除 npm；lodash-es／nanoid 覆寫；台帳                │
│   □ SC-02   更新 RUNTIME_BASE digest（apt 2.6.2 等 OS 修補）並重跑雙架構交付   │
│                                                                                │
│ ▸ 驗收                                                                         │
│   □ UAT-01  66 項 UAT 實際執行（目前 PASS 0）                                  │
│                                                                                │
│ ▸ 待人類決策                                                                   │
│   ✕ DEC-01  條款比對功能（BLOCKED_PRODUCT_DECISION）                           │
│   ✕ DEC-02  RD-002／RD-003 契約、IP／著作權、價格與 SOW                        │
│   ✕ DEC-03  正式映像發布（GHCR）與客戶正式部署                                 │
│   ✕ DEC-04  ACC-MATCH 擴充規則（多對一、分期、退款、跨月）                     │
└────────────────────────────────────────────────────────────────────────────────┘
```

| ID | 軌道 | 項目 | 狀態 | 證據 |
|---|---|---|---|---|
| ID-01 | 身分與隔離 | 企業身分、RBAC、session epoch 撤權、legacy 路由隔離 | CURRENT | `server/modules/enterprise-persistence/enterprise-identity.service.ts`<br/>`server/modules/enterprise-api/tests/session-inflight.integration.test.ts` |
| ID-02 | 身分與隔離 | PostgreSQL FORCE RLS（31 張表）＋每請求交易 | CURRENT | `server/modules/enterprise-persistence/tests/enterprise.integration.test.ts` |
| DOC-01 | 文件與草稿 | 文件版本、SHA-256、擷取沙箱、引用、草稿審批與匯出 | CURRENT | `server/modules/enterprise-persistence/document-extraction.ts`<br/>`server/modules/enterprise-persistence/citation-integrity.ts` |
| RUN-01 | Run 與模型 | Run 冪等、取消、隔離、BYOK、egress 政策、用量帳本 | CURRENT | `server/modules/enterprise-persistence/model-gateway.ts`<br/>`server/modules/enterprise-persistence/egress-policy.ts` |
| BIZ-01 | 商務權益 | 套餐、配額、到期唯讀（商務寫入政策） | CURRENT | `server/modules/enterprise-persistence/enterprise-entitlements.ts` |
| ACC-01 | 確定性計算 | ACC-MATCH-v1 一對一確定性對帳 | CURRENT | `server/modules/enterprise-persistence/reconciliation-acc-match-v1.ts` |
| ACC-02 | 確定性計算 | ACC-MATCH-v1 結構化匯出（json／csv／markdown）＋匯出紀錄（0014） | NEW_IN_V5 | `server/modules/enterprise-persistence/reconciliation-export.ts`<br/>`server/modules/enterprise-api/tests/reconciliation-export.integration.test.ts`<br/>`db/enterprise/migrations/0014_reconciliation_exports.up.sql` |
| OPS-01 | 確定性計算 | OPS-REPORT-v1 營運週報引擎＋API（0013） | NEW_IN_V5 | `server/modules/enterprise-persistence/ops-report-v1.ts`<br/>`server/modules/enterprise-api/tests/ops-report.integration.test.ts`<br/>`db/enterprise/migrations/0013_ops_reports.up.sql` |
| OPS-02 | 確定性計算 | 模型敘述數字守門（validateOpsNarrative） | NEW_IN_V5 | `server/modules/enterprise-persistence/tests/ops-report-v1.test.ts` |
| OBS-01 | 可靠性與可觀測性 | 低基數 metrics、結構化日誌、request id、/metrics token | NEW_IN_V5 | `server/modules/enterprise-api/enterprise-observability.ts`<br/>`docs/enterprise/operations/OBSERVABILITY.md` |
| QA-01 | 品質與 CI | CI 基線比對器 v2（fail closed）＋5 個 legacy 失敗修復 | NEW_IN_V5 | `scripts/enterprise/ci/compare_known_failures.py`<br/>`scripts/enterprise/ci/test_compare_known_failures.py` |
| SC-01 | 供應鏈 | 企業 runtime 移除 npm；lodash-es／nanoid 覆寫；台帳 | NEW_IN_V5 | `docs/enterprise/supply-chain/SUPPLY_CHAIN_REMEDIATION_LEDGER.json` |
| CI-01 | 品質與 CI | 原生 amd64／arm64 image build、SBOM、Trivy、交付冒煙 | CURRENT | `deploy/customer-single/Dockerfile` |
| OPS-03 | 確定性計算 | 週報敘述生成（模型只寫文字） | PLANNED | — |
| OPS-04 | 確定性計算 | 週報送審／簽認／正式匯出（沿用草稿審批鏈） | PLANNED | — |
| OBS-02 | 可靠性與可觀測性 | OpenTelemetry 追蹤、告警與 SLO（需實測流量基線） | PLANNED | — |
| SC-02 | 供應鏈 | 更新 RUNTIME_BASE digest（apt 2.6.2 等 OS 修補）並重跑雙架構交付 | PLANNED | — |
| PERF-01 | 品質與 CI | CI 效能量測：API p50／p95、5 萬列對帳、匯出耗時、記憶體 | PLANNED | — |
| UAT-01 | 驗收 | 66 項 UAT 實際執行（目前 PASS 0） | PLANNED | — |
| DEC-01 | 待人類決策 | 條款比對功能（BLOCKED_PRODUCT_DECISION） | BLOCKED_DECISION | — |
| DEC-02 | 待人類決策 | RD-002／RD-003 契約、IP／著作權、價格與 SOW | BLOCKED_DECISION | — |
| DEC-03 | 待人類決策 | 正式映像發布（GHCR）與客戶正式部署 | BLOCKED_DECISION | — |
| DEC-04 | 待人類決策 | ACC-MATCH 擴充規則（多對一、分期、退款、跨月） | BLOCKED_DECISION | — |
