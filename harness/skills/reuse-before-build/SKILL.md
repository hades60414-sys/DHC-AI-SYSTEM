---
name: reuse-before-build
description: 自建前先找現成。要新寫或大改一個 skill、hook、mod、外掛、MCP、自動化腳本或常駐服務之前使用；使用者說「做一個工具／技能／hook」「整合某功能進 TAS」「評估要不要裝」時也用。先搜已知外掛市集（含官方 claude-plugins-official 全部 300 多個）、已裝外掛的技能、本機技能與 hooks，再決定採用、擴充或自建。單次一次性腳本、改既有檔案的小修不用。
---

# 自建前先找現成

目的：不重複造輪子，也不裝一個比現有差的東西。

## 步驟

1. 列 2–4 組關鍵字（中英文都要，含同義詞），各跑一次：
   ```
   node <本技能資料夾>/scripts/find-existing.cjs <關鍵字...> [--top N]
   ```
   會搜：所有已知外掛市集（`~/.claude/plugins/marketplaces/*`，含沒裝的）、`~/.claude/skills`、已裝外掛帶的技能、`~/.claude/hooks`。
   市集清單太舊時先跑 `claude plugin marketplace update claude-plugins-official`。
2. 本機沒命中、而且是中大型需求：上 GitHub／網路查現成套件。
3. 對每個候選判斷，照這個順序選：
   - **已經有**：直接用，告訴使用者在哪。
   - **已裝但沒開**：開設定就好（例：ctx-handoff 的開關）。
   - **市集有、能用**：走 `scan-before-install` 掃描後安裝。本機不能跑 Python，hook 或腳本是 Python 的外掛不能用。
   - **有但不合**：借它的做法或 prompt，改寫成 Node／CMD 版，註明出處與授權。
   - **都沒有**：才自建。
4. 在回覆或報告裡寫一行結論：「搜了 X、Y；選 A，原因 B」。

## 注意

- 名字像不代表功能一樣：讀候選的說明或原始碼再決定。
- 跟現有功能重疊時，比較兩者再選，不要兩個都留（例：ctx-handoff 的 done_check 和自建的完成檢查擇一）。
- 已裝清單在 `~/.claude/plugins/installed_plugins.json`；TAS 自己的 mod 在 `Harness優化\agent-harness-v2\mods`。
