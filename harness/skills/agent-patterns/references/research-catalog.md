# 延伸武器庫:學術與業界模式清單

查核日:2026-09-26。arXiv id 由研究 subagent 逐一開摘要頁確認;標 UNVERIFIED 者引用前再查。
「小模型」欄 = 1–14B 本地模型的適合度(好/中/差),細節見 [local-models.md](local-models.md)。

## A. 業界指引

| 模式 | 出處 | 機制 | 何時用 | 注意 | 小模型 |
|---|---|---|---|---|---|
| Prompt chaining | Anthropic, Building Effective Agents (2024-12) https://www.anthropic.com/research/building-effective-agents | 固定順序多次呼叫,步間程式檢查 | 可拆成固定、可驗證步驟 | 每步加延遲;不適合動態分支 | 好 |
| Routing | 同上 | 分類後導向專用 prompt/模型 | 輸入類別差異大 | 路由本身要有 eval 集 | 好 |
| Parallelization(sectioning / voting) | 同上 | 拆獨立子任務並行,或同題 N 次投票 | 子任務獨立;要共識信心 | 投票成本 N× | 好(投票) |
| Orchestrator-workers | 同上 | 中央 LLM 動態拆解、派工、整合 | 子任務事先未知 | orchestrator 品質是瓶頸 | orchestrator 用最強模型 |
| Evaluator-optimizer | 同上 | 生成器 + 獨立評審迴圈 | 評分標準清楚 | 需輪數上限 | 小生成器 + 強/規則評審 |
| Lead + subagents 研究系統 | Anthropic, multi-agent research system (2025-06) https://www.anthropic.com/engineering/built-multi-agent-research-system | 主 agent 派多個獨立 context 的子 agent,回傳濃縮結果 | 廣度優先研究 | **約 15× 一般對話 token**(該系統實測,勿泛化);不適合強耦合任務如寫程式 | 差 |
| Context engineering | Anthropic (2025-09) https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | context 是有限資源,只放最小高訊號集合;壓縮、外部化狀態 | 長任務 | 是紀律不是配方 | 對小模型更重要 |
| Manager(agents-as-tools) | OpenAI, A Practical Guide to Building Agents (2025) | 主管 agent 把專家 agent 當工具呼叫,保留控制權 | 要單一控制點 | 主管是單點瓶頸 | 主管用強模型 |
| Decentralized handoff | 同上 | 控制權單向交給專家 agent | 分診後由專家接手 | 交接後難稽核 | 可接專精小模型 |
| Guardrails / tripwire | OpenAI Agents SDK docs | 獨立檢查輸入/輸出,違規即中斷 | 有副作用、要控成本 | 輸出檢查在生成後才生效 | 規則式 guardrail 幾乎免費 |
| Sequential / Parallel / Loop / Coordinator / Generator-critic / HITL | Google ADK multi-agent patterns (2025) https://developers.googleblog.com/developers-guide-to-multi-agent-patterns-in-adk/ | 程式定義流程 + 階層式派工 | 流程可預知 | 確定性流程不自適應 | 好(模型只填格子) |
| Task Ledger + Progress Ledger | Microsoft Magentic-One (2024-11) | 外層帳本記事實/猜測/計畫,內層帳本檢查進度,卡住就重規劃 | 開放式長任務 | 記帳開銷 | 狀態外部化可補小模型弱點 |
| Sequential / Concurrent / Group chat / Handoff / Magentic | Azure AI agent orchestration patterns https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns | 五種編排模式對應五種流程形狀 | 依流程形狀選 | Magentic 成本最難預估 | 避開 Magentic |
| Supervisor / Hierarchical / Swarm / Network | LangGraph (2025) https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems | 中央路由 / 巢狀主管 / 直接互相交接 / 全互連 | supervisor 最好稽核 | swarm、network 難除錯 | 只用 supervisor |
| 四大 agentic 模式(Reflection / Tool use / Planning / Multi-agent) | Andrew Ng, The Batch (2024-03) | 粗分類框架 | 快速歸類系統 | 太粗,不指定實作 | — |
| Don't build multi-agents | Cognition (2025-06) https://cognition.com/blog/dont-build-multi-agents | 單一主迴圈持有狀態,子 agent 只當無狀態窄工具 | 寫程式等強耦合任務 | 反對分散決策:context 碎片化才是主風險 | 強烈適用 |
| 12-Factor Agents | HumanLayer https://github.com/humanlayer/12-factor-agents | 自己掌握 prompt、context、控制流;小而專注的 agent;人在迴圈是一等公民 | 要上線、要可維護 | 是紀律清單 | 適用 |
| Crews + Flows | CrewAI docs | 角色團隊(順序/階層)+ 事件驅動流程與狀態持久化 | 角色式多代理 | 框架綁定 | 中 |
| A2A / MCP | Google→Linux Foundation(A2A);Anthropic(MCP) | A2A = agent 對 agent;MCP = agent 對工具/資料 | 跨廠商互通 / 工具接入 | A2A 仍在成熟中 | MCP 與模型大小無關 |
| Blackboard(復興) | arXiv 2510.01285 等 | 共享結構化黑板,agent 讀寫,不互傳整段對話 | 多異質專家鬆耦合 | 效益數字來自研究 benchmark | 省 context |
| Durable execution / checkpoint | Temporal、Inngest (2025–26) | 每步狀態持久化,失敗從斷點續跑 | 長時間、無人值守 | 多一套基礎設施 | 無人值守夜跑的保險 |
| Sleep-time compute | Letta (2025-04) https://www.letta.com/blog/sleep-time-compute/ | 閒置時背景 agent 整理記憶、預先運算 | 常駐、有閒置時段 | 需記憶持久化架構 | 適合常駐本地 agent |
| Skills / Subagents / Compaction | Anthropic Claude Code (2025–26) | 按需載入說明;子 agent 隔離 context 只回摘要;壓縮歷史 | 長 session、重複 know-how | 慣例仍在演進 | 可移植到本地 harness |

