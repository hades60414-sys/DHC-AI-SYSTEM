# Auditor Security Anchor 提案（OCR-V531-D01／D02）

> 本文件是**提案**。Builder **沒有**產生任何 Auditor 簽章金鑰，沒有改 repo 設定，也**不宣稱** Auditor 身分已受保護。

## 問題
`AUDITOR_SNAPSHOT.json` 由 Builder 從 Astra 的私有報告抄錄。CI 目前只能確認兩件事：
- 報告集合與內容沒有偏離 `check_state.py` 裡的釘選值；
- 竄改會出現在 PR diff 中。

但 Builder 能同時改 snapshot 和檢查器，所以 CI 無法證明一份判定真的出自 Astra。

## 方案 A：Astra 獨立簽章的報告（建議）

### 1. 報告格式（`auditor-receipt/v1`）
```json
{
  "schema": "auditor-receipt/v1",
  "auditor": "Astra",
  "key_id": "astra-2026-01",
  "issued_at": "2026-11-08T10:00:00+08:00",
  "repo": "hades60414-sys/DHC-AI-SYSTEM",
  "reviewed": {"pr": 14, "head_sha": "<40 hex>", "product_sha": "<40 hex>", "evidence_runs": [42348102966, 42348102897]},
  "source_report_sha256": "<Astra 原始報告 sha256>",
  "verdicts": [{"id": "ASTRA-ROLL-001", "severity": "HIGH", "verdict": "PASS|FAIL|PARTIAL|NOT_RUN", "problem_state": "...", "reviewed_sha": "<40 hex>"}],
  "supersedes": null
}
```

### 2. Canonical JSON
- 依 RFC 8785（JCS）：UTF-8、key 依 Unicode code point 排序、不加空白、數字使用最短表示、不允許重複 key。
- 簽的是 canonical bytes，不是檔案原文。
- 驗證端用同一個 JCS 實作重算後再驗章。

### 3. 簽章與公鑰驗證
- 演算法：Ed25519。可以用 `ssh-keygen -Y sign -n dhc-auditor`，或 minisign／cosign blob；擇一後固定，不混用。
- 檔案放置：
  - `web-ui/docs/enterprise/coordination/auditor/receipts/<issued_at>_<key_id>.json`
  - 同一目錄下的 `.sig`
- 公鑰清單：`web-ui/docs/enterprise/coordination/auditor/ALLOWED_SIGNERS`，只含公鑰，由 Astra 提交。
- CI 新增一個步驟（**只有在核准後**才實作）：
  1. 驗證每份 receipt 的簽章；
  2. 驗證簽章時間落在該 key 的有效期間內；
  3. 從**已驗章**的 receipts 重新產生 `AUDITOR_SNAPSHOT`；
  4. 和 repo 裡的 snapshot 比對，不一致就 fail。

  之後 `check_state.py` 的 `PINNED_AUDITOR_REPORTS` 可以移除，改由簽章擔保。

### 4. Key Rotation
- 公鑰清單每把 key 都帶 `valid-after`／`valid-before`。
- 新 key 由舊 key 簽一份 `key-rotation` 聲明，再加上 repo admin 核准。
- 舊 key 停用後，它簽過的歷史 receipt 仍然有效，條件是簽章時間落在當時的有效期內。
- 建議每 12 個月輪換一次，或在人員異動時立即輪換。

### 5. 簽章失效處理
| 狀況 | 處理 |
|---|---|
| 驗章失敗 | CI 直接 fail，對應判定一律視為 `AUDITOR_REPORT_NOT_AVAILABLE`；不得退回採用 Builder 的抄錄 |
| 金鑰外洩 | 撤銷聲明（`revoked_at`）由 repo admin 提交；該時間點之後該 key 簽的 receipt 全部無效；受影響的判定改為 RETEST_REQUIRED，等新 key 重簽 |
| 重簽／更正 | 新 receipt 填 `supersedes`；舊 receipt 保留，不刪除 |

## 方案 B：CODEOWNERS＋Branch Protection（可與 A 並用）

### `.github/CODEOWNERS`（由 repo admin 新增）
```
/web-ui/docs/enterprise/coordination/AUDITOR_SNAPSHOT.json   @<astra-github-account>
/web-ui/docs/enterprise/coordination/auditor/                @<astra-github-account>
/web-ui/scripts/enterprise/coordination/check_state.py       @<astra-github-account> @<repo-owner>
/.github/CODEOWNERS                                          @<repo-owner>
```
帳號名稱只是佔位，需要人類填入實際帳號。

### Branch protection／ruleset（`main` 與 stacked base 分支）
設定項目：
- Require a pull request before merging
- Require review from Code Owners
- Dismiss stale approvals on new commits
- Require status checks：enterprise-verify／static-and-unit 等
- Do not allow bypassing
- Restrict force pushes／deletions

限制：這只保護 merge 進受保護分支的路徑，**不保護** feature 分支上 Builder 自己 commit 的內容。所以單靠方案 B 仍不夠，最好搭配方案 A。

## 所需權限
| 動作 | 權限 |
|---|---|
| 建立 ruleset／branch protection、CODEOWNERS 生效 | repo **Admin**（或 org owner） |
| 提交 ALLOWED_SIGNERS 與 receipts | Astra 的 GitHub 帳號需要 **Write**，並列為 code owner |
| 管理私鑰 | **只有 Astra**，存在 Astra 自己的裝置或 HSM，永不進 repo 或 CI secrets |
| CI 驗章 | 只需公鑰，不需要任何 secret |

## 需要人類決策
1. 採用方案 A、方案 B，或兩者並用。
2. Astra 的 GitHub 帳號與 key_id。
3. 由 repo admin 套用 ruleset。

在決策完成前，D01／D02 維持「已緩解、殘餘風險待人類決策」。
