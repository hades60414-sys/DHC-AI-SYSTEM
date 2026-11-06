# V5.2 交回 Astra（ASTRA-ROLL 整改收據）

- PR：https://github.com/hades60414-sys/DHC-AI-SYSTEM/pull/13（Draft，base `fix/ai-office-v51-repoguard-hardening`）
- Base `2cc9e93e75133dc4247e7af3b959865cf8d9d05d` → Product Source `d38afd88d9630a9390785ae35b745a8ad91e6c6a`（之後只有文件提交）
- 雙架構 image：amd64 `sha256:00d56aaa2e0193b32c9930aed76e13966e4c2e80330e46b0660eaa7adce56782`（archive SHA-256 `f8ad9b8a5016a6fc353a12b27aeff7dcb0b0e701241855a1627cf80191f1dc8e`）；arm64 `sha256:b955436e1c04b0a907c8c644d4892c9a4baa5890f27d74b23ec898e81c1bc082`（`8d771e62c76e89eb43c8c7495d84a15db3c37cc89fd328ea1254381a37298ce7`）；未推 registry，無 manifest digest
- source label：`https://github.com/hades60414-sys/DHC-AI-SYSTEM` @ `d38afd8`（兩架構一致）

## CI（同一 Product Source SHA）

| Run | Job | 結論 |
|---|---|---|
| [42276319689](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42276319689) | postgres-integration | success |
| [42276319689](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42276319689) | static-and-unit | success |
| [42276319689](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42276319689) | csv-spreadsheet-safety | success |
| [42276319770](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42276319770) | build-arm64 | success |
| [42276319770](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42276319770) | build-amd64 | success |
| [42276319770](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42276319770) | delivery-arm64 / delivery | success |
| [42276319770](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42276319770) | upgrade-rollback-amd64 | success |
| [42276319770](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42276319770) | delivery-amd64 / delivery | success |
| [42276319968](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42276319968) | coverage-contract | success |

- backend 756/757（fail 0，skip 1 為允許清單內）；frontend 1151/1151；lint 92 舊錯誤／1159 檔、無新增；PG 136／0；升級回退 17/17；LibreOffice PASS；repo-coverage PASS。
- 三段退出碼：enterprise-verify-static-unit 的 `*-exit.json`（tool／comparator／gate）。

## 整改矩陣

