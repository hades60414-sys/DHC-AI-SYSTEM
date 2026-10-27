# 第三方內容

詳細的來源、版本與安裝前審查紀錄在 [harness/THIRD-PARTY.md](harness/THIRD-PARTY.md)。這裡只列這個 repo 實際收錄與只列連結的部分。

## 收錄（MIT，原授權檔放在各資料夾的 `LICENSE`）

| 路徑 | 上游 | 版本 |
|---|---|---|
| `harness/skills/baton` | [blader/baton](https://github.com/blader/baton) | 2026-08-13 main |
| `harness/skills/baton-dispatch` | [cablate/baton](https://github.com/cablate/baton) | v0.1.1 |
| `harness/skills/buddhist-method` | [nai0om/buddhist-method](https://github.com/nai0om/buddhist-method) | 745caa7 |
| `harness/skills/caveman` | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | 2026-08-13 main（只收 MIT 涵蓋的 skills 部分） |
| `harness/skills/design-presentations` | [slidefirm/NESA-SLIDE](https://github.com/slidefirm/NESA-SLIDE) | 4b18b52 |
| `harness/skills/editorial-vision-studio` | [Yu-0312/editorial-vision-studio](https://github.com/Yu-0312/editorial-vision-studio) | 0bb7aad |
| `harness/skills/i-have-adhd` | [UberGuidoZ/i-have-adhd-claude](https://github.com/UberGuidoZ/i-have-adhd-claude) | 2026-08-13 main |
| `harness/skills/pilotfish-orchestration`、`harness/agents` 部分定義 | [Nanako0129/pilotfish](https://github.com/Nanako0129/pilotfish) | v1.3.10 |
| `harness/skills/sub-agents` | [shinpr/sub-agents-skills](https://github.com/shinpr/sub-agents-skills) | 2026-08-14 main |
| `harness/skills/{code-review,codebase-design,diagnosing-bugs,domain-modeling,tdd,writing-for-agents}` | [mattpocock/skills](https://github.com/mattpocock/skills) | 6654f6b |
| `harness/skills/ponytail*`（6 個） | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | 2ed6c52 |
| `harness/skills/ui-ux-pro-max` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | c87cdc2 |
| `harness/skills/statechart` | [cursor/plugins](https://github.com/cursor/plugins) `pstack/skills/statechart` | 9580c23 |
| `harness/skills/reverse-engineer-anything` | [morluto/rea](https://github.com/morluto/rea) | d532b181 |
| `harness/skills/video-studio/references/gsap` | [greensock/gsap-skills](https://github.com/greensock/gsap-skills) | aed9cfd |
| `harness/skills/chatgpt-bridge`（adapter 自寫，上游部分） | [Zhenyu98/codex-chatgpt-bridge](https://github.com/Zhenyu98/codex-chatgpt-bridge) | 351c66f |

`security-audit`、`ui-polish` 是參考公開方法論後自行重寫的內容，不含上游程式碼。`tas-charts` 是自寫的圖表與報告 skill，取代原本使用的 lieflat-charts（PolyForm Noncommercial，不收錄）。

## 只列連結（不收錄）

| 元件 | 原因 | 取得方式 |
|---|---|---|
| [pstack](https://github.com/michael-denyer/pstack-claude)（Claude Code plugin） | plugin 由 marketplace 安裝 | `claude plugin` 依上游說明安裝；模型設定見 `harness/rules/pstack-models.md` |
| [CloudCLI](https://github.com/siteboon/claudecodeui)／DHC CLI | AGPL-3.0，網頁版另有獨立 repo | 見 DHC CLI repo |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Anthropic 專有軟體 | 依官方說明安裝並登入 |
| Claude Code plugin 型別定義（`dhc-guard/.claude-plugin/types`） | Anthropic 提供 | 用 Claude Code 的 plugin 工具重新產生 |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) server 與模型權重 | 體積與各模型授權 | `local-model/install-gemma.cmd` 下載 |
| cloudflared、ffmpeg、TLA+ tools、Java runtime | 二進位檔 | 從各自官方下載 |
