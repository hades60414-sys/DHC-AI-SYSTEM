# Skills 一覽（依工作挑）

Skill 是一份寫給 AI 的做事說明，放在 `%USERPROFILE%\.claude\skills\<名稱>\`。裝好之後不用記名字：照平常的話講（例如「幫我把這份損益畫成圖」），AI 會自己挑對應的 skill；也可以直接打 `/名稱` 叫它。

**只想試一兩個**：把 `harness\skills\<名稱>` 整個資料夾複製到 `%USERPROFILE%\.claude\skills\`，開新 session 就生效；不要了刪掉那個資料夾即可。

⭐ = 第一次用建議先試。

## 中台、風控、財務

| Skill | 幫你做什麼 |
|---|---|
| ⭐ `tas-charts` | 把資料做成單檔 HTML 圖表或日報／月報頁，離線可開，紅漲綠跌、億／百萬照台灣慣例 |
| ⭐ `pnl-recon` | 每日損益調節：flash 對 actual、損益拆解、對不上時照決策樹找原因，不硬湊 |
| `data-quality-gate` | 市價與部位資料檢核：過期價、離群值、缺漏，有問題的資料不進結論 |
| `position-limit-review` | 部位／限額使用率、超限分級與升級路徑；只讀只算只報 |
| `risk-metrics-review` | VaR、Greeks、壓力測試的合理性覆核，也能當教材 |
| `eod-report-discipline` | 日終監控報表的固定骨架：例外優先、數字驗證鏈、今日無事也要出 |
| `nl-db-query` | 用白話問資料庫（筆數、最大最小、缺哪幾天），附出處；只讀 |
| `data-window` | 把一個資料庫包成唯讀 API＋說明文件，讓 AI 自己撈資料 |

## 報告、簡報、影片

| Skill | 幫你做什麼 |
|---|---|
| ⭐ `design-presentations` | 規劃與產出簡報（圖片式、網頁式或可編輯 PPTX），從內容推版面而不是套模板 |
| `editorial-vision-studio` | 海報、封面、主視覺、AI 生圖提示詞的視覺方向 |
| `video-studio` | 從分鏡做成有旁白、字幕、配樂的說明動畫 MP4 |
| `ui-polish`、`ui-ux-pro-max` | 網頁畫面優化：排版、配色、動效、無障礙 |

## 工作方式與溝通

| Skill | 幫你做什麼 |
|---|---|
| ⭐ `caveman` | 回覆精簡模式，省字數也省額度（`/caveman`） |
| `i-have-adhd` | 把回覆整理成一步一步的行動清單（要明講才啟用） |
| `buddhist-method` | 卡關、被質疑、長任務時的思考紀律：先查證再下結論、找根因不貼膏藥 |
| `past-conversations` | 搜尋以前的對話與記憶：「上次怎麼做的？」 |
| `baton` | 工作做到一半要交給下一個 session 時寫交接 |
| `tas-taste` | 原團隊從過去糾正提煉的交付品味準則，交付前自審用 |

## 寫程式

| Skill | 幫你做什麼 |
|---|---|
| ⭐ `diagnosing-bugs` | 難搞 bug、效能問題的診斷流程 |
| `code-review` | 依 repo 的規範與需求審一段變更 |
| `tdd` | 先寫會失敗的測試再實作 |
| `ponytail` 系列（6 個） | 找最省事的寫法、抓過度設計、列出刻意欠下的技術債 |
| `codebase-design`、`domain-modeling` | 模組介面與領域用語設計 |
| `writing-for-agents` | 寫 skill、CLAUDE.md 這類給 AI 讀的文件 |
| `statechart`、`statechart-whiteboard` | 畫狀態圖、把形式驗證找到的 bug 路徑畫出來 |
| `reverse-engineer-anything` | 對已編譯的程式做逆向分析 |

## 安全與維運

| Skill | 幫你做什麼 |
|---|---|
| ⭐ `scan-before-install` | 裝任何第三方 skill／外掛／套件之前先掃描 |
| `security-audit` | 資安稽核：威脅建模、OWASP、信心分級 |
| `reuse-before-build` | 要自己做工具之前，先找有沒有現成的 |
| `harness-sync` | 把這套設定同步到 Claude Code 與 Codex、檢查兩邊差異 |

## 多代理與進階（熟了再看）

| Skill | 幫你做什麼 |
|---|---|
| `agent-patterns` | 設計 agent／RAG／多代理架構時的模式目錄 |
| `baton-dispatch` | 判斷要不要把工作拆給多個子代理、怎麼拆才不互相踩 |
| `pilotfish-orchestration` | 多模型協作規則（要明講才啟用） |
| `opus-efficient`、`opus-effort-audit` | 長程式任務的精簡執行與事後檢討 |

## 停用或只給特定環境

| Skill | 狀態 |
|---|---|
| `codex-bridge`、`codex-scout`、`codex-worker`、`codex-verifier`、`chatgpt-bridge` | 委派給 GPT／Codex 的橋接；原團隊已停用，需要 Codex CLI 或 ChatGPT 才能用 |
| `spark-worker` | 只給 Codex 用 |
| `cross-model-verify`、`sub-agents`、`subagent-driven-development` | 已退役，留作參考，同步時不會安裝 |
