// Token usage per person × session, from Claude Code transcripts on this machine.
// Usage: node token-report-sessions.js [days=30] > out.json
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
  const parts = cwd.split(/[\\/]/), i = parts.indexOf(BASE);
  if (i < 0) return '(其他)';
  return parts[i + 1] || '(根目錄/DM)';
}
function userText(m) {
  if (!m || m.role !== 'user') return null;
  const c = typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? (m.content.find(x => x.type === 'text') || {}).text : null;
  if (!c) return null;
  const t = c.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return t && !t.startsWith('[Request interrupted') ? t : null;
}

const seen = new Set(), S = {};
for (const f of walk(ROOT)) {
  if (fs.statSync(f).mtimeMs < cutoff) continue;
  const isSub = f.includes(path.sep + 'subagents' + path.sep);
  let fileCwd = null;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.cwd) fileCwd = d.cwd;
    const sid = d.sessionId; if (!sid) continue;
    const s = S[sid] || (S[sid] = { sid, person: null, title: null, named: null, first: null, last: null, calls: 0, in: 0, cw: 0, cr: 0, out: 0, sub: 0, models: {} });
    if (!s.person && (d.cwd || fileCwd)) s.person = person(d.cwd || fileCwd);
    if (d.type === 'custom-title' && d.customTitle) s.named = d.customTitle;
    if (d.type === 'summary' && d.summary && !s.named) s.named = d.summary;
    if (!isSub && !s.title) { const t = userText(d.message); if (t) s.title = t.slice(0, 40); }
    const m = d.message, u = m && m.usage;
    if (!u || (d.timestamp && Date.parse(d.timestamp) < cutoff)) continue;
    const key = (m.id || '') + '|' + (d.requestId || '');
    if (m.id && seen.has(key)) continue;
    seen.add(key);
    if (d.timestamp) { if (!s.first || d.timestamp < s.first) s.first = d.timestamp; if (!s.last || d.timestamp > s.last) s.last = d.timestamp; }
    const tot = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    s.calls++; s.in += u.input_tokens || 0; s.cw += u.cache_creation_input_tokens || 0;
    s.cr += u.cache_read_input_tokens || 0; s.out += u.output_tokens || 0;
    if (isSub) s.sub += tot;
    const mod = (m.model || '?').replace(/^claude-/, ''); s.models[mod] = (s.models[mod] || 0) + 1;
  }
}
const rows = Object.values(S).filter(s => s.calls).map(s => ({ ...s, total: s.in + s.cw + s.cr + s.out }));
rows.sort((a, b) => b.total - a.total);
console.log(JSON.stringify({ days, generated: new Date().toISOString(), rows }, null, 1));
