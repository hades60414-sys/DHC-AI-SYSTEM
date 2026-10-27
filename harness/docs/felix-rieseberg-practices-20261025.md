# Felix Rieseberg 訪談：對照 TAS 的整合紀錄（2026-10-25）

來源：使用者貼的影片整理稿（88 行，Claude 工程負責人訪談）。逐項對照 TAS 現況，標出已有、本次改動、待辦。

| 影片觀點 | TAS 現況 | 本次處理 |
|---|---|---|
| 不給角色設定 | harness 的 rules／skills／agents 掃過，沒有「你是一位…」類句子 | AGENTS.md 加一條：寫 prompt 不用角色設定 |
| 刪掉過時的技能條框 | 50 多個 skill；10-20 搬到 srv-main 後只有 5 天對話紀錄，35 個 skill 沒被呼叫過，證據不夠 | 同一條規則：刪過時約束而不是加新的。刪 skill 要等一個月的使用紀錄 |
| 不要碎片化 RAG，給全局資料 | srv-rag RAG 檢索已附前後相鄰段；短文件給全文的選項還沒有 | 待辦：短文件改回傳全文，屬 RAG 架構，要走 pstack |
| 不自己審自己，紅隊＋小模型＋裁判 | 已有 `verifier`、`pstack:interrogate`（opus＋sonnet 平行挑錯） | AGENTS.md 加一條：重要產出交付前由新開的審查者挑錯，逐條憑證據裁決 |
| 管理者隱性品位三步提煉＋盲測 | 已有燒杯蒸餾模式、專案記憶卡、72 張記憶（22 張 feedback）、`pstack:automate-me` | 待辦：用 automate-me 從 feedback 記憶提煉準則與深層原則，再做盲測校準 |
| 結果導向不如工序導向 | AGENTS.md Team context 已要求驗算、引來源與時間 | 不改 |
| 用專家工具（Blender 例） | 影片、簡報、圖表已用專業工具鏈 | 不改 |

回退：`copy rules\AGENTS.md.bak-20261025v rules\AGENTS.md` 後跑 harness-sync。
