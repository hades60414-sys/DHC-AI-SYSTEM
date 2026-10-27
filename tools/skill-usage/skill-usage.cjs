// 統計 harness 每個 skill 最近 N 天被 Skill 工具叫過幾次（2026-10-25）。只讀對話紀錄，不改任何東西。
//   node skill-usage.cjs [天數=30] [skills 資料夾]
// 限制：使用者打 /技能名、或代理直接 Read SKILL.md 不會被算到；次數 0 只是候選，不是刪除依據。
const fs = require('fs'), path = require('path');
const days = Number(process.argv[2] || 30);
const skillsDir = process.argv[3] || 'D:/TAS/Claude Code專案/Harness優化/agent-harness-v2/skills';
const root = path.join(process.env.USERPROFILE, '.claude', 'projects');
const since = Date.now() - days * 864e5, cnt = {}, last = {};
let files = 0, oldest = Infinity;
for (const d of fs.readdirSync(root)) {
  let list; try { list = fs.readdirSync(path.join(root, d)); } catch { continue; }
  for (const f of list) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(root, d, f), st = fs.statSync(fp);
    oldest = Math.min(oldest, st.mtimeMs);
    if (st.mtimeMs < since) continue;
    files++;
    const re = /"name":"Skill","input":\{"skill":"([^"]+)"/g, t = fs.readFileSync(fp, 'utf8');
    for (let m; (m = re.exec(t));) { const s = m[1].replace(/^.*:/, ''); cnt[s] = (cnt[s] || 0) + 1; last[s] = Math.max(last[s] || 0, st.mtimeMs); }
  }
}
console.log(`範圍：最近 ${days} 天，${files} 個對話檔；最早紀錄 ${new Date(oldest).toISOString().slice(0, 10)}`);
const rows = fs.readdirSync(skillsDir).map((s) => [s, cnt[s] || 0, last[s] ? new Date(last[s]).toISOString().slice(0, 10) : '-']).sort((a, b) => a[1] - b[1]);
for (const r of rows) console.log(r.join('\t'));