| ID | 嚴重度 | 狀態 | Commit | 測試 | CI |
|---|---|---|---|---|---|
| ASTRA-ROLL-001 | HIGH | FIXED_PENDING_REAUDIT | 6210554 | scripts/enterprise/ci/test_gate.py | static-and-unit |
| ASTRA-ROLL-002 | HIGH | FIXED_PENDING_REAUDIT | 5138dd9 | src/modules/office/tests/OfficeApp.test.tsx | static-and-unit（vitest 1151／1151，exit 0） |
| ASTRA-ROLL-003 | MEDIUM | FIXED_PENDING_REAUDIT | afbdea9 | server/modules/enterprise-persistence/tests/acc-match-astra-roll.test.ts | static-and-unit |
| ASTRA-ROLL-004 | MEDIUM | FIXED_PENDING_REAUDIT | afbdea9 | server/modules/enterprise-persistence/tests/acc-match-astra-roll.test.ts | static-and-unit |
| ASTRA-ROLL-005 | MEDIUM | FIXED_PENDING_REAUDIT | afbdea9 | server/modules/enterprise-persistence/tests/acc-match-astra-roll.test.ts | static-and-unit |
| ASTRA-ROLL-006 | MEDIUM | FIXED_PENDING_REAUDIT | afbdea9 | server/modules/enterprise-api/tests/reconciliation.integration.test.ts | postgres-integration（136 pass／0 fail） |
| ASTRA-ROLL-007 | MEDIUM | FIXED_PENDING_REAUDIT | c75054f | deploy/ai-office/test_dhc_office_images.py, scripts/enterprise/驗證AI_Office交付.py 12d／13c | delivery-amd64／delivery-arm64：12d、13c 皆 exit 1（預期 1） |
| ASTRA-ROLL-008 | MEDIUM | FIXED_PENDING_REAUDIT | 6210554 | scripts/enterprise/ci/test_gate.py | static-and-unit（frontend tool_exit 0） |
| ASTRA-ROLL-009 | MEDIUM | FIXED_PENDING_REAUDIT | 6210554 | scripts/enterprise/ci/test_gate.py | static-and-unit |
| ASTRA-ROLL-010 | MEDIUM | FIXED_PENDING_REAUDIT | 11359bb（V5.1） | server/modules/enterprise-persistence/tests/acc-match-astra-roll.test.ts（同站 5 萬列衝突） | static-and-unit |
| ASTRA-ROLL-011 | LOW | FIXED_PENDING_REAUDIT | afbdea9 | server/modules/enterprise-persistence/tests/acc-match-astra-roll.test.ts | static-and-unit |
| ASTRA-ROLL-012 | MEDIUM | WORK_ORDER_ISSUED | — | docs/enterprise/v52/DEID_WORK_ORDERS_ADDENDUM.md DEID-09 | — |
| ASTRA-ROLL-013 | MEDIUM | WORK_ORDER_ISSUED | — | docs/enterprise/v52/DEID_WORK_ORDERS_ADDENDUM.md DEID-10 | — |
| RG-001 | HIGH | BLOCKED_DECISION | — | docs/enterprise/v51/REMOTE_AGENT_THREAT_MODEL.md（完整版受控保存） | — |
| RG-002 | MEDIUM | WORK_ORDER_ISSUED | — | docs/enterprise/v51/DEID_PROXY_HARDENING_PLAN.md DEID-01..08 | — |
| RG-003 | MEDIUM | FIXED_PENDING_REAUDIT | d38afd8 | scripts/enterprise/ci/check_repo_coverage.py | repo-coverage（2,621 檔全分類、非 web-ui JS／Python 語法 PASS） |
| RG-005 | MEDIUM | HUMAN_DECISION_REQUIRED | — | docs/enterprise/v52/SUPPLY_CHAIN_FINAL_LEDGER.json | — |
| RG-006 | LOW | FIXED_PENDING_REAUDIT | 2cc9e93（V5.1）＋本輪 | docs/enterprise/v52/SUPPLY_CHAIN_FINAL_LEDGER.json | image-build |
| RG-007 | MEDIUM | FIXED_PENDING_REAUDIT | 7667822 | .github/workflows/enterprise-image-build.yml 兩架構 assert | build-amd64／build-arm64 |
| RG-008 | LOW | HUMAN_DECISION_REQUIRED | — | — | — |

## 誠實揭露

- ROLL-002 以元件層 fetch stub 驗證；真瀏覽器網路延遲 E2E 未加（NOT_RUN）。
- ROLL-012／013、RG-001／002 依先前指示不改 TAS 模組，只交工單／威脅模型。
- RG-005／008 需人類：OS 風險具名接受、UAT／RD／IP／SOW／客戶簽認。
- 原 18 項 ASTRA＋4 項 V4 NEW 的判定由 Astra 持有，本輪未修改其 Findings。

狀態：FIXED_PENDING_REAUDIT（不是 AUDIT_VERIFIED）；AWAITING_ASTRA_REAUDIT。

Astra 唯讀指令：
```sh
gh api 'repos/hades60414-sys/DHC-AI-SYSTEM/compare/877525f27eed8d394f609d7ad7d2d8695be1035b...d38afd88d9630a9390785ae35b745a8ad91e6c6a'
gh api 'repos/hades60414-sys/DHC-AI-SYSTEM/actions/runs?head_sha=d38afd88d9630a9390785ae35b745a8ad91e6c6a&per_page=100'
gh api repos/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42276319689/artifacts
```