## B. 學術:推理與搜尋

| 名稱 | 出處 | 機制 | 小模型 |
|---|---|---|---|
| Self-Consistency | Wang et al., arXiv 2203.11171 | 多條推理路徑多數決 | 中(成本 N×) |
| Universal Self-Consistency | arXiv 2311.17311 | 由 LLM 選最一致的開放式答案 | 中 |
| Tree of Thoughts | arXiv 2305.10601 | 分支、自評、回溯 | 差 |
| Graph of Thoughts | arXiv 2308.09687 | 思路成圖,可合併/精煉 | 差 |
| LATS | arXiv 2310.04406 | MCTS + 環境回饋 + 反思 | 差 |
| Plan-and-Solve | arXiv 2305.04091 | 先列計畫再逐步解(zero-shot) | 好 |
| Least-to-Most | arXiv 2205.10625 | 由簡到難拆子問題依序解 | 中 |
| Step-Back Prompting | arXiv 2310.06117 | 先抽象出原則再推理 | 中 |
| PAL / Program-of-Thought | arXiv 2211.10435 | 模型寫程式,直譯器算 | 好 |
| Process Reward Model | Lightman et al., arXiv 2305.20050 | 逐步驗證器挑 best-of-N / beam | 差 |
| Test-time compute scaling | s1 arXiv 2501.19393;survey arXiv 2503.24235 | 用推論計算換正確率 | 差;規模大時報酬遞減 |

## C. 學術:反思與驗證

| 名稱 | 出處 | 機制 | 小模型 |
|---|---|---|---|
| Reflexion | arXiv 2303.11366 | 失敗後口語反思存入記憶再試;需明確成敗訊號 | 中 |
| Self-Refine | arXiv 2303.17651 | 同模型生成→回饋→改寫;無外部依據可能強化錯誤 | 差 |
| Chain-of-Verification | arXiv 2309.11495 | 草稿→列查核問題→獨立回答→修訂(factored 版避免抄錯) | 中 |

## D. 學術:規劃與執行

| 名稱 | 出處 | 機制 | 小模型 |
|---|---|---|---|
| ReWOO | arXiv 2305.18323 | 一次規劃完整工具呼叫藍圖,Worker 執行、Solver 整合 | 好 |
| LLMCompiler | arXiv 2312.04511 | 規劃工具呼叫 DAG 並行執行 | 中 |
| CodeAct | arXiv 2402.01030 | 用可執行 Python 當動作(需沙箱) | 好 |
| Agent Workflow Memory | arXiv 2409.07429 | 從過去軌跡歸納可重用 workflow 注入 prompt | 好 |

## E. 學術:多代理

