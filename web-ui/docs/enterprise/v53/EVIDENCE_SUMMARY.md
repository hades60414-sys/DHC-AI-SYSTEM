# V5.3 證據摘要（Builder 提交；尚待 Astra 獨立複驗）

- PR：#14（Draft，base `fix/ai-office-v52-astra-roll`＝#13 head `601dbb3`，#13 未修改）
- 驗證 head：`45713dce4a272cd9303478ffe56ac8c732eacd23`
- 產品程式：未變更，仍為 `d38afd88d9630a9390785ae35b745a8ad91e6c6a`（`src/`、`server/` 非測試、`deploy/`、`package*.json` 對 d38afd8 的 diff 為空）
- 機器可讀：`CI_MATRIX.json`、`evidence/*.json`、`SUPPLY_CHAIN_PROVENANCE.json`、`../coordination/STATE.json`

## CI 矩陣（同一 SHA，attempt 1）
| Workflow | Run | 結論 | 內容 |
|---|---|---|---|
| enterprise-verify | 42343825984 | success | static-and-unit（含 state schema、負向閘門單元測試、資源探針）、postgres-integration、csv-spreadsheet-safety |
| enterprise-image-build | 42343825894 | success | build amd64／arm64、SBOM＋Trivy、delivery amd64／arm64（含 Office A→B GREEN）、upgrade-rollback-amd64 |
| repo-coverage | 42343825939 | success | 全 repo 覆蓋契約 |
| negative-gate-evidence | 42343824459 | **failure（預期）** | 10 個負向 job failure、positive_control success、collect success（全部符合預期） |
| office-e2e-evidence | 42343824443 | success | red-v51 與 green-current 都符合各自預期 |

## WP1：Office A→B 切換（ASTRA-ROLL-002）真 Chromium＋PostgreSQL
| | RED（V5.1 `2cc9e93` image，合成資料） | GREEN（`45713dc` image） |
|---|---|---|
| 瀏覽器 violation | A 內容顯示在 B 下 3、把 A 內容寫到目標 3、未就緒時寫入 3、正向儲存不符 1、審批未就緒時送決定 1 | 0 |
| PUT／POST | `PUT drafts/<B> {expectedRevision:1, body:<A 的內容>}`＋`submit` | 只有正向 `PUT drafts/<B>`（B 版號＋合法修改）與 `approvals/<D>/decision`（D 的 revision＋sha256） |
| PostgreSQL | B 的 revision 2 內容 md5＝A 的內容；`draft.revised` 對 B 2 筆 | B 只有 rev 1、2 且都≠A；revised 1、submitted 0；B 仍 draft；D approved、C pending；決策稽核 D=1、C=0；A 只有 1 版 |
| 情境錯誤 | 審批情境在舊 UI 找不到「審核D」逾時（如實記錄，不影響 PG 核對） | 0 |

- 不同版號（丁，rev 2）：RED 送出 `expectedRevision:1` 被伺服器版號檢查擋下；同版號（B）才真的錯寫，這正是 ROLL-002 的風險面。
- 同內容不同 approval（C／D 的 sha256 相同）：GREEN 核准只送 D 的 id／revision／sha。
- delivery 兩架構各自又跑一次 GREEN：amd64 8/8、arm64 8/8。
- 證據：`evidence/OFFICE_STALE_RED_V51.json`、`OFFICE_STALE_GREEN_45713dc.json`、`OFFICE_STALE_DELIVERY_{AMD64,ARM64}.json`。

## WP2：CI 負向閘門（ASTRA-ROLL-001／008／009）
`evidence/NEGATIVE_GATE_EVIDENCE.json`（run 42343824459，all_match=true）：

| 案例 | tool／comparator／gate exit | job conclusion |
|---|---|---|
| positive_control | 0／0／0 | success |
| tool_nonzero_output_all_pass | 1／1／1 | failure |
| comparator_nonzero_new_fail | 1／1／1 | failure |
| new_skip、new_todo、missing_output、truncated_report | 0／1／1 | failure |
| frontend_exit1_all_pass | 1／1／1 | failure |
| wrong_sha256、build_failure、smoke_failure | （`… \| tee`，由 pipefail 傳遞） | failure |

沒有使用 continue-on-error；workflow 整體 conclusion 為 failure 是設計上的預期，由 collect job 以 GitHub API 讀回每個 job 與 gate step 的 conclusion 來判定。正式 CI 的 lint 工具 exit 1 是既有基線（比較器 0、閘門 0），與 V5.2 相同。

## WP3：ACC／OPS
- 手算 golden（`scenarios/會計對帳/golden/跨側同列ID_*`）：D1 EXACT_MATCH、D2 DUPLICATE_DOCUMENT_ID（隔離）、D3 AMOUNT_DIFFERENCE −500；TWD 隔離內部帳 3000（修正前錯值 103000）。單元測試 7/7；真 PG 測試「golden … JSON／CSV／Markdown 三種匯出一致」ok（`evidence/PG_ACC_OPS_TESTS.txt`）。
- 非法日期不寫入：「ROLL-006：不存在日期與反向期間在查 DB 前 400、不寫入」ok。
- HTTP 併發上限：「計算併發閘門滿 → 429，釋放後可再建立」ok；中止請求：「用戶端在計算期間中止請求 → 伺服器不寫入，之後同請求可正常建立」ok。
- 50k 同站衝突（`evidence/OPS_RESOURCE_PROBE.json`，GitHub x64，Node 22.23.4）：completed、542 ms、CPU 640 ms、maxRSS 201 MB、結果 JSON 6.4 MB。殘餘：單一衝突的 sources 清單不設上限（受 5 萬列總上限約束），記錄於 DEC-05，不改規則。
- 會計規則未變更，無需 ADR。

## 供應鏈（`SUPPLY_CHAIN_PROVENANCE.json`）
| arch | image id | archive sha256 |
|---|---|---|
| amd64 | `sha256:16f1a64ccdf005ad983e772193d9b0cc9f8436335352d279023a5b3b8950b5d1` | `d8ef922d83a5640e81fae8905065d623e2489d5c379ae7c0ed31626c4c0cb45c` |
| arm64 | `sha256:72e7b2e8667ccb4b808a5f3507371e5e2c319cf0a767c948a9d3ab397ac89b6c` | `0ecde6c223185f898fbc8ba5dd846574783bb1539c13e225f52c9a580ad1cb7f` |

Trivy 與 V5.2 相同：OS CRITICAL 1（zlib1g CVE-2023-45853，will_not_fix）、OS HIGH 34、語言套件 0／0，仍屬 SC-OWNER。未推 registry、無簽章，不是正式 release。

## 架構差異
- `architecture/DEPLOYMENT_CI_ARCHITECTURE.mmd`：新增隔離證據 workflow（`ci-evidence/**`）、delivery 內的 Office E2E、state schema 檢查。
- `architecture/roadmap.json`：新增 NEW_IN_V53 五項（V53-E2E／NEG／ACC／OPS／COORD），由 `render_roadmap.py` 重新產生 TUI 與 Mermaid。
- 產品執行架構不變。

## OCR 審查（WP6）
見 `OCR_REVIEW.md`：OCR 只負責檔案選擇與規則（17 個可審、10 個被排除），語意審查由 Builder 逐檔執行。
