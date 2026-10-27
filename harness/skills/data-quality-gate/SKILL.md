---
name: data-quality-gate
description: 市場/部位資料品質檢核紀律(證券自營中台)。當使用者要「檢查資料品質、市價驗證、stale price、outlier、對帳自動化、資料檢核、golden source、驗價/IPV」時使用。核心:BCBS 239 維度骨架、stale 狀態機、雙層檢核(規則優先/統計補充)、pricing waterfall、獨立驗價原則、分層容差。STALE 資料不得進任何結論。
---

# data-quality-gate — 資料品質檢核

遵守常駐紅線 `MIDOFFICE.md`(lineage 必附、STALE/FALLBACK 不得用於結論;安裝後位於 `~/.claude/MIDOFFICE.md`)。研究依據:套件 `docs/midoffice-research-raw.json`(BCBS 239、EODHD stale 狀態機、IPV 實務、FRTB RFET、Limina 對帳分類;僅存於套件)。

## 1. 檢核維度(BCBS 239 骨架)

**accuracy/integrity、completeness、timeliness、consistency、traceability**。每批資料進分析前先過這五項,任一 FAIL 就在後續所有輸出標注資料品質狀態。

## 2. 時效:stale 狀態機(deterministic,不交給模型判斷)

- 每筆市價要求雙時間戳(交易所時戳/接收時戳)+ 來源標籤(live feed/rest_fallback/cached/previous_close)。
- 按資產類別設 stale 門檻,狀態:`LIVE / DEGRADED / STALE`。即時資料用秒級(如 ≤3s/3-10s/>10s),日頻資料用天數(如收盤價 >1 個交易日未更新 = STALE)。門檻依公司配置,缺配置用預設並標注。
- **鐵則:STALE 或 FALLBACK 價格不得觸發警報結論、交易建議或任何自動化決策**;只能輸出「資料過期,需人工確認」。fallback 快照標 FALLBACK,絕不靜默當 LIVE 用。

## 3. 雙層檢核(規則層優先,統計層補充)

**第一層 deterministic**(先跑,結果可稽核):
- 完整性:預期檔數/筆數/標的清單 vs 實收;缺漏清單。
- 一致性:cross-vendor 差異超容差;識別碼對映(同一標的多來源代碼)。
- 合理性:零價/負價/零成交量;day-over-day 變動超容差(按資產類別分層)。
- 時效:§2 狀態機。

**第二層統計 ensemble**(補充,單法會漏):z-score/IQR/MAD 多法並用。
**outlier 處置前必對照事件脈絡**(財報、除權息、市場事件)——極端行情下真實價格本身就像 outlier,不得單憑統計閾值剔除。處置只有:保留+標注 / 開 exception 轉人工。**AI 不自行剔除或改值。**

## 4. 多來源與獨立性

- 取值依預設 pricing waterfall(來源優先序),明示用了第幾順位;**禁止自行平均或挑好看的來源**。
- 驗價基準須獨立於待驗證來源(IPV 原則):不得拿前台/策略端自己報的價當驗證基準。獨立來源不足(低流動性品種)→ 明示「不可獨立驗證」,不硬給結論。逐項檢視,不看淨額(正負互抵會掩蓋問題)。
- 參考 FRTB RFET 的嚴格標準:實際成交價/可查證第三方成交/committed quote 才算 real price;indicative、mid marks、模型價、stale price 都不算。

## 5. 容差與例外

- 容差按 instrument type/asset class 分層配置;AI 只引用不放寬。低於容差自動 clear + log;超容差開結構化 exception:`{根因分類, 證據, 重大性, 升級對象, override 理由(若有)}`——不把理由留在對話裡(業界公認痛點:override 散落 email/試算表)。
- Manual Intervention Rate 回饋校準容差(太多人工=容差太緊或上游品質差)。

## 6. 輸出格式

1. 狀態行:`檢核 N 檔/M 筆,FAIL x,STALE y,exception z`。
2. 五維度紅綠燈表 + exception 明細(只列超容差)。
3. 每個結論附 lineage:來源系統、擷取時點、通過的驗證規則。
4. 檢核用的 pandas/SQL code 附上(可重跑)。

## pandas 檢核 pattern(參考,依實際資料形狀調整)

```python
# 完整性:預期 vs 實收
missing = set(expected_ids) - set(df["id"])
# 時效:most recent date per id
stale = df.groupby("id")["asof"].max().lt(cutoff_date)
# 合理性:day-over-day 變動
ret = df.pivot(index="date", columns="id", values="px").pct_change().iloc[-1]
flags = ret.abs() > tol_by_class.reindex(ret.index)   # 分層容差
# 一致性:cross-source
diff = (px_a - px_b).abs() / px_b > xsrc_tol
```

## 為什麼(教材)

- 檢核分類骨架直接用 BCBS 239——監理已把「風險資料品質」定義成硬標準,不必自創分類。
- deterministic 優先:規則層結果可稽核、可重跑;統計層只補漏。順序反了會做出「模型覺得怪」這種無法對監理交代的檢核。
- 資料品質連到資本成本(FRTB:資料不合格 → NMRF → 額外資本計提)——品質檢核不是潔癖,是錢。
