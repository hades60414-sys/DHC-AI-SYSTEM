---
name: subagent-driven-development
description: DECIDE whether to delegate at all before orchestrating — this skill is a BRAKE first, accelerator second. Default answer is "do it inline, or one small read-only subagent." Escalate to multi-agent / Workflow / teammates ONLY on a genuine independent decomposition (broad multi-file research/search, multi-dimension review or audit, competing-hypothesis debugging, large migration/sweep, judge-panel evaluation) OR an explicit full-power signal (火力全開 / token 很夠 / 瞎搞 / 多開幾個). NOT for trivial single-file edits, sequential dependent work, or "feels thorough." When unsure, stay inline.
---

# subagent-driven-development — 當總監,而不是單兵

把自己當**編排者**,但**先當煞車**:多數任務該 inline。亂開代理比不開更糟(燒 token、context 髒、結果難驗)。核心兩紀律:**(1) 該不該開、開哪種** 與 **(2) 窄通道 + 驗證**。

## 0. 預設保守,訊號才全開
- **沒訊號**:多數任務 **inline 直接做**,或最多**一個**小子代理跑唯讀搜尋。別為「看起來徹底」fan-out。
- **任務本身夠大**(跨數十檔研究、多維度 review/audit、競爭假設、大遷移):**可以考慮**拆,但**先過 §2 獨立性檢查再決定**——大 ≠ 該平行;依賴鏈長的大任務仍是 inline 或 pipeline。
- **全開訊號**(使用者說「火力全開 / token 很夠 / 瞎搞 / 多開幾個」):積極拆解、平行多代理、用 Workflow 跑 fan-out→驗證→合成、必要時 agent teams——以最徹底、最高品質為目標。
- **數量天花板**:無訊號 **≤1** 子代理;任務夠大但無訊號 **≤3–4** 平行;要再多 → **先問使用者或等全開訊號**。**例外:風險觸發的驗證閘不計入天花板**——安全/不可逆/資料 schema 類任務依 `[[pilotfish-orchestration]]` 強制的 `plan-verifier`/`verifier`/security 角色是品質底線,不是 fan-out,天花板管的是「平行做事的代理」。
- **Workflow 例外**:Workflow 的多代理編排**需使用者明確同意**(火力全開/明確要 workflow 才算),**不是自動觸發**——即使有「夠大」的任務也先取得同意。

## 1. 該開哪一種(由便宜到貴)
| 選 | 何時 | 成本 |
|---|---|---|
| **inline** | 短、序列、要原始輸出、單一 context 夠 | 1x |
| **子代理(Agent 工具)** | 工作冗長且**結論可無損摘要回來**、可限制工具(只讀)、可平行的**獨立**子任務、需乾淨新 context | ~3–4x |
| **Workflow** | 控制流要**確定性**:迴圈/條件/fan-out→合成/loop-until-dry/judge-panel。**多代理需使用者同意**;背景跑,併發上限 ~16、生涯上限 1000 代理 | 視規模 |
| **teammates(agent teams)** | **罕見**:子任務之間要**互相傳訊/共享 task list/辯到收斂**;實驗性,需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | ~7x |

**「該不該全開」這層,token 成本就是主要否決理由——預設用省 token 擋,只有「真獨立 + 可摘要」才解鎖。** 全開後,贏面才是「wall-clock(平行)+ context 衛生(冗長工作移出主線)」,而非省 token。

## 2. 開子代理的判準
**開**:輸出冗長但你只要結論;要釘死只讀權限;自包、可化約成摘要;**彼此無依賴**可平行;需不被主線污染的乾淨 context。
**不開**:序列/有依賴(B 要 A 的輸出);會**同時改同一 git tree**(打架→序列化或 `isolation:"worktree"`);瑣碎(開銷>收益);**你已知道答案**或答案在手邊;**結論無法無損摘要**(需逐字/原始輸出、精確 diff、完整 stack trace)——這種 inline 做,摘要會把它丟掉。

> 鐵律:**委派出去的搜尋,自己就別再跑**——也別為同一片搜尋開兩個重疊代理;背景代理在跑就**等它回**,別搶跑下結論。

