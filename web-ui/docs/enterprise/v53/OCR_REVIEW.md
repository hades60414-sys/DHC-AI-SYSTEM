# V5.3.1 OpenCodeReview 紀錄（工具選檔＋隔離 Reviewer 語意審查）

> V5.3 版本只做了 OCR 選檔，語意審查是 Builder 自己做的，不算獨立審查。本版本改為由隔離的 Reviewer 執行，取代 V5.3 的自我審查紀錄。

## 執行模式
| 項目 | 值 |
|---|---|
| 工具 | open-code-review v1.13.6（891df1b6，2026-11-05 建置），原始輸出見 `ocr/ocr_version.txt` |
| `ocr review`（LLM 模式） | **未執行**。本機雖設定了 anthropic provider，但使用者的既有決策 DEC-OCR-01 只核准 Delegation Mode，不授權把原始碼送往外部模型 |
| `ocr delegate preview` | `--from 601dbb3ee1d75f94ce75947af6e1cb2eea17661c --to cb19d46e3950a18dcde2353a91a60b52feb34b1c`，exit 0 |
| `ocr delegate rule` | 30 個可審檔，exit 0，共 4 組規則（`ocr/rules.json`） |
| 語意審查者 | 全新上下文的獨立 Reviewer agent：不繼承 Builder 的實作對話，只拿到原始 diff、OCR 規則和需求摘要；限制為唯讀、不聯網、不跑 docker、不執行 `ocr review` |
| 複驗 | 同一位 Reviewer 對修正 delta `cb19d46..c2ae88b` 再審一次（`ocr/delta_review.json`） |

## 選檔與排除（共 55 個變更檔）
- OCR 可審：30 檔。
- OCR 排除：25 檔，原因如下（`ocr/preview.json`）：
  - `unsupported_ext`：19 檔，`.md`／`.mmd`／`.txt`／`.csv`
  - `default_path`：6 檔，都是測試檔
- 排除檔的處理：
  - 6 個測試檔與 2 個 golden CSV 是證據，因此 Reviewer 仍做了語意審查。
  - 其餘 17 個文件檔做完整性審查。
- 覆蓋率：55/55，其中語意審查 38、完整性審查 17、略過 0。

## Findings 與處置
| ID | 嚴重度 | 檔案:行 | 內容 | 處置 |
|---|---|---|---|---|
| OCR-V531-01 | **High** | coordination/check_state.py:139 | 只要 ledger 自稱 PASS 就能偽造 Auditor 判定 | 已修（e71725b，判定改由 snapshot 推導）。RED／GREEN 見 `evidence/STATE_CHECK_RED_cb19d46.txt`、`STATE_CHECK_GREEN.txt`。複驗結果 PARTIAL，見 D01／D02 |
| OCR-V531-02 | Medium | check_state.py:159 | 嚴重度可以被降級 | 已修（e71725b）；複驗 FIXED |
| OCR-V531-03 | Medium | check_state.py:115 | golden fixture 被當成文件 | 已修（e71725b）；複驗 FIXED（clone 實測） |
| OCR-V531-04 | Medium | office_e2e_redgreen.py:105 | 審批一半的 PG oracle 分不出缺陷與正常行為 | **記錄不改**。審批一半的判定只靠瀏覽器偵測器，PG 只作佐證，已寫入 `OFFICE_E2E_VERIFICATION.md` |
| OCR-V531-05 | Low | office_stale_e2e.mjs:124 | 沒有斷言攔截真的命中 | 已修（e71725b，ROUTE_NOT_HIT＋檢查 driver exit）；複驗 FIXED |
| OCR-V531-06 | Low | collect_negative_gate.py:67 | pipe 類案例接受任何原因的失敗 | 記錄不改。job log 已人工確認失敗原因正確：COPY 缺檔、容器 exit 3、checksum 不符 |
| OCR-V531-07 | Low | v53/SHA256SUMS | manifest 過期 | 在 S6 重產 |
| OCR-V531-08 | Low | BUILDER_RECEIPT.md 等 | 文件內容過期 | 在 S6 更新 |
| OCR-V531-09 | Low | build_state.py:146 | BD-* 被預設成 LOW | 已修，改為 UNRATED_IN_REGISTRY |
| OCR-V531-10 | Low | negative-gate-evidence.yml:41 | 有 expression injection 寫法 | 記錄不改：輸入是靜態的、只能 push 或手動觸發、權限唯讀 |
| OCR-V531-D01 | **High** | AUDITOR_SNAPSHOT.json | 可以改寫已抄錄報告的內容 | 緩解（828a763）：報告內容雜湊釘選在檢查器裡，竄改會出現在 PR diff。**殘餘風險**：Builder 仍然能同時改 snapshot 和檢查器。RED `evidence/STATE_CHECK_RED_c2ae88b.txt` |
| OCR-V531-D02 | **High** | AUDITOR_SNAPSHOT.json | 可以附加虛構的 Auditor 報告 | 緩解（828a763）：報告集合也釘選，STATE 報告清單必須一致。殘餘風險同 D01 |
| OCR-V531-D03 | Medium | check_state.py | 人類阻塞項可被改標為「已修」 | 已修（828a763，builder_status 必須等於 registry 狀態） |
| OCR-V531-D04 | Low | check_state.py | 非 PASS 項的 closure_class 可以在幾個非驗證類別之間互換 | 記錄不改：不影響 open High，也不影響 AUDITOR_VERIFIED |
| OCR-V531-D05 | Low | check_state.py | `docs/enterprise/` 下 CI 會讀的 JSON（roadmap／uat／registry）仍被當成文件 | 記錄不改：這些檔案由文件 commit 自己那次 CI 的 verify 檢查（roadmap `--check`、狀態檢查） |

## D01／D02 的殘餘風險（Builder 確認，需要人類決策）
在 Builder 能寫入全部檔案的情況下，CI 無法證明一份判定真的出自 Auditor。要真正關閉，需要一個 Auditor 控制的錨點，例如：
1. 用 CODEOWNERS 把 `web-ui/docs/enterprise/coordination/AUDITOR_SNAPSHOT.json` 指給 Astra，並設 branch protection（repo 設定，屬人類決策）。
2. Astra 發布簽章的報告摘要，CI 驗證簽章。

在此之前，Astra 可以用 `sync_auditor_snapshot.py` 和自己的原始報告重算抄錄內容，與檢查器釘選的 `content_sha256` 比對，作為獨立核對。

> 本表的判定來自獨立 Reviewer；修正與緩解是 Builder 做的，不代表 Reviewer 或 Astra 的驗收。
