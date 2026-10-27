// Move a DHC CLI (Claude) session to another project: wait until it is idle, put its transcript in the
// target project's ~/.claude/projects folder with every `cwd` rewritten (the server's synchronizer takes the
// project from the first row's cwd and would otherwise move the row back), then repoint the DB row.
// The old transcript is renamed to *.jsonl.moved-bak so the synchronizer stops seeing it.
// usage: node move-session.cjs <sessionId> "<target project path>"
const fs = require('fs');
const path = require('path');
const WebSocket = require('D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/ws');
const Database = require('D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/better-sqlite3');

const [sessionId, targetProject] = process.argv.slice(2);
if (!sessionId || !targetProject) { console.error('usage: node move-session.cjs <sessionId> "<target project path>"'); process.exit(2); }
const DB = 'D:/TAS/cc-web/data/auth.db';
const log = (...a) => console.log(new Date().toISOString(), ...a);
const encode = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

function isProcessing() {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:3001/ws');
    const t = setTimeout(() => { ws.terminate(); resolve(null); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId }] })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if ((m.kind === 'chat_subscribed' || m.type === 'chat_subscribed') && m.sessionId === sessionId) {
        clearTimeout(t); ws.close(); resolve(Boolean(m.isProcessing));
      }
    });
    ws.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

function rewriteCwd(text, target) {
  return text.split('\n').map((line) => {
    if (!line.includes('"cwd"')) return line;
    try { const o = JSON.parse(line); if (typeof o.cwd === 'string') { o.cwd = target; return JSON.stringify(o); } } catch {}
    return line;
  }).join('\n');
}

(async () => {
  const ro = new Database(DB, { readonly: true });
  const row = ro.prepare('select * from sessions where session_id=?').get(sessionId);
  ro.close();
  if (!row) { log('session not found'); process.exit(1); }
  const src = row.jsonl_path;
  const dstDir = path.join(process.env.USERPROFILE, '.claude', 'projects', encode(targetProject));
  const dst = path.join(dstDir, path.basename(src));
  const oldDir = path.join(process.env.USERPROFILE, '.claude', 'projects', encode(row.project_path));
  const old = path.join(oldDir, path.basename(src));

  // idle = server says not processing on two checks 60s apart and the transcript did not grow
  for (;;) {
    const a = await isProcessing(); const sz = fs.statSync(src).size;
    await new Promise((r) => setTimeout(r, 60000));
    const b = await isProcessing(); const sz2 = fs.statSync(src).size;
    if (a === false && b === false && sz === sz2) break;
    log('still busy', { a, b, grew: sz2 - sz });
  }

  fs.mkdirSync(dstDir, { recursive: true });
  const tmp = dst + '.tmp';
  fs.writeFileSync(tmp, rewriteCwd(fs.readFileSync(src, 'utf8'), targetProject));
  fs.renameSync(tmp, dst);
  const sideDir = src.replace(/\.jsonl$/, '');
  if (src !== dst && fs.existsSync(sideDir)) fs.cpSync(sideDir, dst.replace(/\.jsonl$/, ''), { recursive: true });
  if (old !== dst && fs.existsSync(old)) fs.renameSync(old, old + '.moved-bak');

  if (await isProcessing()) { log('became busy during copy; DB untouched, rerun when idle'); process.exit(1); }
  const db = new Database(DB);
  db.pragma('busy_timeout = 5000');
  db.prepare('update sessions set project_path=?, jsonl_path=? where session_id=?').run(targetProject, dst, sessionId);
  db.close();
  log('moved', { sessionId, from: row.project_path, to: targetProject, jsonl: dst, oldRenamed: old + '.moved-bak' });
})();