| 名稱 | 出處 | 機制 | 小模型 |
|---|---|---|---|
| CAMEL | arXiv 2303.17760 | 雙角色扮演合作 | 中 |
| MetaGPT | arXiv 2308.00352 | 把 SOP 編進角色流水線 | 差 |
| ChatDev | arXiv 2307.07924 | 開發階段 chat-chain | 差 |
| AutoGen | arXiv 2308.08155 | 可對話 agent 抽象:群聊、交接、辯論 | 中 |
| Multi-agent debate | Du et al., arXiv 2305.14325 | 多實例多輪互評收斂;arXiv 2502.08788 指出效益常被高估 | 差(會一起收斂到錯答案) |
| Mixture-of-Agents | arXiv 2406.04692 | 分層,每層綜合上一層多模型輸出 | 好(異質小模型集成) |
| Generative Agents | arXiv 2304.03442 | 經驗流記憶 + 反思 + 檢索規劃 | 差 |

## F. 學術:記憶與 RAG

| 名稱 | 出處 | 機制 | 小模型 |
|---|---|---|---|
| MemGPT / Letta | arXiv 2310.08560 | 作業系統式分頁:主 context ↔ 封存記憶 | 中 |
| A-MEM | arXiv 2502.12110 | Zettelkasten 式自動連結、演化的記憶 | 中 |
| Voyager | arXiv 2305.16291 | 自動課程 + 可執行技能庫 | 差 |
| Self-RAG | arXiv 2310.11511 | 微調出檢索/自評 token,按需檢索 | 差(要微調) |
| CRAG | arXiv 2401.15884 | 小評估器判檢索品質,不好就改寫或外搜 | 好 |
| GraphRAG | arXiv 2404.16130(UNVERIFIED,引用前確認) | 實體圖 + 社群摘要,答全域型問題 | 差(建圖要強模型) |
| Agentic RAG survey | arXiv 2501.09136 | 在 RAG 迴圈中加入反思/規劃/多代理 | 視子模式 |

## G. 學術:路由與成本

| 名稱 | 出處 | 機制 | 小模型 |
|---|---|---|---|
| FrugalGPT | arXiv 2305.05176 | prompt 調整 + 近似 + 級聯(便宜先、低信心升級) | 極佳 |
| RouteLLM | arXiv 2406.18665 | 由偏好資料學出的強/弱模型路由器 | 好 |

## H. 學術:自動化設計

| 名稱 | 出處 | 機制 | 小模型 |
|---|---|---|---|
| ADAS(Meta Agent Search) | arXiv 2408.08435 | meta-agent 用程式碼寫新 agent 並累積檔案庫 | 搜尋階段差 |
| AFlow | arXiv 2410.10762 | 對程式化 workflow 做 MCTS 最佳化 | 搜尋階段差;產出流程可針對小模型 |

## I. 失敗與可靠性研究(設計多代理前必讀)

| 名稱 | 出處 | 重點 |
|---|---|---|
| MAST: Why Do Multi-Agent LLM Systems Fail? | arXiv 2503.13657 | 1642 條軌跡、7 個框架、14 種失敗模式,分三群:系統設計/規格、agent 間錯位、任務驗證不足;多代理在 benchmark 上的增益常很小 |
| Context Engineering survey | arXiv 2507.13334 | context 的檢索、處理、管理自成一門;即使 context 正確仍有理解到生成的落差 |
| Self-Evolving Agents survey | arXiv 2507.21046 | agent 自我改進的 what/when/how/where 分類;持續改進難評估 |
| SLM-first 代理 | position paper arXiv 2506.02153;survey arXiv 2510.03847 | 1–12B 模型 + schema 約束解碼 + 先驗證後執行,在窄任務上以 10–100× 低成本追平大模型;開放式規劃仍不行 |

## J. 跨來源共識

1. 從最簡單能用的結構開始,需要才升級(Anthropic、Cognition、12-Factor 一致)。
2. 多代理有真實成本乘數;Anthropic 研究系統實測約 15× token,只引用於該情境。
3. 廣度研究適合平行拆分;強耦合任務(寫程式)要單一連續 context。
4. context 是有限資源:只留高訊號、摘要並外部化狀態。
5. 協調狀態放在明確結構(ledger、graph state、黑板),不靠模型記憶。
6. Guardrail 與人工核准是架構的一部分,不是事後補丁。
7. 名稱不同、形狀相同:orchestrator-workers = manager = supervisor = coordinator = hierarchical process。比較框架前先正規化名稱。
