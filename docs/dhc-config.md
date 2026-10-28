# dhc.config.json 欄位說明

DHC CLI 啟動時讀 repo 根目錄的 `dhc.config.json`（也可以用環境變數 `DHC_CONFIG` 指到別的檔案）。改完要重啟伺服器才會生效。檔案不存在、或某個欄位寫錯時，該欄位會用預設值，伺服器照樣啟動，並在 log 印出 `[dhc-config]` 警告。

前端從 `GET /api/dhc/config` 讀同一份設定，不在別處重複定義。

```json
{
  "workspaceRoot": "DHC Workspace",
  "mode": "personal",
  "remote": { "enabled": false },
  "agents": ["claude", "codex"],
  "domain": "general"
}
```

| 欄位 | 預設 | 可填 | 作用 |
|---|---|---|---|
| `workspaceRoot` | `"DHC Workspace"` | 資料夾路徑 | 工作區根目錄，底下每個子資料夾是一個專案。相對路徑以家目錄為基準（Windows 是 `C:\Users\<你>\DHC Workspace`），也可以寫絕對路徑。側欄只列這個資料夾底下第一層的專案；`例行工作`、`內部資料查詢`、`蒸餾任務` 也放在這裡面。 |
| `mode` | `"personal"` | `"personal"`、`"team"` | `personal` 會把團隊功能藏起來：設定檔（每台裝置選專案）、Co-Work 邀請與分享、頭像、待辦的「誰的待辦」切換。`team` 全部打開。程式都還在，只是畫面不顯示。 |
| `remote.enabled` | `false` | `true`、`false` | 是否打算從外網連回這台機器。這個開關只是記錄你的選擇，實際的通道要照 [modules/remote](../modules/remote/README.md) 自己裝；沒有外網需求就保持 `false`。 |
| `agents` | `["claude", "codex"]` | `claude`、`codex`、`cursor`、`opencode` | 畫面上要出現哪些 AI Agent（新對話的模型清單、設定裡的 Agents、首次引導）。順序沿用內建順序。寫了不認得的名稱、清單變成空的時候，會全部顯示。 |
| `domain` | `"general"` | 小寫英數與連字號 | 用途。`finance` 對應 [domains/finance](../domains/finance)；其他用途見 [domains/README.md](../domains/README.md)。 |

`dhc.config.example.json` 是團隊版的寫法範例（team、開遠端、三種 Agent、金融用途）。

要讓 AI Agent 幫你設定，把 [SETUP_PROMPT.md](../SETUP_PROMPT.md) 貼給它。
