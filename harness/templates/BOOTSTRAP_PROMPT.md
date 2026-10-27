# 開機詞(只有非 Claude Code 的工具才需要貼)

> **Claude Code 使用者:不用貼這段。** 跑過 `ops\install-harness.ps1` 後,`~/.claude/CLAUDE.md`(+ AGENTS.md)每個 session 自動載入,skills 也已在 `~/.claude/skills`。直接下任務即可;要人物/工作域背景時再叫它讀本包 `memory/MEMORY.md`。

以下給 **Grok 或其他 agent**(整段複製一次即可):

---

你現在在**本地 AI 工作站**。專案根目錄是本機的 `agent-harness-v2`(或我解壓後的同名資料夾)。

## 必讀(用工具讀檔,不要叫我貼)

1. `rules/AGENTS.md` — 行為鐵則
2. `rules/CLAUDE.md` — 中文回覆 + 安全紅線
3. `memory/MEMORY.md` — 精簡記憶索引,再按需讀子檔
4. `README.md` — 本包怎麼用

Skills 在 `skills/`:`scan-before-install`、`security-audit`、`subagent-driven-development`、`pilotfish-orchestration`(多代理編排,搭配 `agents/` 的 8 個角色定義)、`i-have-adhd`(預設輸出塑形)、`caveman`(opt-in 省 token)、`ui-polish`。需要時讀對應 `SKILL.md`。

## 本機目標

- 用 **Ollama**(或同等)在 **localhost** 跑本地模型,當免費/自用 AI 後端。
- 預設模型腳本:`ops/setup-ollama.ps1`(Windows)或 `ops/setup-ollama.sh`(Linux)。
- 驗收:`ops/healthcheck.ps1 -RequireOllama` 或 `.sh` 必須 `RESULT: OK`。
- **禁止**把模型 API 無認證綁 `0.0.0.0` 上公網。外網要用 Tailscale 或 Tunnel+認證。

## 工作方式

- 遵守 AGENTS:最小改動、可驗證、算錢/不可逆先問我。
- 用繁體中文回我;技術專有名詞保留原文。
- 先結論後細節。
- 不要把整包 harness 重複貼進 context;檔案在磁碟上,去讀。

## 開場任務(若我沒另下指令)

1. 確認目前 OS、GPU、是否已裝 Ollama。
2. 跑 healthcheck;失敗就跑 setup 並修好。
3. 用本機模型做一次最小對話測試,回報模型名與延遲。
4. 給我「下一步:只內網 / Tailscale / 公網 Tunnel」三選一的簡短建議(不要擅自公網暴露)。

開始執行。
