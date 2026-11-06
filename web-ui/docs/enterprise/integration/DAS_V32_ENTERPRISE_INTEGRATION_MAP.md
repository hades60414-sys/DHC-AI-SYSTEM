# DAS V3.2 ← Enterprise RC-FIX V4 整合映射（DAS_V32_ENTERPRISE_INTEGRATION_MAP）

## 基線
| 項目 | 值 |
|---|---|
| 目標 repo | `hades60414-sys/DHC-AI-SYSTEM` |
| DAS base | `main@68b5bea614c1c30c8deba66128894df2b0407bfb`（`web-ui/` ＝ DHC CLI V3.2） |
| `web-ui/` 對應的 DHC CLI | `af4c55c0ea3cc3f5560369d38d8ebe565f99b4ff`（V3.2）；程式碼 blob 完全相同，只差 7 份翻譯 README、1 張截圖、`redirect-package/README.md`、`tools/scan-sensitive.mjs` |
| Enterprise V4 產品來源 | `1c660de327653e35803df6f862103828f725cc62`（DHC CLI `90229cf` 之上的企業分支） |
| 合併方式 | 在 DHC CLI repo 以 V3.2 為基底 `git merge` V4 產品 SHA（3 處衝突，見下），再把**選定路徑**以單一有界 commit 套到 `web-ui/`。DHC CLI 的 git 歷史與 V4 的 QA 證據**不帶入** DAS。 |

## 現有 DAS V3.2 範圍（未修改）
`harness/`、`web-ops/`、`tools/`、`remote-agent/`、`local-model/`、`migration/`、`vendor/`、`docs/`：本整合**一個檔案都沒有改**，也沒有讀入其程式碼。`web-ui/` 以外只新增 `.github/workflows/enterprise-*.yml`。

## 移植檔案（157 個，全部在 `web-ui/` 下）
| 路徑 | 檔案數 |
|---|---:|
| `.dockerignore` | 1 |
| `.gitignore` | 1 |
| `db/enterprise` | 24 |
| `deploy/ai-office` | 4 |
| `deploy/customer-single` | 8 |
| `docs/enterprise` | 6 |
| `package-lock.json` | 1 |
| `package.json` | 1 |
| `scripts/enterprise` | 10 |
| `scripts/release` | 1 |
| `server/index.ts` | 1 |
| `server/modules/agent` | 1 |
| `server/modules/auth` | 2 |
| `server/modules/enterprise-api` | 21 |
| `server/modules/enterprise-persistence` | 39 |
| `server/modules/providers` | 3 |
| `server/modules/websocket` | 5 |
| `server/shared` | 2 |
| `src/App.tsx` | 1 |
| `src/modules/office` | 11 |
| `src/shared` | 3 |
| `tests/enterprise` | 11 |

### 對應能力
| 能力 | 主要檔案 |
|---|---|
| Enterprise／Personal 路由隔離、legacy gate、安全標頭 | `server/index.ts`、`server/modules/enterprise-api/enterprise-runtime.ts`、`enterprise-security-headers.ts`、`server/modules/enterprise-api/deployment-mode.ts` |
| Auth／RBAC／session epoch 撤銷／最後管理員 | `enterprise-persistence/enterprise-identity.*`、`enterprise.repository.ts`（`findLiveEnterpriseSessionMember`） |
| PostgreSQL schema＋FORCE RLS | `db/enterprise/migrations/0001–0012`、`migrations.service.ts` |
| 文件上傳／版本／hash、DOCX／XLSX／PDF 文字層、隔離擷取子行程 | `enterprise.service.ts`、`document-*.ts`、`zip-reader.ts`、`extraction-sandbox.ts`、`extraction-worker.ts` |
| 檢索／引用完整性 | `enterprise.repository.ts`、`citation-integrity.ts` |
| 草稿／審批（版號＋hash 綁定）／匯出 | `enterprise-workflow.service.ts`、`OfficeWork.tsx` |
| Run 撤權隔離、冪等、原子配額、到期唯讀 | `enterprise-workflow.service.ts`、`enterprise-entitlements.ts` |
| Model egress（分級、網段、DNS pin、redirect allowlist）、attempt 用量帳 | `model-gateway.ts`、`egress-policy.ts`、`enterprise-workflow.service.ts` |
| ACC-MATCH-v1 確定性對帳 | `reconciliation-acc-match-v1.ts`、migration 0012、`/reconciliations`、`OfficeReconciliation.tsx` |
| Office UI | `src/modules/office/*`、`src/shared/{api,types,utils}.ts`、`src/App.tsx`（`/office`） |
| 部署／備份／還原／離線 image | `deploy/customer-single/*`、`deploy/ai-office/*`（`dhc-office.py`、compose）、`scripts/release/enterprise-image-guard.mjs` |
| 驗證腳本 | `scripts/enterprise/*.py|mjs`、`scripts/enterprise/rcfix/image_sbom.py`、`scripts/enterprise/ci/*`、`tests/enterprise/*` |

## 合併衝突與解法
1. `server/index.ts`（標頭）：企業模式保留企業安全標頭＋legacy gate 為第一個 middleware；個人模式套 V3.2 的 report-only CSP 與 CORS。
2. `server/index.ts`（路由）：V3.2 新增的 `/api/assistant` 放進 `mountLegacyApiRoutes()`，企業模式不掛載；已確認函式外只剩 `/api/enterprise/v1`。
3. `claude-runtime.provider.js`：V4 的 SDK 延遲載入（企業 image 無 SDK）＋V3.2 的 CLI pid 追蹤，兩者都保留。
4. `src/App.tsx`：保留 `PiiBlockNotice` 與 `OfficeApp` 兩個 import。
`package-lock.json` 自動合併後以 `npm install --package-lock-only` 驗證一致（無變更）。

## 刻意不移植
- 所有 QA 證據（`evidence/`）、內部商務／規劃文件（`docs/enterprise/` 除 `openapi.yaml` 與對帳合成 CSV 外）、內部打包工具（`scripts/enterprise/rcfix/` 除 `image_sbom.py`）、`CODEX_RUN_REPORT.md`、README 的內部連結段落、tracked `__pycache__`。
- 整合分支另外修正 2 處寫死的本機瀏覽器路徑（`scripts/enterprise/基線啟動測試.py`、`tests/enterprise/容器驗收.py` 改讀 `DHC_CHROMIUM_PATH`）。

## Personal Mode 相容
未設定企業模式時行為與 V3.2 相同（legacy 路由、V3.2 新功能、CORS、report-only CSP）；企業模式只開 `/api/enterprise/v1` 與 `/office`。

## 測試與 CI
見 `.github/workflows/enterprise-{verify,image-build,delivery-smoke}.yml` 與 `docs/enterprise/integration/INTEGRATION_RECEIPT.json`。V3.2 原本就失敗的 5 個 legacy 測試（名稱＠檔案、失敗特徵、基線 commit、owner、到期日）、1 個 i18n 測試檔、70 組 lint（檔案,規則）列在 `scripts/enterprise/ci/known-v32-baseline-failures.json`；CI 只擋新失敗，企業測試不在清單內。

註：上一版白名單列 11 個；其中 6 個（對話搜尋）經查是 `npm ci --ignore-scripts` 沒下載 `@vscode/ripgrep` 執行檔造成，CI 已補 `npm rebuild @vscode/ripgrep`，這 6 項移出白名單、必須通過。
