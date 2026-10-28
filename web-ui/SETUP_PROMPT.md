# DHC CLI 設定引導（整份貼給你的 AI Agent）

你是協助我設定 DHC CLI 的 AI Agent。DHC CLI 的 repo 就在目前的工作目錄（如果不是，先問我 repo 在哪裡）。請照下面的步驟做，**一次只問一題**，等我回答再問下一題。問完四題後再動手改檔案。

先讀 `docs/dhc-config.md` 了解 `dhc.config.json` 每個欄位的意思。

## 要問我的四題

1. **個人還是團隊？**
   - 個人：`"mode": "personal"`。團隊功能（設定檔選擇、Co-Work 邀請／分享、頭像、多人待辦）先封起來，畫面比較單純。
   - 團隊：`"mode": "team"`，全部打開。適合好幾個人共用同一台主機。

2. **有沒有遠端工作需求？**（例如在家或用手機連回這台機器）
   - 沒有：`"remote": { "enabled": false }`，只在本機跑，不需要 Cloudflare。
   - 有：`"remote": { "enabled": true }`，然後照 `modules/remote/README.md` 一步一步帶我裝。先確認伺服器只綁 `127.0.0.1`、DHC CLI 的登入帳號已經建好，才開通道。密碼、金鑰要我自己輸入，不要寫進任何檔案或對話。

3. **用哪一款 AI Agent？**（Claude Code、Codex、Cursor、OpenCode，可以複選）
   - 寫進 `"agents"`，例如 `["claude", "codex"]`。
   - 順便給我模型分工建議：主力規劃、架構判斷、難題用最強的模型；機械性工作（批次改名、照規格寫測試、整理格式）用較便宜的模型。說明在我選的 Agent 裡要怎麼切換或指定。
   - 檢查我選的 Agent 有沒有裝好、登入了沒（例如執行 `claude --version`、`codex --version`），沒有就告訴我去哪裡安裝，不要替我下載或執行安裝程式。

4. **用途是什麼？**
   - 金融業（交易、作業、風控、會計相關）：`"domain": "finance"`，並說明 `domains/finance/` 裡的五個 skill 怎麼放進我的 Agent 技能資料夾（見 `domains/README.md`）。
   - 其他用途：先用 `"domain": "general"`，之後可以照 `domains/README.md` 自己加用途包。

另外問一句工作區要放哪裡；沒有特別要求就維持 `"workspaceRoot": "DHC Workspace"`（家目錄底下）。

## 動手

1. 修改 repo 根目錄的 `dhc.config.json`，只改上面問到的欄位，保持合法 JSON。
2. 給我看改動前後的差異。
3. 驗證：
   - `node -e "JSON.parse(require('fs').readFileSync('dhc.config.json','utf8'))"` 沒有錯誤。
   - 重啟伺服器（`npm run server`；沒 build 過先 `npm run build`），log 裡不應出現 `[dhc-config]` 警告。
   - 登入後用瀏覽器打開 `http://127.0.0.1:3001`，確認：個人模式看不到 Co-Work 與頭像、團隊模式看得到；新對話的 Agent 清單只出現我選的那幾個。
4. 用三五行告訴我設定結果，以及之後想改要改哪個欄位。

## 規則

- 只改 `dhc.config.json`；其他檔案要改先問我。
- 不要把任何密碼、token、金鑰寫進 repo 或回覆。
- 不要 push、不要對外發送任何東西。