## 3. 窄通道(narrow channel)
- **進去**:一個**精準** prompt——明確 inputs / 期望 outputs / 驗收標準。模糊指令 → 垃圾回來。
- **回來**:**摘要,不是傾倒**。子代理的**最終訊息就是回傳值**(不會給使用者看),所以(a)叫它只回結構化結論/你要的資料,(b)**你負責把重點 relay 出來**。
- 推論:**需要原始逐字輸出的工作不要委派**(摘要會丟失它);要原始就 inline。

## 4. 驗證:不要信,要驗
子代理會**自信地錯**。任何**載重**結論(bug 宣稱、安全發現、設計決策、數字)→ 跑一次**對抗式驗證**再採信:
- 獨立懷疑者(prompt 它去**反駁**,預設「未證實=否決」),多數否決就殺掉;
- 或**多視角**(正確性 / 安全 / 重現性 各一 lens),冗餘抓不到的失敗模式靠多樣性抓;
- 或**異質模型**(`[[cross-model-verify]]`:Codex 家族當 verifier)——不同家族盲點不同,高風險結論優先跨供應商互驗(敏感資料先過資訊隔離判斷);
- 別憑一票就收。relay 的是**已驗證的結論**,不是檔案傾倒。
(典型:草稿 agent 產出 → 獨立 review agent 反駁 → 抓到真 bug → 修。)

## 5. 編排形狀(常用詞彙)
這些是常見的多代理編排形狀,當思考詞彙:
- `fan_out_research` / 平行 Agent = 多查詢→收集→**可注入查證**→合成。
- `judge_panel` / `debate` = 多裁判投票或正反辯(unanimous / 多數 fail-closed)。
- `map_reduce` = map 過清單(每項可 gate)→ reduce。
- `cascade` = 由便宜到貴逐級升級,全敗→ [NEEDS USER]。
- `planner_worker` / `autonomous_loop` = 總監每輪下一指令 / 挑 atomic→跑→驗→記錄。
**Workflow 常用 pattern**:find→adversarial-verify、loop-until-dry(連續 K 輪無新發現才停)、judge-panel、completeness-critic(最後問「漏了什麼」)。

## 6. 陷阱(精妙處,常被忽略)
- **平行改同檔/同 git tree = 打架** → 唯讀才平行;要平行寫就 `isolation:"worktree"`——但 worktree 是隔離副本,子代理改完後**主代理要負責把變更合併/取回**,否則(尤其無變更時自動清除)成果會**靜默丟失**。
- **過度拆解**:把瑣事拆成 10 個代理,協調開銷 > 收益。
- **teammates 用錯**:序列工作用 teammates=純浪費;**平行但互不溝通**的任務 → 用平行 Agent 或 Workflow(3–4x),**不是** teammates(7x);teammates 只在「彼此要傳訊/辯到收斂」才回本。
- **盲目信任**:見 §4。
- **委派會裝東西的任務** → 一樣套 `[[scan-before-install]]`(掃→判斷→才裝),fail-closed。
- **模型分層(2026-08-14 修訂:預設繼承已廢除)**:ad-hoc 子代理與 Workflow `agent()` **一律顯式指定模型**——機械/偵察=haiku、有界執行=sonnet、驗證/裁決=opus;只有主線合成留主 session 模型。不指定=繼承主模型=雜活也用最貴的跑(實測踩過:研究 fan-out 6 隻全跑旗艦)。分層對照與跨供應商選項見 `[[cross-model-verify]]`。**例外:已定義的角色 agents(pilotfish 8 角色)依其 frontmatter 路由,派工時不要另指定 model。**

## 7. 一句話
**保守是預設,全開是選擇;開之前先問「這些子任務真的彼此獨立、且輸出可無損摘要嗎?」——是,就大膽拆並平行 + 逐一對抗式驗證;否,就 inline 自己做。**

相關:`[[scan-before-install]]`(委派安裝任務時的安全閘);`[[pilotfish-orchestration]]`(決定要開之後的「怎麼開」——角色路由、模型分層、驗證閘;本 skill 管 WHETHER,它管 HOW);`[[baton-dispatch]]`(大任務的切片與 ownership 設計——管 WHAT SHAPE);`[[baton]]`(context 見底/跨 session 時的交接檔)。
