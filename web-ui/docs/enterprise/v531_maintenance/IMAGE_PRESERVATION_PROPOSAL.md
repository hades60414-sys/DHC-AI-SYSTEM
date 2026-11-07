# Image 保存提案（GHCR Private Package）

> 本文件是**提案**。在使用者或 Repository Owner 核准前，不會推送任何 package，也不會改變產品的部署方式。

## 現況（2026-11-07 用 GitHub API 唯讀核對）
| 來源 | arch | Artifact ID | 內容 | 到期（UTC） |
|---|---|---|---|---|
| F1 `0e5b470` run 42349084776 | amd64 | 13564593892 | image tar（tar sha256 `dc95b534…3c45`） | **2026-11-08 06:58** |
| F1 run 42349084776 | arm64 | 13565136328 | image tar（`5c89131c…f021c`） | **2026-11-08 06:58** |
| F2 `38c7293` run 42349749608 | amd64／arm64 | 13565206331／13564983710 | image tar | **2026-11-08 07:08** |
| V5.2 產品 SHA `d38afd8` run 42276319770 | 兩架構 | 7 個 artifact | image tar＋report | **2026-11-07 19:08（今天）** |
| V5.1 `6933d5e` run 42247102627 | 兩架構 | 7 個 artifact | image tar＋report | **2026-11-07 15:57（今天）** |
| image report／SBOM／Trivy（F1） | 兩架構 | 13564901182 等 | SBOM、Trivy、build command | 2026-11-14 |

- GitHub artifact 無法延長保存期限。到期後只剩 repo 內的紀錄：image id、tar sha256、SBOM 摘要、Trivy 計數、建置指令（見 `v53/SUPPLY_CHAIN_PROVENANCE.json`）。
- 產品程式沒有變（`d38afd8`），所以之後可以用同一份 Dockerfile 與固定的 base digest 重建。但**重建出的 image id 不保證位元相同**：時間戳與套件 mirror 都可能改變結果。
- 因此，如果需要「精確二進位」，就必須封存；本機 Mac 不做備份。

## 方案：GHCR private package
1. **Package 與權限**
   - 位置：`ghcr.io/hades60414-sys/dhc-ai-office`，visibility 設為 **private**。
   - Package 設定：連結到 repo `DHC-AI-SYSTEM`；只授權 repo 的 Actions 寫入（`packages: write` 只給封存 workflow），人員只給讀取。
   - 封存 workflow：只能 `workflow_dispatch`，並且限定在受保護的 environment `archive`，需要 owner 核准。
2. **推送內容**
   - 使用同一個 run 中 buildx 產出的 multi-arch manifest，以 digest 為準；不使用 `latest`。
   - tag 例如 `v5.3.1-<short sha>`，只是方便查找的標籤。
   - 記錄 manifest digest 與各架構 digest。
3. **SBOM**：用 `cosign attach sbom`（或 OCI referrer）把現有的 CycloneDX `sbom.cdx.json` 掛到 digest 上。
4. **Attestation**：用 `actions/attest-build-provenance` 產生 SLSA provenance，掛到 GHCR digest。這需要 `id-token: write` 與 `attestations: write`，屬於 GitHub 原生的 Sigstore keyless 簽章，不需要自管金鑰。
5. **Registry Access**
   - 客戶端用 read-only 的 fine-grained PAT 或 deploy token 拉取，用完即撤。
   - 離線交付仍以 tar 為主：先從 GHCR pull，再 `docker save`。
6. **Retention**：封存的 digest 永不自動刪除；非封存的 tag 用 package 清理規則，例如保留最近 N 個。
7. **Rollback**
   - 回退時以 digest 指定前一版，沿用已驗證的 `dhc-office.py` 升級與回退流程。
   - 封存不改變部署方式：`DHC_IMAGE` 仍可指向本地 tag，只是多了一個可追溯的來源。
8. **成本與權限**
   - 私有 GHCR 的儲存與傳輸依 GitHub 方案計費，有免費額度，超出要付費。目前每次約 2 × 285 MB 壓縮檔，確切費用以帳號方案為準。
   - 需要 repo admin 或 package admin 設定 visibility 與 Actions 存取，並需要 owner 核准 `archive` environment。

## 決策選項
| 選項 | 內容 | 結果 |
|---|---|---|
| A | 核准 GHCR 封存 F1 `0e5b470` 的 image | 推送 multi-arch manifest＋SBOM＋attestation |
| B | 不封存二進位 | 接受「之後重建、image id 不同」，只保留 repo 內的 provenance 紀錄 |
| C | 只在正式 release 時才封存 | 目前 COMMERCIAL_RELEASE_NO_GO，維持現狀 |

不論選哪一項，都不會在本機保存大型 image。
