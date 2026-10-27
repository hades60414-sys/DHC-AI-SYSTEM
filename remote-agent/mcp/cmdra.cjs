// Run CMD lines on srv-db through a fresh ragent-mcp server (ragent_cmd, agent v3.5). Each argument is one command line, run in order.
// Usage: node cmdra.cjs [--timeout=N] "<cmd 1>" ["<cmd 2>" ...]
const { spawn } = require('child_process'), path = require('path');
// --file=<path>: read one command per line from a UTF-8 file (avoids shell quoting of backslashes and Chinese).
const args = process.argv.slice(2), opt = args.filter(a => a.startsWith('--')), cmds = args.filter(a => !a.startsWith('--'));
for (const o of opt.filter(a => a.startsWith('--file='))) cmds.push(...require('fs').readFileSync(o.slice(7), 'utf8').split(/\r?\n/).filter(l => l.trim()));
const timeout = Number((opt.find(a => a.startsWith('--timeout=')) || '').split('=')[1]) || undefined;
if (!cmds.length) throw new Error('usage: node cmdra.cjs [--timeout=N] "<cmd>" ...');
const srv = spawn(process.execPath, [path.join(__dirname, 'ragent-mcp.cjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '', id = 0; const waiting = new Map();
srv.stdout.setEncoding('utf8');
srv.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
const rpc = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
(async () => {
  await rpc('initialize', {});
  for (const cmd of cmds) {
    const t = Date.now(), m = await rpc('tools/call', { name: 'ragent_cmd', arguments: { cmd, ...(timeout ? { timeout_sec: timeout } : {}) } });
    const text = m.result ? m.result.content.map(c => c.text).join('\n') : JSON.stringify(m.error);
    console.log(`\n=== ${cmd.slice(0, 120)} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    const j = /\{"kind":"cmd_run".*\}/.exec(text); let r = null; try { r = j && JSON.parse(j[0]); } catch { }
    if (r && r.executed) console.log(`exit=${r.exit_code}${r.timed_out ? ' TIMEOUT' : ''} ${r.duration_ms}ms\n${r.stdout}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}`);
    else console.log(r ? JSON.stringify(r) : text);
  }
  srv.stdin.end();
})().catch(e => { console.error(e); process.exit(1); });
