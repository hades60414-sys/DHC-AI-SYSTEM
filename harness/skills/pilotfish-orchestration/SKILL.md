---
name: pilotfish-orchestration
description: Multi-model orchestration policy. Use only when the user explicitly asks for Pilotfish, Ultracode, Workflow, 火力全開, or multiple Claude agents.
---

# pilotfish-orchestration — 多模型編排(opt-in 改裝版)

上游專案:[Nanako0129/pilotfish](https://github.com/Nanako0129/pilotfish) v1.3.10(MIT)。
原設計是把整段政策**常駐**塞進 `~/.claude/CLAUDE.md`(每 session ~4k tokens)+ 強制把主 session model 改成 opus。本 harness 改裝成 **opt-in skill**:

- **分工**:`[[subagent-driven-development]]` 管「**該不該**開、開幾個」(先當煞車);本 skill 管「決定要開之後**怎麼開**」(角色路由、模型分層、驗證閘)。
- **不動 settings.json 的 model**——主 session 用什麼模型由使用者自己選,不強制降/升級。
- 8 個角色 agents 已裝在 `~/.claude/agents/`(scout、Explore、plan-verifier、security-reviewer、mech-executor、executor、verifier、security-executor),各自 frontmatter 帶模型分層(偵察=haiku、執行=sonnet、驗證/安全=opus)與工具白名單(唯讀角色不能寫、leaf 角色不能再開 agent)。**派工時不要在 Agent 呼叫另指定 `model`**,會蓋掉角色路由。
- 偵察二選一:`scout` = 定向偵察(「X 在哪/怎麼運作」的有界問題);`Explore` = 廣度 fan-out 搜索(多處位置/命名慣例掃描,並刻意覆蓋內建同名 Explore 以釘便宜模型)。

## 用法

被觸發時,**讀同目錄的 `POLICY.md`**(完整編排政策)並照做。速記版:

1. **先選互動形狀**:`co_discover`(目標/驗收不明)→ `explore_then_plan`(方向清楚但影響大;首輪唯讀)→ `execute`(清楚且有界)。
2. **風險先於規模**:安全/不可逆/資料 schema/釋出 → 強制 fresh-context `plan-verifier`(事前)+ `verifier`(事後);小而穩的工作直接做,不開 agent。
3. **派工煞車**:每次 Agent 呼叫前確認——契約穩定、範圍互斥、有人負責合成/驗證;證據還在演化就不要 fan-out。
4. **機械式重複** → 一個 `mech-executor` 一次性完整 brief;**有判斷的實作** → `executor`;**安全敏感** → 只能用 security 角色。
5. **驗證閘**:agent 的結論是證據不是判決;載重結論用 fresh `verifier` 拿 CONFIRMED/REFUTED/INCONCLUSIVE,主 session 自己做最終裁決與整合。

## 熔斷器(過度思考自動暫停 — 使用者實測回饋,必守)

使用者在 Codex + pilotfish 實測過**思考過多**(overthinking):閘門/規劃/驗證迴圈空轉,產出停滯。本 skill 啟用期間**持續自我監測**,任一條命中就**自動暫停 pilotfish**:

1. **儀式費超過任務規模**:任務本身小而有界(單檔、可逆、非安全類),卻要走 explore_then_plan + 驗證閘 → 不進閘門,直接 inline 做。
2. **規劃空轉**:連續 2 輪都在 gate/plan/REVISE,沒有任何實際產出(檔案、diff、可驗證結論)推進。
3. **驗證迴圈**:plan-verifier/verifier 來回超過 1 輪且沒有實質變更(改的只是措辭不是內容)。
4. **使用者訊號**:使用者說「太慢」「想太多」「別規劃了」「直接做」→ 立即熔斷,不辯解。

熔斷動作:宣告一行「**PF 暫停:\<命中哪條\>**」→ 退回 `[[subagent-driven-development]]` 保守模式(inline 或 ≤1 子代理)把事做完 → 本次任務內不再重啟 pilotfish;下次任務重新評估。安全紅線不熔斷:算錢/不可逆動作的「先問使用者」不受此限。

## 邊界

- 跟 `[[subagent-driven-development]]` 衝突時:**該不該開**聽它的(預設保守、無訊號 ≤1 子代理),**怎麼開**聽這裡的。**但風險閘門優先於數量天花板**:POLICY 標為 mandatory 的 `plan-verifier`/`verifier`/security 角色呼叫不受天花板限制(SDD §0 已列為例外)。
- 本環境另有 Workflow 工具做確定性編排——需要迴圈/fan-out→合成時,角色 agents 可作為 Workflow 的 `agentType` 使用。**Workflow `agent()` 必帶 `opts.model`**(不帶=繼承主 session 模型=最貴;分層見 `[[cross-model-verify]]`)。
- POLICY 提到的 `baton-dispatch` **已安裝**:大型/跨面任務先用它切工作流(拓撲、ownership、context pack),再由本 skill 的角色/閘門執行;跨 session 的長任務交接用 `[[baton]]`。
- 委派會安裝東西的任務,照樣過 `[[scan-before-install]]`。
