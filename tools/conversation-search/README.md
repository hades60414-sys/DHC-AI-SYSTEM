# JEV 判斷層（單元 A）

用 Haiku 5.5 做快、便宜的固定選項判斷。每題回一個選項加信心；逾時、格式錯或信心不足就退回預設，規則可以把結果往安全方向抬。形狀參考 OpenMausBot `server/decider`（Apache-2.0），沒有複製程式碼。

## 介面

```js
const { judge } = require('D:/TAS/jev/judge.cjs');
const r = await judge('assistant-route', { text, roomKind: 'dm', recent: [], hasAttachment: false });
// r = { choice, confidence, reason, source: 'haiku'|'rule'|'default'|'cache', ms, extra?, rules?, err? }
```

命令列：`node judge.cjs assistant-route "{\"text\":\"嗨\"}"`

- `opts.timeoutMs` 覆蓋任務逾時；`opts.cache:false` 不讀也不寫快取；`opts.runner` 換掉真的 claude.exe（測試用）。
- 呼叫方式：`claude.exe -p --model haiku --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --disable-slash-commands --system-prompt <任務提示> --output-format json`，prompt 走 stdin，cwd 是每次新建的空暫存資料夾。env 加 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`、`DISABLE_AUTOUPDATER=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`；沒有 `CLAUDE_CODE_OAUTH_TOKEN` 就讀 `C:\Users\demo\.tas\claude-token.txt`（不寫進紀錄）；`ANTHROPIC_BASE_URL` 有就沿用（經去識別層）。
- `source` 的意思：`haiku` 模型答且通過檢查；`default` 模型失敗後用任務預設；`cache` 快取命中；`rule` 規則決定或把結果抬高了（抬高時 `reason` 以 `rule:` 開頭，`rules` 列出命中的規則）。
- 快取：key＝sha256(任務＋輸入 JSON)，記憶體＋`data/judge-cache.json`，TTL 由任務定，只存模型成功的答案。
- 紀錄：每次呼叫一列寫到 `data/judge-calls.jsonl`：`{ts, task, choice, confidence, source, ms, ok, err?, inLen, inHash}`，不存原文。

## 任務表

`tasks/<id>.cjs` 一個任務一檔，內容是資料：

| 欄位 | 用途 |
|---|---|
| `choices` | 選項，由弱到強排列；規則的 `floor` 依這個順序只往上抬 |
| `default` | 失敗時的選項 |
| `minConfidence` | 低於就當失敗 |
| `timeoutMs`、`cacheTtlMs` | 逾時與快取時間 |
| `ruleField`、`rules` | 規則看輸入的哪個欄位；每條 `{id, re, floor}` 或 `{id, re, force}` |
| `system`、`prompt(input)` | 系統提示與送給模型的內容 |
| `extra` | 選填。額外的字串陣列欄位，例如 `{items:{maxItems, maxLen, requiredFor:['save']}}`，結果放在 `r.extra` |

規則的處理順序：`force` 直接定案不叫模型；`floor` 是最強選項時也不叫模型；其餘照常叫模型，答完（或失敗退回預設後）再把結果抬到 floor。

新增任務：在 `tasks/` 放一個新檔，`judge.test.cjs` 加它的規則與解析測試，有評測就在 `eval/` 加案例檔。

### assistant-route（小助理分派）

`quick`（Haiku 直接答）＜`local`（讀本機檔案／記憶／上網）＜`remote`（Sonnet＋MCP，今天的做法，也是預設）＜`opus`（算錢、寫 SQL／計算、敏感請求、複雜判斷）＜`handoff`（超過 5 分鐘的長工作，另開 Opus 對話）。

規則（只看 `text`）：算錢字詞（損益、部位、對帳、勾稽、VaR、限額、保證金、淨資本、ROA…）、寫 SQL／湊數、密碼帳密、配對／安裝包／部署／建置 → 至少 `opus`；遠端主機代號、Outlook、EKB、SSMS → 至少 `remote`。配對類只抬到 `opus` 而不是直接 `handoff`，因為「帶我做配對」要另開對話，但「配對 SOP 第三步在講什麼」只是讀 SOP，交給模型分。配對流程中貼回的指令輸出（例如 `CertUtil 成功`）依 `recent` 判成 `remote`，讓原本的帶路繼續。

### memory-worth（這段對話值不值得記）

輸入 `{user, assistant}`，選項 `skip`／`save`，`extra.items` 最多 3 條陳述句。只記每次都適用的事實與偏好，不記進度、一次性結果、數字、密碼、人名（hermes 的規則）。`user` 含密碼、token、PAIRING_SHA256 直接 `skip` 不叫模型；選 `save` 卻沒有 items 視為失敗。

### session-model（開對話建議模型）

輸入 `{text, project, hasAttachment}`（新對話第一則，最多 1500 字；project 是專案資料夾名），選項 `sonnet`／`opus`，預設 `opus`（今天的做法），逾時 6 秒，信心低於 0.75 問一次 Sonnet。規則（只看 `text`）：assistant-route 的算錢字詞再加金額、稅額、庫存、加總、湊出、會計、BOOK；改程式、修 bug、部署、建置、重構、php、.ts、SQL、公式、預存程序、貼 SELECT…FROM、錯誤訊息、python、做／改網頁 → `opus`，不叫模型。伺服器端 `POST /api/providers/model-advice` 呼叫它（開關檔 `C:\Users\demo\.cloudcli\model-advice-on`）。評測：`node eval/run.cjs --task=session-model`（`eval/session-model-cases.json` 48 題，取自 auth.db 真實第一則、去掉人名數字）；10-24 第 1 回合 46/48＝95.8%、標 opus 的 0 題被判成 sonnet，錯的兩題是規章查詢含「部位限額」「損益」被規則抬到 opus。

## 評測

`node eval/run.cjs`：49 題（`eval/cases.json`，取自聊天室真人提問、去掉人名與數字後人工標註），真的呼叫 Haiku、不用快取、逾時放寬到 45 秒以量到真實延遲。

| 回合 | 準確率 | 算錢案例送到 opus/handoff | 往弱路線錯 | 失敗退回 | 延遲 p50／p90 | 檔案 |
|---|---|---|---|---|---|---|
| 1（初版提示） | 41/49＝83.7% | 12/12 | 4 | 2 | 2.7／4.5 秒 | `eval/results-2026-10-23T21-19-29.md` |
| 2（補 local／handoff 說明） | 47/49＝95.9% | 12/12 | 0 | 1 | 2.5／3.1 秒 | `eval/results-2026-10-23T21-21-47.md` |

第 2 回合是對同一組案例調過提示後的分數，會偏樂觀；新案例的準確率要等真實流量紀錄再看。剩下的兩題錯都是往強路線錯（較貴但安全）：一題「勾稽窗口」是職稱卻被算錢規則抬到 opus，一題信心不足退回 remote。

冷啟動（10-24 實測）：本 session 前兩次 `-p` 呼叫牆鐘 27 秒與 16 秒，模型本身的 `duration_ms` 只有 1.6–3.4 秒，多出來的全是程序啟動；之後連續呼叫約 2.5–3 秒。閒置 7 分鐘後再叫只要 2.5 秒，所以慢的不是單純「閒置就變冷」，觸發條件還沒找出來（推測是開機或換 env 後第一次啟動時的檔案掃描，未證實）。使用端要假設偶爾會有一次 15–30 秒，任務逾時 15 秒時那一次會退回預設。

## 測試

`node --test judge.test.cjs`：17 題，用假的 runner，不打真的模型。
