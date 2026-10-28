# domains：用途包

`domains/` 底下每個子資料夾是一個用途（domain）包，裡面是一組給 AI Agent 用的 skill。要啟用哪一個，由 `dhc.config.json` 的 `"domain"` 欄位決定，欄位說明見 [docs/dhc-config.md](../docs/dhc-config.md)。

| `domain` 值 | 對應內容 |
|---|---|
| `general` | 不套用任何用途包（預設）。 |
| `finance` | [domains/finance](finance/README.md)，金融中後台常用的檢核與報表 skill。 |

## 怎麼使用用途包

用途包本身只是 Markdown 檔，不會自動載入。選一種方式讓 Agent 讀到：

1. 複製 skill 資料夾。把 `domains/<name>/` 底下的 skill 資料夾（每個含一份 `SKILL.md`）複製到 Agent 的 skills 目錄：
   - Claude Code 全域：`~/.claude/skills/<skill 名>/SKILL.md`
   - 單一專案：專案資料夾內的 `.claude/skills/<skill 名>/SKILL.md`
2. 或在工作區的 `CLAUDE.md` 裡引用，例如「做損益調節時，先讀 `domains/finance/pnl-recon/SKILL.md`」。

複製後 Agent 會依 `SKILL.md` 的 `description` 判斷何時套用。改了用途包內容，記得重新複製。

## 新增一個用途包

1. 建立 `domains/<name>/`，`<name>` 用小寫英數與連字號。
2. 每個 skill 一個資料夾，裡面放 `SKILL.md`。檔案開頭是 YAML frontmatter：

   ```markdown
   ---
   name: my-skill
   description: 說明這個 skill 做什麼，以及在什麼情況下應該觸發。
   ---
   ```

   `description` 要寫清楚觸發時機，Agent 靠它決定是否載入。
3. 內容保持通用：不放公司名、主機名稱或 IP、內部系統或表名、人名、真實代號與帳號。需要指涉資料時用 `<部位表>`、`<市價來源>` 這類佔位符。
4. 提交前在 repo 根目錄執行 `node tools/scan-sensitive.mjs`，有命中就改寫到乾淨為止。
5. 在 `dhc.config.json` 設 `"domain": "<name>"`，重啟伺服器。
