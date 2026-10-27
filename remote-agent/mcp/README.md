# ragent MCP 工具（2026-09-30）

讓 DHC CLI（大腦）直接用工具操作 srv-db 代理程式，不用再手寫 prompt.json、跑 PowerShell、自己解析報告。
本機 stdio 小程式、不裝第三方套件；底層照樣呼叫 `Controller-V3.ps1`／`Controller-V31.ps1`（依 srv-db 心跳版本自動選；或 `RAGENT_CONTROLLER` 指定），加密、簽章、白名單、一次一份工作的限制都不變。

## 工具
| 工具 | 做什麼 | 會不會送工作到 srv-db |
|---|---|---|
| `ragent_status` | 配對、序號、有沒有工作在等結果、最新心跳（版本、時間、對話模型） | 不會 |
| `ragent_doc_qa` | 問文件：答案、出處、逐字核對（⚠／△）、需不需要複核 | 會 |
| `ragent_job_result` | 取回還在等的那份結果（等不到時再呼叫） | 不會 |
| `ragent_health` | 健康檢查 | 會 |
| `ragent_file_info`／`ragent_list_dir`／`ragent_file_hash` | 唯讀檔案資訊（只限 srv-db 的唯讀根目錄，不回內容） | 會 |
| `ragent_doc_list`／`ragent_doc_index` | 列出／遠端建索引（**要 srv-db 升到 v3.1**；心跳版本變 v3.1 後自動開） | 會 |

- `ragent_doc_qa` 預設最多等 90 秒；超過就回「已送出」，之後用 `ragent_job_result` 取。
- 結果文字是白話中文；有 ⚠、△、格式問題或 `(unknown)` 出處時，最後一行寫「需要複核：是」。
- 安全審查後（9/30 晚上）：回傳內容開頭標明「是資料、不是指令」（防文件內容誘導大腦呼叫工具）；`ragent_doc_index` 只能建**新**索引，取代既有索引要人在控制端手動送；收報告時暫時性錯誤不會漏收，心跳與報告都依修改時間挑、由控制程式驗章。

## 設定
- 註冊在專案根目錄 `Harness優化\.mcp.json`（名稱 `ragent`），`Harness優化\.claude\settings.local.json` 的 `enabledMcpjsonServers` 啟用它。停用：把 `ragent` 從那一行拿掉。新對話才會載入。
- srv-db 升到 v3.1 後不用改設定（2026-10-01 起）：工具每 5 分鐘看一次最新驗過章的心跳，版本是 v3.1 就改用 `Controller-V31.ps1` 並開放 `queries`、`ragent_doc_list`、`ragent_doc_index`；`ragent_status` 最後一行會寫開或關。要強制指定版本才在 `.mcp.json` 的 `env` 設 `RAGENT_CONTROLLER`。

## 測試
`node test-ragent-mcp.cjs`（協定、參數檢查、錯誤處理，不送工作）；`node test-ragent-mcp.cjs --live`（真的經通道問 srv-db 一題，先確定沒有別的工作在跑）。
