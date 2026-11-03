# 提示詞注入警示（PostToolUse hook）

工具輸出（網頁、檔案、指令結果、MCP、子代理回報）裡有疑似注入內容時，給模型一段警示，提醒它那是資料，不是使用者的指令。只警示、不攔截。

- 來源：改自 [lasso-security/claude-hooks](https://github.com/lasso-security/claude-hooks)（MIT，commit 8fbfd14），授權見 `LICENSE-lasso.txt`。
- 原版 TypeScript 的 96 條規則有 85 條以 `(?i)` 開頭，JS 編譯失敗後被靜默跳過，等於幾乎沒在掃。這裡拿掉 `(?i)`，改用 `i` 旗標。
- 本機另外加的：7 條中文規則、5 條針對 AI 代理的規則（外洩到網址、Markdown 圖片信標、要求隱瞞使用者、直接對 AI 喊話、假系統標籤）、隱形 Unicode Tag 字元偵測（會解出夾帶的文字）。
- 降噪：本機常見的 12 條 medium 規則降為 low（只記錄）。警示條件是至少 1 條 high，或至少 2 條 medium。

| 檔案 | 用途 |
|---|---|
| `guard.cjs` | hook 本體，註冊在 `~/.claude/settings.json` 的 PostToolUse |
| `patterns.json` | 產出的規則檔（不要手改，改 `build-patterns.cjs` 再重建） |
| `build-patterns.cjs` | `node build-patterns.cjs lasso-patterns.json patterns.json` |
| `test.cjs` | `node test.cjs`：攻擊樣本要全部警示，並列出本機正常檔案的誤判 |

命中紀錄：`~/.claude/egress-log/prompt-injection.jsonl`（含 low，只記類別不記原文）。

回退：從 `~/.claude/settings.json` 的 `hooks.PostToolUse` 刪掉指向 `guard.cjs` 那一筆，或還原 `settings.json.bak-20261103-pi`。

限制：用正規表示式比對，新手法、改寫過的句子、圖片裡的文字都抓不到。這是第二道提醒，不能取代 dhc-guard 的危險指令確認和權限 deny 規則。
