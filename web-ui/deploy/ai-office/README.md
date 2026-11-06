# DHC AI Office v0.1｜部署、備份、還原、升級手冊（單客戶）

> 本包只建立「本機可用」的單客戶實例（app 綁 127.0.0.1）。對外 HTTPS／存取控制（例如 Cloudflare Access）必須另經授權建置；未建置前不得讓員工從公網使用。

## 0. 前置

- Linux 或 macOS 主機，Docker Engine＋`docker-compose`（v2），可用磁碟 ≥ 8 GiB（建議 30 GiB 起）。
- 每個客戶一個唯一的 `COMPOSE_PROJECT_NAME` 與秘密目錄（0700，放在加密磁碟，**不得**提交到 Git）。
- **image 一律來自交付包**（`images/IMAGE_MANIFEST.json`＋`images.tar`，含 app 與 PostgreSQL）。不要用目前 Git HEAD 猜 image tag（ASTRA-017）。

```bash
export COMPOSE_PROJECT_NAME=dhc-<客戶代碼>
export DHC_SECRET_DIR=/secure/dhc/<客戶代碼>/secrets
export DHC_HTTP_PORT=3001
python3 deploy/ai-office/dhc-office.py preflight
```

## 1. 全新安裝（離線可用）

```bash
python3 deploy/ai-office/dhc-office.py init-secrets                      # DB 密碼與 BYOK 主金鑰（不覆寫）
python3 deploy/ai-office/dhc-office.py install-image <交付包>/images      # 驗 tar SHA-256 → docker load → image ID 必須與 manifest 相同
python3 deploy/ai-office/dhc-office.py up                                # db → migration → app；不 pull、不 build（pull_policy never）
ENTERPRISE_BOOTSTRAP_ADMIN_PASSWORD='<12 字元以上>' \
  python3 deploy/ai-office/dhc-office.py bootstrap <組織代碼> <組織名稱> <管理員 email>
python3 deploy/ai-office/dhc-office.py subscription <組織代碼> team active 2026-12-01 2027-11-30 "合約 #..."   # 供應商操作
```

`install-image` 把要用的 tag 與 image ID 記在 `$DHC_SECRET_DIR/image.env`；之後所有指令都用它，`up` 啟動前會再核對 image ID。
供應商打包：`python3 deploy/ai-office/dhc-office.py image-manifest <輸出目錄> <app tag> <postgres digest 參照>`（以 digest 釘選的 PostgreSQL 會另打本機 tag 出貨，安裝時以 image ID 驗證）。
開發者自行 build 時可不用 install-image，改設 `DHC_IMAGE`。

開啟 `http://127.0.0.1:${DHC_HTTP_PORT}/office`，以組織代碼＋管理員 email 登入，於「成員」建立員工、「模型與用量」設定模型（離線示範可選 mock）。

## 2. 備份（不停機）

```bash
python3 deploy/ai-office/dhc-office.py backup /secure/backup/<客戶>/$(date +%Y%m%d-%H%M)
```

一致性做法（ASTRA-015）：先 `pg_dump`（單一 snapshot），再封存 blob。blob 以內容雜湊命名、先寫檔再提交資料庫、從不刪除，
所以 dump 當下引用的每個 blob 一定在之後的封存裡（可能多出無害的孤兒檔）。接著把 dump 還原到暫存資料庫，計算**每一張表**的筆數與內容指紋、
schema／RLS／權限指紋，並逐一核對被引用 blob 的內容雜湊；任何缺漏都讓備份作廢。過程寫在 `<目錄>.partial`，成功才改名，失敗會自動清除、不影響運作中的系統。

產出 `enterprise.dump`、`blobs.tar`、`MANIFEST.json`（v2：檔案 SHA-256、migration、全表指紋、blob 驗證、各步驟耗時），全部 0600。
- 備份含客戶資料與已加密的 BYOK 金鑰：存放於加密媒體並**另存異機複本**；`ENTERPRISE_SECRET_KEY`（在 app.env）必須另外安全保存。
- 這是邏輯備份（沒有 WAL／時間點還原）：**可回復點＝最後一次備份**。建議至少每日排程，保留天數依客戶營運與法規需求分開訂定。
- 備份以資料庫管理角色執行（FORCE RLS 的表需要完整讀取權）；請只在主機本機操作。

## 3. 還原（災難復原／換主機）

只允許還原到**全新空安裝**（工具會拒絕覆寫已有資料）：

```bash
export COMPOSE_PROJECT_NAME=dhc-<客戶代碼>-restore  DHC_SECRET_DIR=/secure/.../restore-secrets
python3 deploy/ai-office/dhc-office.py init-secrets /secure/.../原 secrets/app.env   # 沿用原 BYOK 主金鑰
python3 deploy/ai-office/dhc-office.py install-image <交付包>/images
python3 deploy/ai-office/dhc-office.py restore /secure/backup/<客戶>/<時間>
```

工具會驗證每個檔案的 SHA-256，還原後重算全表與 schema 指紋、重新雜湊 blob volume，全部與 MANIFEST 相同才啟動 app，並回報還原耗時。
v1（舊版）MANIFEST 只能做筆數比對（輸出會標示 `legacy_v1_counts_only`）。
**注意**：若還原中途驗證失敗，目標資料庫已有部分資料，工具不會自動清除；請以 `docker-compose ... down --volumes` 移除該 restore project 後重新從頭還原。

## 4. 升級與回退

1. **先備份**（第 2 節）。
2. `install-image <新版交付包>/images`。
3. `python3 deploy/ai-office/dhc-office.py up`（套用新增 migration，已套用者為 no-op；checksum 被改動會拒絕）。
4. 失敗或驗收不通過的**回退方式＝以舊版交付包建立全新 project，將升級前備份 restore 進去**；migration 不提供有資料的 down（會被拒絕，避免遺失資料）。

> 跨版本升級／回退的實測結果見 RC-FIX V3 交付包 `ASTRA-011` 證據；異機復原需在客戶第二台主機執行（Builder 環境只能做同機不同 project）。

## 5. 診斷

```bash
python3 deploy/ai-office/dhc-office.py status     # 服務、就緒、migration 版本（不輸出秘密）
docker-compose -f deploy/ai-office/compose.yaml logs --tail 200 app
```

常見：登入一直 401 → 確認組織代碼與帳號是否被停權；上傳 402 → 訂閱到期（唯讀，資料不會刪除）；AI 草稿失敗 `ENTERPRISE_NO_SOURCES` → 先上傳可檢索文件（PDF 目前不可檢索）。

## 6. 停止與退場

`python3 deploy/ai-office/dhc-office.py down` 只停止服務、保留 volume。客戶退場時先備份並交付 `blobs.tar`（原始檔）與匯出資料，再依合約刪除 volume（需書面確認）。
