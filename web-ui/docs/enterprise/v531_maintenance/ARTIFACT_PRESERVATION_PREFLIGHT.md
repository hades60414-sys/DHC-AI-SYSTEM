# Artifact 精確封存 Preflight（2026-11-07T07:50Z，GitHub API 唯讀核對）

> 本文件是**檢查結果與提案**。沒有推送任何 package，沒有公開任何東西，沒有修改 registry、repo 或 Actions 權限，也沒有重建 image。

## A. 可封存的原始 image（tar.gz artifact）
三種值分開記錄，不可混用：
- **artifact zip digest**：GitHub 對 artifact zip 計算的 digest。
- **tar sha256**：原始 `docker save | gzip` 檔案的雜湊。
- **image id**：image config digest。
- **build SHA**：建置所用的 commit（image label `source_revision`）。

| 優先 | Artifact | arch | build SHA | 存在 | 到期（UTC） | 大小 | artifact zip digest | tar sha256 | image id |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 13564593892 | amd64 | `0e5b470`（F1） | ✅ | 2026-11-08 06:58 | 286,037,151 | `e269c7fd…67e3` | `dc95b5343b183e4eb122f6b5c1d38d195782018324627940a05fb06bc0453c45` | `sha256:b1569cc3e68b320774b77ec4851b40387cef9f6ff2b69006dddb34a5f9461e68` |
| 1 | 13565136328 | arm64 | `0e5b470`（F1） | ✅ | 2026-11-08 06:58 | 284,570,981 | `eee54338…f653` | `5c89131c888dfe1b09f68d1ce5e8a29a5c3c675b102eaf119cb8142c49ef021c` | `sha256:269013852e2ff36910933359eacf0e3abd903738d8fb18ba73aea60006cebefb` |
| 1 | 13565206331 | amd64 | `38c7293`（F2） | ✅ | 2026-11-08 07:08 | 286,046,263 | `48a0484f…c758` | `15a85a9a1dd38acd1223630f176c05e1763100a7c7ba238b69acf7d648bcabd0` | `sha256:637d0c09b1e1336dd2469cb7230e36d2c58edc9234babfbd6d11629dc268435f` |
| 1 | 13564983710 | arm64 | `38c7293`（F2） | ✅ | 2026-11-08 07:07 | 284,572,528 | `5b34f138…70a5` | `a6d8cc2fe6801c36e5dc76023ffd74688f934278222dfc5d30c1c01bff1259f0` | `sha256:c1a503d91204cd2254a5cee60bf8f32bcb67bb6afe424c5b83c6d190c4eba1b7` |
| 2 | 13532483924 | amd64 | `d38afd8`（V5.2 產品） | ✅ | **2026-11-07 19:08** | 286,039,901 | `f7a9999f…537e` | `f8ad9b8a5016a6fc353a12b27aeff7dcb0b0e701241855a1627cf80191f1dc8e` | `sha256:00d56aaa2e0193b32c9930aed76e13966e4c2e80330e46b0660eaa7adce56782` |
| 2 | 13532064487 | arm64 | `d38afd8`（V5.2 產品） | ✅ | **2026-11-07 19:08** | 284,567,169 | `6b18e0dc…f3d8` | `8d771e62c76e89eb43c8c7495d84a15db3c37cc89fd328ea1254381a37298ce7` | `sha256:b955436e1c04b0a907c8c644d4892c9a4baa5890f27d74b23ec898e81c1bc082` |
| 3 | 13518872742 | amd64 | `6933d5e`（V5.1） | ✅ | **2026-11-07 15:57** | 286,019,908 | `152cca7b…07e5` | `d837b07d666f36523f2856b74109fe091aeb47a9ce3bcd9038d92281aa85992c` | `sha256:154a986fd20941400e10c1595007119162ba0d76c29c6ef6302084d6161afabe` |
| 3 | 13519032525 | arm64 | `6933d5e`（V5.1） | ✅ | **2026-11-07 15:57** | 284,569,524 | `b28d92ee…76cd` | `f7d4bc586f0798161b213b518293b6d65af33879d8a9ad530fd343afdcca6073` | `sha256:eda9b596dcc11ec681721b5054bffdfe9a21dd76660f685fc8c1c5bd6b18f880` |

- **F1 與 F2**：兩次建置的產品程式相同（d38afd8），只是 label 的 revision 不同，所以 image id 也不同。若只封存一組，建議選 **F1**：完整證據 CI 跑的是它。
- **V5.2 產品 SHA 的 image**：是 Astra 可能比對的「產品」本體，但今天 19:08Z 就到期，時間最緊。
- **封存狀態**：**8 個都尚未封存。** GitHub 無法延長 artifact 保存期。

