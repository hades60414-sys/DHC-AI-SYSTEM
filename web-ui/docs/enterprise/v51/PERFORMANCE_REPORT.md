# V5.1 效能報告

Product Source `6933d5e`；數值取自 GitHub Actions artifact。單一用戶端／單執行緒，不是負載測試；沒有核准 SLO，不判定合格與否。

## API 與報表／匯出端到端（交付冒煙 17-b，實際 image＋PostgreSQL，mock 模型；報表 10000 列合成 CSV）

| 架構 | 量測 | n | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|
| amd64 | login | 20 | 94.0 | 94.9 | 114.7 |
| amd64 | identity | 20 | 2.5 | 3.9 | 6.5 |
| amd64 | documents_list | 20 | 4.1 | 4.7 | 9.6 |
| amd64 | search | 20 | 5.8 | 6.8 | 7.4 |
| amd64 | upload_1kb | 20 | 12.5 | 16.6 | 17.8 |
| amd64 | run_to_completion | 10 | 1024.6 | 1026.0 | 1027.6 |
| amd64 | ops_report_create | 5 | 174.8 | 202.5 | 230.4 |
| amd64 | ops_report_reused | 10 | 15.5 | 19.6 | 22.8 |
| amd64 | reconciliation_create | 1 | 713.1 | 713.1 | 713.1 |
| amd64 | export_json | 5 | 185.6 | 192.0 | 202.1 |
| amd64 | export_csv | 5 | 180.9 | 185.4 | 198.6 |
| amd64 | export_markdown | 5 | 149.5 | 152.2 | 158.8 |
| arm64 | login | 20 | 74.7 | 76.1 | 97.3 |
| arm64 | identity | 20 | 3.0 | 3.2 | 3.2 |
| arm64 | documents_list | 20 | 4.8 | 5.1 | 6.4 |
| arm64 | search | 20 | 6.3 | 6.6 | 7.9 |
| arm64 | upload_1kb | 20 | 16.7 | 18.2 | 19.2 |
| arm64 | run_to_completion | 10 | 1033.5 | 1036.6 | 1038.6 |
| arm64 | ops_report_create | 5 | 174.8 | 185.6 | 230.0 |
| arm64 | ops_report_reused | 10 | 14.8 | 16.0 | 16.6 |
| arm64 | reconciliation_create | 1 | 583.6 | 583.6 | 583.6 |
| arm64 | export_json | 5 | 170.8 | 175.4 | 187.5 |
| arm64 | export_csv | 5 | 160.5 | 164.7 | 177.0 |
| arm64 | export_markdown | 5 | 135.8 | 136.5 | 139.7 |

## OPS-REPORT 資源邊界探針（x64 runner，子行程峰值 RSS 含產生合成輸入）

| 情境 | 結果 | ms | maxRSS MB | 結果 JSON MB |
|---|---|---|---|---|
| single_50k | completed  | 660 | 212 | 0.4 |
| five_x_10k_legal_aggregate | completed  | 654 | 170 | 0.4 |
| one_huge_line_20MiB | rejected ['LINE_TOO_LONG'] | 1 | 124 | 0 |
| five_x_50k | rejected ['TOTAL_ROWS_EXCEEDED'] | 351 | 298 | 0 |
| five_x_25MiB | rejected ['TOTAL_BYTES_EXCEEDED'] | 439 | 402 | 0 |
| one_huge_line_25MiB | rejected ['TOTAL_BYTES_EXCEEDED'] | 1 | 137 | 0 |
| long_field_1MiB | rejected ['LINE_TOO_LONG'] | 1 | 90 | 0 |

## 確定性引擎（engine-bench，x64；5 萬列邊界 PASS）

| 量測 | 狀態 | 中位數 ms | 最大 ms | bytes |
|---|---|---|---|---|
| acc_match_10000 | completed | 153 | 203 |  |
| acc_match_49999 | completed | 673 | 726 |  |
| acc_match_50000 | completed | 648 | 818 |  |
| acc_match_50001 | rejected | 252 | 252 |  |
| export_json_50000_cases |  | 398 | 471 | 47641691 |
| export_csv_50000_cases |  | 259 | 368 | 14946334 |
| export_markdown_50000_cases |  | 166 | 237 | 6993293 |
| ops_report_50000_rows | completed | 610 | 685 |  |

## 映像

| 架構 | image size MB | image id |
|---|---|---|
| amd64 | 839.2 | `sha256:154a986fd209` |
| arm64 | 857.8 | `sha256:eda9b596dcc1` |

## NOT_RUN

- 多用戶併發負載、長時間 soak、HTTP 行程記憶體峰值（只量了引擎子行程）。
- Excel 匯入實測。
- arm64 的升級回退。
