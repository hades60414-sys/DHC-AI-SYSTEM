---
name: security-audit
description: 資安稽核(CSO 模式)。當使用者要「資安稽核 / 找漏洞 / security audit / OWASP review / 威脅建模 / STRIDE / pentest review / 檢查有沒有資安問題」時使用。信心分級、零噪音、stack-first;先認技術棧再查,特別留意「算錢/處理重要資料」的邊界。萃取自 gstack /cso v2 方法論(再綜合 Sentry / Trail of Bits / OWASP),重寫為自有內容、無自更新/telemetry。
---

# security-audit — 資安稽核(CSO 模式)

對一個 repo 做有紀律的資安稽核。**靈魂:零噪音 + 信心分級 + stack-first**——只報你真的查證過、夠高信心的問題,不丟一堆 pattern 誤報浪費人。

## 兩種模式(先問用哪個)
- **daily(預設)**:零噪音,**只報信心 ≥ 8/10** 的發現。適合每次大改前快掃。
- **deep(月掃)**:信心 ≥ 2/10 全列,含 STRIDE 完整威脅建模 + variant 全庫掃。適合上線前/定期深審。

## 鐵則(怎麼查才不是在湊數)
1. **Stack-first**:先認棧(Python/Streamlit?React?FastAPI?資料 pipeline?),**只跑該棧相關的檢查**,別用全語言 pattern 製造噪音。
2. **Trace-before-flag**:看到可疑點**先追資料流**——這個輸入哪來?上游有沒有驗證/參數化?確認真的可達、可利用,才報。
3. **Variant 分析**:找到一個洞 → `Grep` 全庫搜同一個 pattern,通常不只一處。
4. **主動驗證**:能構造一個 PoC/觸發條件就附上;純 pattern 命中標 LOW 信心。
5. **信心分級報告**:每條標 信心(1-10)+ 嚴重度 + 檔:行 + 修法 + 為什麼。低於模式門檻的不報(或收進附錄)。

## 稽核階段(14 步,daily 可只跑 0-3 + 7-9 + 12-13)
- **0 架構心智圖 + stack 偵測**:讀進入點、框架、信任邊界。
- **1 攻擊面普查**:對外的 input(路由、表單、上傳、API、CLI 參數、env、檔案讀取)。
- **2 密鑰考古**:`.env`/原始碼/git 歷史裡的金鑰、token、密碼**絕不該進 git**;掃 `git log -p` 看有沒有洩過。把金鑰放專案外的設定或環境變數,並加進 `.gitignore`。
- **3 相依供應鏈**:`pip`/`npm` 已知 CVE(`pip-audit` / `npm audit`)、可疑套件、鎖檔。→ 接 `[[scan-before-install]]`(skill/MCP 那層)。
- **4 CI/CD**:GitHub Actions 等的密鑰外洩、不可信 PR 跑 secret、未鎖版 action。
- **5 影子基礎設施**:開在 0.0.0.0 的服務、debug 埠、未保護的 dev server(本機常一堆 streamlit/uvicorn/vite 對外開,記得收)。
- **6 Webhook / 整合**:外部回呼有沒有驗簽。
- **7 LLM / AI 資安(現代專案的重點)**:
  - **Prompt injection**:若有「截圖/文件 → LLM 解析」「自然語言 → 動作」這類流程——惡意圖片/輸入能否改指令、外洩資料、觸發危險操作?
  - 工具呼叫權限、RAG/資料投毒、模型輸出直接 `exec`/SQL 的危險。
  - 若專案有**刻意的已知取捨**(例:內部開發工具開全權限)——稽核時標記、確認沒被未驗證輸入觸發,不要當新發現亂報。
- **8 Skill 供應鏈**:第三方 skill/plugin/MCP → 走 `[[scan-before-install]]`(SkillSpector)。
- **9 OWASP Top 10**:注入(SQL/cmd)、認證、敏感資料暴露、XXE、存取控制、設定錯誤、**XSS**、不安全反序列化、已知漏洞元件、紀錄不足。
  - 高頻雷:**Streamlit `unsafe_allow_html=True`** 注入到使用者/資料衍生內容 = XSS;**f-string 組 SQL**(SQLite/Postgres)= 注入,改參數化;**`pickle`/`joblib.load`/`yaml.load`** 反序列化不可信資料;`subprocess`/`os.system`/`eval` 帶外部輸入;檔案上傳路徑穿越。
  - React/前端:`dangerouslySetInnerHTML`、把 secret 打進 client bundle、localStorage 放敏感資料。
- **10 STRIDE 威脅建模(deep)**:對每個信任邊界跑 Spoofing/Tampering/Repudiation/Info-disclosure/DoS/Elevation。
- **11 資料分級**:哪些是 PII / 金流 / 個資 / 金鑰,有沒有對應保護。
- **12 誤報過濾 + 主動驗證**:逐條套上面鐵則 2-4,砍掉不可達/已緩解的。
- **13 分級報告 + 趨勢**:`SECURITY_AUDIT.md`——每條 信心/嚴重度/位置/修法;跟上次比新增/已修。
- **14 存檔**:報告寫進 repo(不 push,等使用者審)。

## ⚠️ 「算錢/重要資料」邊界特別檢查
若專案涉及**金錢、交易、估值,或處理重要資料**,每次稽核**必加一條**:確認「呈現/UI 層」(尤其 `[[ui-polish]]` 那種自動改樣式的迴圈)**無法經由任何輸入污染到計算/下單/schema** —— 注入若能改數字或觸發交易,一律 CRITICAL。

## 收尾
給 daily/deep 的**信心分級清單**,別丟原始 pattern 噪音。修法具體到檔:行。沒把握的標 LOW 信心、別當定論。
