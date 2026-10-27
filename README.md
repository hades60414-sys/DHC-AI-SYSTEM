# TAS — 團隊共用的 AI Agent 工作環境

TAS 是某證券中台團隊在一台共用主機上運作 Claude Code 的整套做法：行為規則、skills、子代理、安全護欄、網頁版周邊服務、遠端代理程式與日常小工具。這個 repo 是去除公司資訊後的版本，給跨部門參考與協作用。

> 名稱對照：文件裡的「某證券」「某金融集團」、`DHC`、`EKB`（企業知識庫）、`srv-db`／`srv-rag` 這類主機代號、`userA`～`userG`／「同事A」～「同事G」都是替換後的代稱；IP 一律是 `10.255.0.x` 假網段，email 是 `example.*` 網域。

## 內容

| 資料夾 | 是什麼 | 適合誰 | 入口 |
|---|---|---|---|
| `harness/` | 規則（CLAUDE.md／AGENTS.md）、約 50 個 skills（一覽見 [SKILLS.md](SKILLS.md)）、9 個子代理、hooks、`dhc-guard` 危險指令攔截 mod、同步與健康檢查腳本 | 每個人 | [harness/README.md](harness/README.md) |
| `web-ops/` | 網頁版（DHC CLI）旁邊的常駐服務與排程維運（`cc-hosts/`）：去識別模型代理、seal-proxy 閘門、Cloudflare Worker、團隊小助手的護欄／提醒／記憶整理、撞額度自動續跑、閒置才重啟 | 管共用主機的人 | 各檔開頭註解 |
| `remote-agent/` | 遠端代理程式：控制端經公開信箱送「簽章＋加密」的工作給內網主機，代理程式只做白名單動作（唯讀 SQL、文件問答、受限 CMD、搬遷沙盒）；含 MCP server | 進階：要跨網段遠端操作 | [remote-agent/README.md](remote-agent/README.md) |
| `local-model/` | 離線本地模型（llama.cpp server）安裝與測試腳本 | 有 GPU、想離線跑模型 | [local-model/DELIVERY.md](local-model/DELIVERY.md) |
| `tools/` | 動作閘門（提案動作放行／停下）、本地文件問答與評估、內網網頁測試沙盒、文件掃描、提醒、第三方技能更新檢查、skill 用量統計、專案記憶範本 | 挑著用 | 各資料夾 README |
| `migration/` | 主機搬家工具：加密分段打包、路徑改寫、搬家用 Cloudflare Worker | 進階：主機搬家 | 各檔開頭註解 |
| `vendor/` | 原樣附上的第三方外掛：pstack、ctx-handoff（MIT）、frontend-design（Apache-2.0），授權檔在各資料夾 | 想要完整工作流程的人 | [SKILLS.md](SKILLS.md) |
| `scripts/` | `scan-sensitive.mjs`：上傳前的敏感字掃描 | 分享前每個人 | 見下方 |

網頁版本身（CloudCLI 的 fork，AGPL-3.0）另有獨立 repo「DHC CLI」，這裡只放它旁邊的服務。

## 怎麼用

> [!TIP]
> **第一次用，挑一條路就好：**
> - **讓 AI 帶你裝（最省事）**：在這個資料夾開 Claude Code，把 [SETUP_PROMPT.md](SETUP_PROMPT.md) 整份貼進去。它會先問你要拿來做什麼、先給你看會改到哪些檔案，你同意才動手，也會教你還原。
> - **只想試幾個 skill**：看 [SKILLS.md](SKILLS.md) 依工作挑，複製單一資料夾就能用，不動你原本的設定。
> - **自己一步一步裝**：看 [安裝說明.md](安裝說明.md)。

1. **只想借規則與 skills**：讀 [harness/README.md](harness/README.md)，在 Windows 跑 `harness\ops\sync-harness.ps1 -Target All`，再跑 `harness\ops\healthcheck.ps1` 看到 `RESULT: OK`。新開的 Claude Code session 會自動載入。
2. **想看設計思路**：先讀 [ARCHITECTURE.md](ARCHITECTURE.md)，再挑有興趣的元件看程式開頭的註解；每支腳本開頭都寫了用途與限制。
3. **要搬到自己的環境**：程式裡的路徑（`D:\TAS\...`、`C:\Users\demo\...`）、主機代號與 IP 都要換成實際值。多數腳本是 Windows＋Node.js；PowerShell 腳本以 Windows PowerShell 5.1 為準。

不含的東西：Claude Code 執行檔、模型權重、任何金鑰或 token、對話紀錄與記憶、資料庫內容、公司內部文件。

## 上傳前檢查

```bash
node scripts/scan-sensitive.mjs
```

內建規則找使用者路徑、私有 IP、「點＋兩三位數字」的主機代號、email、長得像金鑰的字串；組織專屬的字放在 repo 外的一個 JSON 檔，用環境變數 `SCAN_SENSITIVE_TERMS` 指過去（格式見 `scripts/scan-sensitive.example.json`；名單本身不要放進 repo）。印出 `clean` 才上傳。

## 授權

第三方內容的來源與授權見 [THIRD-PARTY.md](THIRD-PARTY.md)；MIT 授權的第三方 skill 保留原授權檔在各自資料夾。其餘自寫內容僅供內部協作參考，對外散布前請先確認授權方式。
