# TAS 安裝引導（整份貼給你的 AI Agent）

> 給人看的：在 repo 資料夾裡開 Claude Code（或 Codex），把這整份貼進去就好。它會先問你要拿來做什麼，再告訴你會改到電腦哪些地方，你點頭才動手；隨時可以說「先停」「還原」。

---

請你協助我把這個 repo（TAS：某證券中台團隊的 Claude Code 工作環境）裝到我的電腦上。repo 就在目前的工作目錄；不是的話先問我 repo 在哪裡。

我可能不是工程師。請用白話、繁體中文跟我說話，專有名詞第一次出現時用一句話解釋。

## 第 0 步：先自己看，不要問我

1. 讀 `README.md`、`安裝說明.md`、`SKILLS.md`，大概知道這包有什麼。
2. 檢查我的電腦（只讀，不改）：
   - `node --version`（要 22 以上）、`git --version`、`claude --version`（或 `codex --version`）
   - `%USERPROFILE%\.claude\` 裡有沒有 `CLAUDE.md`、`AGENTS.md`、`settings.json`、`skills\`，有的話列出現有的 skill 名稱
3. 用三五行告訴我檢查結果。缺工具就告訴我去哪裡裝，**不要替我下載或執行安裝程式**。

## 第 1 步：問我的使用場景（一次只問一題，每題附建議答案）

1. **你想用它做什麼？**
   - A. 只想試幾個 skill（例如做圖表、寫報告、對帳檢核），不想動我原本的設定 ← 第一次用建議選這個
   - B. 想要整套工作方式（回覆規則、驗證習慣、子代理、skills）
   - C. 我是幫團隊管一台共用主機的人，也想看網頁版、遠端代理、本地模型
   - D. 只想看設計思路，先不裝
2. **你的工作偏哪一類？**（決定推薦哪些 skill）中台／風控／財務、交易、作業、資訊、其他。
3. **回覆要用什麼語言、什麼風格？** 預設：繁體中文、先講結論、簡潔。
4. **要不要裝安全護欄？**（防止把金鑰、身分證字號送出去；危險指令要我回「確認執行」才跑）預設：要。
5. 選 B 或 C 時再問：**這台電腦是你一個人用，還是好幾個人共用？**

問完用一段話複述你理解的場景，讓我確認後再往下。

## 第 2 步：先給我看「會改什麼」，我說好才做

依我的答案列一張表：會新增哪些檔、會覆蓋哪些檔（我原本就有的要特別標出來）、備份放哪裡、怎麼還原。沒有覆蓋到任何東西也要明講。

- **A（試用）**：只把我挑的 skill 資料夾複製到 `%USERPROFILE%\.claude\skills\`。從 `SKILLS.md` 依我的工作類別推薦 3～5 個，每個用一句話說能幫我做什麼。同名 skill 已存在就先問我。
- **B／C（整套）**：
  1. 先讀 `harness\rules\CLAUDE.md`、`AGENTS.md`、`MIDOFFICE.md`，把裡面只適用原團隊的地方挑出來給我看（例如 GPT 委派已停用、pstack 外掛、中台紅線），問我要留、改、還是刪。改的是 repo 裡這份，不是 `.claude` 裡的副本。
  2. 依我選的語言與風格改 `Communication` 那段。
  3. 先跑 `powershell -NoProfile -ExecutionPolicy Bypass -File harness\ops\sync-harness.ps1 -Target Claude -Check`（只比對、不改），把會變動的清單給我看。
- **D**：帶我讀 `ARCHITECTURE.md`，用我的工作舉例說明每一層在做什麼，不要裝任何東西。

## 第 3 步：動手

- A：複製選好的資料夾。
- B／C：跑 `sync-harness.ps1 -Target Claude`（只用 Codex 的人改 `-Target Codex`），它會自動把被覆蓋的檔案備份到 `%USERPROFILE%\.claude\backups\harness-sync-<時間>\`。
- 要護欄：先跑 `node harness\ops\install-hooks.cjs --check` 給我看預覽，我同意再跑 `node harness\ops\install-hooks.cjs --guard`（它會先備份 `settings.json`、保留我原本的 hooks；我不想要繁中回覆檢查就加 `--no-zh`）。
- 規則裡有 pstack 外掛的段落：問我要不要裝 pstack（說明它是做什麼的、來源網址）；不裝就把 `rules\CLAUDE.md` 的「pstack workflow」段和 `@pstack-models.md` 那行刪掉，再同步。
- C：網頁版、遠端代理、本地模型都要額外的機器或帳號，先說明需要什麼、大概花多久，問我要不要今天做；不做就寫進最後的待辦。

## 第 4 步：驗證，然後教我用

1. B／C 跑 `harness\ops\healthcheck.ps1`（有用 Codex 加 `-Target All`），最後一行要是 `RESULT: OK`。只印 Ollama 的 INFO 可以忽略；其他失敗要修好或講清楚。
2. 有裝護欄就請我開一個新 session，把 `安裝說明.md` 第 2 步「試試看」的兩句給我直接貼，確認會被擋下。
3. 依我的工作類別，給我 **3 句可以直接複製的第一句話**（例如「把這份 Excel 的每日損益畫成趨勢圖」），每句說會用到哪個 skill。
4. 最後用五行以內告訴我：裝了什麼、備份在哪、怎麼還原（一句指令或步驟）、還沒做的事。

## 規則

- 一次只問一題；每題都附建議答案，我說「照建議」就用建議值。
- 改我電腦上任何現有檔案之前先備份，並告訴我備份位置。
- 不要把密碼、token、金鑰寫進任何檔案或對話；需要時請我自己用 `setx` 存成環境變數。
- 不要 push、不要對外發送任何東西、不要安裝 repo 以外的第三方套件或外掛（要裝先問我，並說明來源）。
- 我說「先停」就停；我說「還原」就照 `安裝說明.md` 第 6 步解除安裝，然後確認還原結果。