## B. GHCR Private Preflight
| 檢查項 | 結果 | 依據 |
|---|---|---|
| Organization 是否允許建立 Package | **不適用**：repo owner `hades60414-sys` 是 **User** 帳號，不是 Organization | `GET /users/hades60414-sys` → type=User |
| Package 能否維持 Private | **可以**。GitHub 文件："When you first publish a package, the default visibility is private." | docs: working-with-the-container-registry |
| 是否繼承 Public repo 的權限 | 連結 repo 時會繼承**存取權限，但不繼承 visibility**："inherits the access permissions (but not the visibility)"。注意：若讓 public repo 存取 private package，"forks of the repository may be able to access the private packages" | docs: configuring-a-packages-access-control-and-visibility |
| Actions 能否限制在人工核准後才執行 | 技術上可以：用 environment 的 required reviewers，Free 方案限 public repo。但個人帳號 repo 的 environment **只有 repo owner 能設定**（"you must be the repository owner"）。目前 environments：0 個 | docs: managing-environments-for-deployment；`GET /environments` → 0 |
| 目前使用者能否管理 Package | **不能**：登入帳號 `juhjuhx` 的 repo 權限是 write（非 admin）；token scopes 只有 gist／read:org／repo／workflow，**沒有 read:packages／write:packages**，列出 packages 回 403 | `gh auth status`；`GET /collaborators/juhjuhx/permission` |
| 誰能核准與設定 | 只有帳號擁有者 **`hades60414-sys`**：可建立 environment、設 package 為 private、管理 package 權限（需 package admin）。沒有 Organization Owner | 同上 |
| 誰能推送 | 以 `GITHUB_TOKEN` 從該 repo 的 workflow 推送，會自動連結 repo。但「`packages: write` 權限區塊」的寫法官方頁面在本次擷取內容中沒有明寫，實作前需再確認。若同一 namespace 先前有人以命令列推過**未連結**的 package，GITHUB_TOKEN 會無權推送 | docs: container registry |

### 保存原始 tar 與保存 OCI image 的差異
| 方式 | 保留什麼 | 不保留／會改變什麼 |
|---|---|---|
| **OCI image 推送**（`docker load` 後 `docker push`） | image id（config digest）通常保留 | 產生新的 **registry manifest digest**；layer 會重新壓縮，blob digest 與 tar 內容不同；**原 tar sha256 無法用來驗證 registry 內容** |
| **原始 tar 當成 OCI artifact 推送**（例如 `oras push` 原檔，不解壓） | **原 tar.gz 的位元完全相同**；registry 中 blob digest＝`sha256:<tar sha256>`，可直接驗證 | 不能直接 `docker pull`，要先 `oras pull`、再 `docker load` |
| 建議 | **兩者都做**：artifact 方式保存精確位元（對應 tar sha256）；image 方式方便部署（對應 registry digest）。四種值分開記錄：tar sha256、registry digest、image id、build SHA | — |

### 空間與費用
- 空間：每組（amd64＋arm64）約 0.57 GB；F1＋F2 約 1.14 GB；加上 V5.2／V5.1 約 2.28 GB。若兩種方式都做，約加倍（image layer 有部分共用，實際會小於兩倍）。
- 費用依 GitHub 文件：
  - "Container image storage and bandwidth for the Container registry is currently free."
  - 若之後改為計費，private package 計入方案額度：Free 500 MB／1 GB 傳輸，Pro 2 GB／10 GB；超出依官方價格計算器。
  - 頁面沒有列出每 GB 單價。
  - 用 GITHUB_TOKEN 在 hosted runner 傳輸免費。
- 不在本機 Mac 保存。

## 結論：目前不可行，需要帳號擁有者
目前的權限**無法安全執行**私有封存：
- 我無法設定或確認 package visibility；
- 無法建立人工核准的 environment；
- token 沒有 packages scope。

若在 environment 未設定的情況下用 `GITHUB_TOKEN` workflow 推送，雖然預設是 private，但我**無法事後驗證 visibility、也無法限制存取**，不符合授權邊界，因此本輪停止。

要在到期前完成，需要 **`hades60414-sys`（帳號擁有者）** 依下列順序操作或授權：
1. 建立 environment `archive`，設定 required reviewer＝owner。
2. 核准由 Builder 提交一個只能 `workflow_dispatch`、綁 `archive` environment、`permissions: {contents: read, actions: read, packages: write}` 的封存 workflow。這個 workflow 以 `actions/download-artifact` 取用**原始 tar**（不重建），先用 oras 推原檔，再推 image。
3. 推送後由 owner 確認 package 是 **Private**，並視需要取消 repo 存取繼承（避免 fork 取用）。
4. Builder 記錄 tar sha256、registry digest、image id、build SHA。

若無法確認是 private，就停止，不轉為公開封存。

另有一個替代做法，也需要 owner 核准：owner 自己下載 artifact，保存在 owner 受控的私有儲存。GitHub 仍會依 artifact 到期時間刪除 GitHub 端的檔案。
