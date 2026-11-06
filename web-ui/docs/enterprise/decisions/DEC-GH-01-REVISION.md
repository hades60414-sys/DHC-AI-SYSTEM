# DEC-GH-01-REVISION — 公開 GitHub 推送授權（2026-11-06）

- 狀態：**PUBLIC_GITHUB_PUSH_AUTHORIZED**（取代 DEC-GH-01「本輪不推」）
- 決策者：專案使用者（GitHub `juhjuhx`），以權利人身分書面授權
- 目標：`hades60414-sys/DHC-AI-SYSTEM`（Public）獨立分支 `integration/enterprise-rcfix-v4-20261106` → 對 `main` 的 Draft PR

## 背景
DEC-GH-01（2026-11-05）決定暫不推送，待權利確認。2026-11-06 Builder 判定 `PUBLICATION_RIGHTS_BLOCKED`（Enterprise 新程式著作權歸屬未簽署；目標 repo 為 Public）。使用者先誤以為 repo 為私密，經 Builder 以 GitHub API 與匿名請求確認為 Public 後，使用者正式選擇「接受公開推送」。

## 使用者確認（摘錄原文意旨）
- 理解該 repo 為 Public；Push 後程式碼、commit 歷史、Draft PR、Actions artifact 他人皆可讀取。
- 商業化與遵守 AGPL 等開源授權不互斥。
- 對其有權授權公開的 Enterprise 新程式，同意納入本次公開工程整合；既有第三方程式仍遵守各自授權與權利限制。

## 授權範圍
| 項目 | 授權 |
|---|---|
| Push 指定公開 repo 的獨立分支 | YES |
| 建立／更新 Draft PR | YES |
| 執行 GitHub Actions、使用合規 artifact | YES |
| 修復 CI 並追加 commit | YES |
| 直接 push `main`、force push、自動 merge | NO |
| 正式商業 Release、客戶正式部署 | NO |
| 推送到 `hades60414-sys/dhc-cli` | NO |

## 不因此改變的事
- 公開工程 PR ≠ 正式商業上市。G1（獨立審查）、G2（客戶 UAT）、G3（RD-002／003）、法律、SOW、價格仍是商業交付 Gate。
- 授權不延伸到他人未授權散布的程式；DAS 自製目錄（harness、web-ops、tools、remote-agent、local-model、migration、vendor）本整合未修改、未讀入。
- 公開內容須遵守 AGPL-3.0-or-later（`web-ui/LICENSE`、`web-ui/NOTICE` 保留）。

## 公開前檢查（Builder）
秘密、本機私人路徑、個人／公司識別、客戶資料、資料庫內容、QA 原始證據、大型 binary、Git LFS、可達歷史、CI artifact 白名單——結果見 `docs/enterprise/integration/PUBLICATION_SCAN.json`。限制：組織專用敏感詞表不存在，只跑通用規則。
