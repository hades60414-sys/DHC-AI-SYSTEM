# mods（Claude Code ≥ 2.1.287，只給 Claude 用，Codex 不適用）

本機目錄型 marketplace `dhc-mods`，目前只有一個 mod：

- `dhc-guard`：
  - 本機 python 偵測函式還留在 `rules.js`，但 2026-10-27 起不再攔（register.js 已拿掉呼叫）；要恢復就在 register.js 接回。
  - 危險指令（rm -r、force push、git reset --hard、git clean、Remove-Item -Recurse、rmdir /s、DROP、TRUNCATE、DELETE 不帶 WHERE，也包含 MCP 的 ragent_sql／ragent_cmd）先擋下，使用者本人回覆「確認執行」後才放行一次，回合結束就失效。待確認的指紋存在 `$.store`（依 session、15 分鐘失效），網頁版每則訊息換程序也接得上（10-24 修；以前只放記憶體，網頁版確認永遠不生效）。
  - 不使用 `$.fs`、`$.process`、`$.http`；只用 `$.session.id` 與 `$.store`。改完原始碼要複製到 `C:\Users\demo\.claude\plugins\cache\dhc-mods\dhc-guard\0.1.0\hooks`（正式載入的是這份）。
  - settings.json 原本的 deny 規則（例如 `Bash(rm *)`）仍然優先；mod 放行之後，這些規則照樣會擋。

## 檢查
```
claude plugin validate mods\dhc-guard
cd mods\dhc-guard && claude plugin test
```
2026-10-08 用 2.1.293 驗證：7/7 測試通過；在 -p 的真實 session、resume 之後的 bypass 模式、CloudCLI 用的 SDK 0.3.266 三種情況下，都確認會攔下也會放行。

## 啟用（要 Claude Code 2.1.287 以上才會生效）
在 `~/.claude/settings.json` 加：
```json
"extraKnownMarketplaces": { "dhc-mods": { "source": { "source": "directory", "path": "D:\\TAS\\Claude Code專案\\Harness優化\\agent-harness-v2\\mods" } } },
"enabledPlugins": { "dhc-guard@dhc-mods": true }
```
臨時關掉：`/plugin` 裡停用 dhc-guard，或用 `claude --safe-mode` 啟動。

## 沒開的
- 內建的 `cc-plugin-you-should-know`：這個帳號沒有提供；它的提醒畫在輸入框上方，DHC CLI 網頁版看不到，卻照樣花額度。
