# V5.3 OCR 審查紀錄

## 工具負責的部分：檔案選擇（open-code-review v1.13.6，delegate 模式，不呼叫 LLM）
`ocr delegate preview --from 601dbb3 --to fix/ai-office-v53-closure`（range，merge base `601dbb3`）的結果：共 27 檔，其中 17 個可審、10 個被排除。

- 被排除的檔案：測試（`*.test.ts`、`test_gate.py`、`test_check_state.py`）、Markdown、golden CSV。
- OCR 沒有給出排除原因。
- `ocr delegate rule` 回傳 4 組規則：workflow 安全、JSON key 拼字、通用正確性（精確優先）、拼字與 dead code。

這份清單是工具的機械選擇，**不代表這些檔案已被審過**。

## Builder 負責的部分：語意審查
OCR 選中的 17 檔逐一看過。被排除的測試檔不在 OCR 範圍內：它們是 Builder 撰寫時逐案檢查的，並且都在 CI 實際執行（結果見 `EVIDENCE_SUMMARY.md`），但沒有經過另一次獨立的語意審查。

| 檔案 | 結論 |
|---|---|
| `.github/workflows/negative-gate-evidence.yml` | `run: ${{ steps.prepare.outputs.cmd }}` 會把指令插進 script，屬 expression injection 型態。來源只有固定 matrix 與 repo 內的腳本，觸發只有 `ci-evidence/**` push 與手動 dispatch，沒有 PR 輸入，權限為 contents／actions read。判定 Low，保留並記錄。 |
| `.github/workflows/office-e2e-evidence.yml` | RED 用 V5.1 來源與當時的 runtime base 建 image；compose／harness 用本次版本。舊 UI 在審批情境逾時，已改為各情境獨立執行並如實記錄（commit 45713dc）。 |
| `scripts/enterprise/ci/office_e2e_redgreen.py` | `free_port` 先探測再使用，有 TOCTOU 競態（Low，CI 單機可接受）。`finally` 必定 `down --volumes`；只用合成密碼，不寫入證據檔（已掃描確認）。 |
| `tests/enterprise/e2e/office_stale_e2e.mjs` | 修正一個未使用的變數（oxlint）。原先任一情境出錯就整體 ERROR，現已隔離，GREEN 另外要求情境錯誤為 0。 |
| `scripts/enterprise/ci/negative_gate_case.py`／`collect_negative_gate.py` | 判定同時要求 job 與 gate step 的 conclusion 符合預期；找不到 job 時判 mismatch（fail closed）。 |
| `scripts/enterprise/coordination/*.py` | 驗證器有 8 個竄改負向測試。原始 18 項的 builder_status 沿用 V4 RC-FIX「已整改待複驗」；auditor 判定照 Astra 原文（含 PARTIAL／NOT_RUN），未改判。 |
| `scripts/enterprise/ci/ops-resource-probe.ts` | 新情境只量測，不設門檻，與既有契約一致。 |
| JSON（STATE／LEDGER／SNAPSHOT／golden 預期） | key 拼字正常。 |

未發現 Critical／High。兩個 Low 項目已記錄，未修改。

> 注意：這是 Builder 的自我審查，不是獨立驗收。
