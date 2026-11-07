# 後端路線圖（TUI 檢視）

> 由 `scripts/enterprise/render_roadmap.py` 依 `roadmap.json` 產生；CURRENT／NEW_IN_V5／NEW_IN_V51／NEW_IN_V52／NEW_IN_V53 項目的 evidence 路徑皆經存在性檢查。

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│ DHC AI Office 後端路線圖（由 roadmap.json 產生，勿手改）                       │
│                                                                                │
│ 完成度 [████████████████████████████░░░░░░░░░░░░] 29/42                        │
│ ■ CURRENT 7  ◆ V5 6  ◇ V5.1 6  ◈ V5.2 5  ◉ V5.3 5  □ PLANNED 6  ✕ BLOCKED 7    │
├────────────────────────────────────────────────────────────────────────────────┤
│ ▸ 身分與隔離                                                                   │
│   ■ ID-01   企業身分、RBAC、session epoch 撤權、legacy 路由隔離                │
│   ■ ID-02   PostgreSQL FORCE RLS（31 張表）＋每請求交易                        │
│                                                                                │
│ ▸ 文件與草稿                                                                   │
│   ■ DOC-01  文件版本、SHA-256、擷取沙箱、引用、草稿審批與匯出                  │
│   ◇ RG-03   blob 串流完整性驗證（匯出不再整份讀入）                            │
│   ◈ V52-OFFICE ROLL-002：Office 詳細資料綁定目前資源、ready 才可寫入／審批     │
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
│   ◇ RG-01   OPS-REPORT 資源邊界：合計列數／bytes／單行上限、結果大小有界、交…  │
│   ◇ RG-02   CSV 公式注入（拒收結果 rowId 可達）防護＋LibreOffice 實測          │
│   □ OPS-03  週報敘述生成（模型只寫文字）                                       │
│   □ OPS-04  週報送審／簽認／正式匯出（沿用草稿審批鏈）                         │
│   ◈ V52-DATA ROLL-003／004／005／006／011：分側隔離合計、RFC4180 嚴格 CSV、幣… │
│                                                                                │
│ ▸ 可靠性與可觀測性                                                             │
│   ◆ OBS-01  低基數 metrics、結構化日誌、request id、/metrics token             │
│   □ OBS-02  OpenTelemetry 追蹤、告警與 SLO（需實測流量基線）                   │
│                                                                                │
│ ▸ 品質與 CI                                                                    │
│   ◆ QA-01   CI 基線比對器 v2（fail closed）＋5 個 legacy 失敗修復              │
│   ■ CI-01   原生 amd64／arm64 image build、SBOM、Trivy、交付冒煙               │
│   ◇ UPG-01  V4→V5.1 升級與回退在 GitHub Actions 原生 amd64 執行                │
│   ◈ V52-CI  ROLL-001／008／009：bash pipefail、gate.sh 三段退出碼、runner exi… │
│   ◈ V52-DEPLOY ROLL-007／RG-007：離線 image reference 一致、OCI source 指實際… │
│   ◈ V52-REPO RG-003：全 repository 覆蓋契約與靜態語法 job                      │
│   ◉ V53-E2E ROLL-002 真 Chromium＋PostgreSQL 切換 E2E：RED（V5.1）／GREEN（本… │
│   ◉ V53-NEG ROLL-001／008／009 GitHub 負向閘門證據：11 案例、無 continue-on-e… │
│   ◉ V53-COORD Builder／Auditor 共享狀態：STATE／FINDING_LEDGER＋CI schema 檢…  │
│   □ PERF-01 CI 效能：端到端報表／匯出 p50／p95 已量（NEW_IN_V51）；多用戶負載… │
│   □ PERF-02 多用戶併發負載、長時間 soak、arm64 升級回退                        │
│                                                                                │
│ ▸ 供應鏈                                                                       │
│   ◆ SC-01   企業 runtime 移除 npm；lodash-es／nanoid 覆寫；台帳                │
│   ◇ SC-02   更新 runtime／build base digest（node:22-bookworm[-slim] 2026-11-… │
│                                                                                │
│ ▸ 驗收                                                                         │
│   ◇ RG-04   66 項 UAT 機械化證據索引（LINKED_TEST／FILE_LEVEL／EVIDENCE_MISSI… │
│   □ UAT-01  66 項 UAT 實際執行（目前 PASS 0）                                  │
│                                                                                │
│ ▸ 會計對帳                                                                     │
│   ◉ V53-ACC 跨側同列 ID 手算 golden＋真 PG JSON／CSV／Markdown 一致            │
│                                                                                │
│ ▸ 營運報表                                                                     │
│   ◉ V53-OPS 用戶端中止請求不寫入；5 萬列同站衝突 CPU／RSS／延遲量測            │
│                                                                                │
│ ▸ 待人類決策                                                                   │
│   ✕ DEC-01  條款比對功能（BLOCKED_PRODUCT_DECISION）                           │
│   ✕ DEC-02  RD-002／RD-003 契約、IP／著作權、價格與 SOW                        │
│   ✕ DEC-03  正式映像發布（GHCR）與客戶正式部署                                 │
│   ✕ DEC-04  ACC-MATCH 擴充規則（多對一、分期、退款、跨月）                     │
│   ✕ SEC-01  remote-agent cmd-run 預設暴露給模型、字面禁止清單可繞過（需模組 o… │
│   ✕ SEC-02  deid-proxy／codex-deid：大小／逾時／背壓／斷線／路徑（RG-002）＋K… │
│   ✕ DEC-05  OPS-REPORT 多來源合計列數的業務契約（目前工程上限 5 萬）           │
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
| RG-01 | 確定性計算 | OPS-REPORT 資源邊界：合計列數／bytes／單行上限、結果大小有界、交易外計算、併發閘門 | NEW_IN_V51 | `server/modules/enterprise-persistence/ops-report-runner.ts`<br/>`server/modules/enterprise-persistence/tests/ops-report-limits.test.ts`<br/>`scripts/enterprise/ci/ops-resource-probe.ts` |
| RG-02 | 確定性計算 | CSV 公式注入（拒收結果 rowId 可達）防護＋LibreOffice 實測 | NEW_IN_V51 | `server/modules/enterprise-persistence/reconciliation-export.ts`<br/>`scripts/enterprise/ci/check_spreadsheet_import.py` |
| RG-03 | 文件與草稿 | blob 串流完整性驗證（匯出不再整份讀入） | NEW_IN_V51 | `server/modules/enterprise-persistence/document-blob-store.ts` |
| RG-04 | 驗收 | 66 項 UAT 機械化證據索引（LINKED_TEST／FILE_LEVEL／EVIDENCE_MISSING） | NEW_IN_V51 | `scripts/enterprise/uat_evidence_index.py`<br/>`docs/enterprise/uat/UAT_EVIDENCE_INDEX.json` |
| UPG-01 | 品質與 CI | V4→V5.1 升級與回退在 GitHub Actions 原生 amd64 執行 | NEW_IN_V51 | `scripts/enterprise/ci/upgrade_rollback.py` |
| OPS-03 | 確定性計算 | 週報敘述生成（模型只寫文字） | PLANNED | — |
| OPS-04 | 確定性計算 | 週報送審／簽認／正式匯出（沿用草稿審批鏈） | PLANNED | — |
| OBS-02 | 可靠性與可觀測性 | OpenTelemetry 追蹤、告警與 SLO（需實測流量基線） | PLANNED | — |
| SC-02 | 供應鏈 | 更新 runtime／build base digest（node:22-bookworm[-slim] 2026-11-05）並重跑雙架構交付與 Trivy | NEW_IN_V51 | `deploy/customer-single/Dockerfile`<br/>`docs/enterprise/supply-chain/SUPPLY_CHAIN_REMEDIATION_LEDGER.json` |
| V52-CI | 品質與 CI | ROLL-001／008／009：bash pipefail、gate.sh 三段退出碼、runner exit、skip／todo 清單、負向閘門測試 | NEW_IN_V52 | `scripts/enterprise/ci/gate.sh`<br/>`scripts/enterprise/ci/test_gate.py` |
| V52-OFFICE | 文件與草稿 | ROLL-002：Office 詳細資料綁定目前資源、ready 才可寫入／審批 | NEW_IN_V52 | `src/modules/office/hooks/useOfficeQuery.ts`<br/>`src/modules/office/tests/OfficeApp.test.tsx` |
| V52-DATA | 確定性計算 | ROLL-003／004／005／006／011：分側隔離合計、RFC4180 嚴格 CSV、幣別自有鍵、期間先驗、最小週別 | NEW_IN_V52 | `server/modules/enterprise-persistence/tests/acc-match-astra-roll.test.ts` |
| V52-DEPLOY | 品質與 CI | ROLL-007／RG-007：離線 image reference 一致、OCI source 指實際建置 repo | NEW_IN_V52 | `deploy/ai-office/test_dhc_office_images.py`<br/>`deploy/customer-single/Dockerfile` |
| V52-REPO | 品質與 CI | RG-003：全 repository 覆蓋契約與靜態語法 job | NEW_IN_V52 | `scripts/enterprise/ci/check_repo_coverage.py` |
| V53-E2E | 品質與 CI | ROLL-002 真 Chromium＋PostgreSQL 切換 E2E：RED（V5.1）／GREEN（本次）＋delivery 兩架構 | NEW_IN_V53 | `tests/enterprise/e2e/office_stale_e2e.mjs`<br/>`scripts/enterprise/ci/office_e2e_redgreen.py` |
| V53-NEG | 品質與 CI | ROLL-001／008／009 GitHub 負向閘門證據：11 案例、無 continue-on-error、API 核對 job／step conclusion | NEW_IN_V53 | `scripts/enterprise/ci/negative_gate_case.py`<br/>`scripts/enterprise/ci/collect_negative_gate.py` |
| V53-ACC | 會計對帳 | 跨側同列 ID 手算 golden＋真 PG JSON／CSV／Markdown 一致 | NEW_IN_V53 | `docs/enterprise/scenarios/會計對帳/golden/跨側同列ID_預期.json` |
| V53-OPS | 營運報表 | 用戶端中止請求不寫入；5 萬列同站衝突 CPU／RSS／延遲量測 | NEW_IN_V53 | `scripts/enterprise/ci/ops-resource-probe.ts` |
| V53-COORD | 品質與 CI | Builder／Auditor 共享狀態：STATE／FINDING_LEDGER＋CI schema 檢查（Builder 不得標 AUDIT_VERIFIED） | NEW_IN_V53 | `docs/enterprise/coordination/STATE.json`<br/>`scripts/enterprise/coordination/check_state.py` |
| PERF-01 | 品質與 CI | CI 效能：端到端報表／匯出 p50／p95 已量（NEW_IN_V51）；多用戶負載與 soak 仍未做 | PLANNED | — |
| UAT-01 | 驗收 | 66 項 UAT 實際執行（目前 PASS 0） | PLANNED | — |
| DEC-01 | 待人類決策 | 條款比對功能（BLOCKED_PRODUCT_DECISION） | BLOCKED_DECISION | — |
| DEC-02 | 待人類決策 | RD-002／RD-003 契約、IP／著作權、價格與 SOW | BLOCKED_DECISION | — |
| DEC-03 | 待人類決策 | 正式映像發布（GHCR）與客戶正式部署 | BLOCKED_DECISION | — |
| DEC-04 | 待人類決策 | ACC-MATCH 擴充規則（多對一、分期、退款、跨月） | BLOCKED_DECISION | — |
| PERF-02 | 品質與 CI | 多用戶併發負載、長時間 soak、arm64 升級回退 | PLANNED | — |
| SEC-01 | 待人類決策 | remote-agent cmd-run 預設暴露給模型、字面禁止清單可繞過（需模組 owner 決策） | BLOCKED_DECISION | — |
| SEC-02 | 待人類決策 | deid-proxy／codex-deid：大小／逾時／背壓／斷線／路徑（RG-002）＋KEEP 規則穿透 arguments（ROLL-012）＋未知 block 原樣外送（ROLL-013）（owner 工單） | BLOCKED_DECISION | — |
| DEC-05 | 待人類決策 | OPS-REPORT 多來源合計列數的業務契約（目前工程上限 5 萬） | BLOCKED_DECISION | — |
