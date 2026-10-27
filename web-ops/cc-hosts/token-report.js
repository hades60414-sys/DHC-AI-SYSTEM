// Token usage per person (first folder under "Claude Code專案"), from Claude Code transcripts.
// Node port of token-report.py (python is blocked on this machine).
// Usage: node token-report.js [days=30]
const fs = require('fs'), path = require('path'), os = require('os');
const days = parseFloat(process.argv[2] || '30');
const cutoff = Date.now() - days * 86400e3;
const ROOT = path.join(os.homedir(), '.claude', 'projects');
const BASE = 'Claude Code專案';

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}
function person(cwd) {
  if (!cwd) return '(未知)';
  const parts = cwd.split(/[\\/]/);
  const i = parts.indexOf(BASE);
  if (i < 0) return '(其他：' + (parts.slice(-2).join('\\') || cwd) + ')';
  return parts[i + 1] || '(根目錄/DM)';
}

const seen = new Set();
const agg = {}; // person -> {calls,in,cw,cr,out, models:{}}
for (const f of walk(ROOT)) {
  if (fs.statSync(f).mtimeMs < cutoff) continue;
  let fileCwd = null;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.cwd) fileCwd = d.cwd;
    const m = d.message, u = m && m.usage;
    if (!u) continue;
    if (d.timestamp && Date.parse(d.timestamp) < cutoff) continue;
    const key = (m.id || '') + '|' + (d.requestId || '');
    if (m.id && seen.has(key)) continue;
    seen.add(key);
    const p = person(d.cwd || fileCwd);
    const a = agg[p] || (agg[p] = { calls: 0, in: 0, cw: 0, cr: 0, out: 0, models: {} });
    a.calls++; a.in += u.input_tokens || 0; a.cw += u.cache_creation_input_tokens || 0;
    a.cr += u.cache_read_input_tokens || 0; a.out += u.output_tokens || 0;
    const mod = (m.model || '?').replace(/^claude-/, '');
    a.models[mod] = (a.models[mod] || 0) + 1;
  }
}
const rows = Object.entries(agg).map(([p, a]) => ({ p, ...a, total: a.in + a.cw + a.cr + a.out }));
rows.sort((x, y) => y.total - x.total);
const T = rows.reduce((s, r) => s + r.total, 0);
console.log(JSON.stringify({ days, generated: new Date().toISOString(), grandTotal: T, rows }, null, 1));
