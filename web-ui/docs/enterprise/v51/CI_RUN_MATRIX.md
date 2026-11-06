# V5.1 CI Run Matrix

Product Source SHA `6933d5e17f1120d87126df598c594c31b4e474ed`（之後只有文件提交：是）。全部在 GitHub-hosted 原生 runner；本機未啟動 QA VM。

| Run | Job | 結論 | 開始 | 結束 |
|---|---|---|---|---|
| [42247102617](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42247102617) | postgres-integration | success | 2026-11-06T15:53:02Z | 2026-11-06T15:55:06Z |
| [42247102617](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42247102617) | static-and-unit | success | 2026-11-06T15:53:02Z | 2026-11-06T15:57:23Z |
| [42247102617](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42247102617) | csv-spreadsheet-safety | success | 2026-11-06T15:57:26Z | 2026-11-06T15:58:13Z |
| [42247102627](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42247102627) | build-amd64 | success | 2026-11-06T15:54:26Z | 2026-11-06T15:57:56Z |
| [42247102627](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42247102627) | build-arm64 | success | 2026-11-06T15:54:28Z | 2026-11-06T15:57:45Z |
| [42247102627](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42247102627) | delivery-arm64 / delivery | success | 2026-11-06T15:57:50Z | 2026-11-06T16:01:02Z |
| [42247102627](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42247102627) | upgrade-rollback-amd64 | success | 2026-11-06T15:57:59Z | 2026-11-06T16:02:01Z |
| [42247102627](https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/42247102627) | delivery-amd64 / delivery | success | 2026-11-06T15:57:58Z | 2026-11-06T16:01:10Z |

## 要求項目對照

| 項目 | 結果 | 來源 |
|---|---|---|
| Typecheck | PASS | static-and-unit |
| Backend | PASS：750/751，fail 0，skip 1 | backend.tap＋比對器 |
| Frontend | PASS：1146/1146 | vitest.json |
| Lint（不得新增） | PASS：92 errors／63 pairs | lint.json |
| 真 PostgreSQL（Migration、Auth／RLS、Concurrency、Document Integrity、OPS-REPORT、ACC-MATCH Export） | PASS：135 pass／0 fail，19 步 | enterprise-verify-postgres |
| Resource Boundaries | PASS（7 情境） | ops-resource-probe.json |
| CSV 試算表實測 | PASS（LibreOffice LibreOffice 24.2.7.2 420(Build:2)；Excel NOT_RUN） | spreadsheet-import.json |
| AMD64／ARM64 build | PASS | image-build |
| Delivery（兩架構） | amd64 PASS／arm64 PASS | enterprise-delivery-* |
| Upgrade／Rollback（V4→V5.1，amd64） | PASS（17/17 檢查） | enterprise-upgrade-rollback-amd64 |
| Upgrade／Rollback arm64 | NOT_RUN（只建 amd64 舊版 image；arm64 需再建一次 V4 image，約 4 分鐘＋交付） | — |
| SBOM／Trivy | 兩架構各一份（見 SUPPLY_CHAIN_FINAL_LEDGER） | enterprise-image-report-* |
| Performance | 引擎 bench PASS；API／報表端到端見 PERFORMANCE_REPORT | engine-bench.json、17-b-perf-baseline |
| CI Gate Integrity | 比對器 24 測試、roadmap --check、UAT 證據索引 --check 皆在 static-and-unit 執行 | static-and-unit |
| 多用戶負載／soak | NOT_RUN（單一用戶端探針；需另設負載工具與 SLO） | — |
