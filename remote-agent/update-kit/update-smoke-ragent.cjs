// Drive ragent_self_update for the real srv-db through a fresh MCP server (RAGENT_UPDATE=1), then poll health until the agent
// reports the expected version. Same flow as rag1\update-smoke.cjs. Usage: node update-smoke-ragent.cjs <kit.zip> <sha256> <expected-version>
const { spawn } = require('child_process'), path = require('path');
const [file, sha, expect] = process.argv.slice(2);
if (!expect) throw new Error('usage: node update-smoke-ragent.cjs <kit.zip> <sha256> <expected-version>');
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'ragent-mcp.cjs')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RAGENT_UPDATE: '1' } });
let buf = '', id = 0; const waiting = new Map();
srv.stdout.setEncoding('utf8');
srv.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
srv.stderr.on('data', d => process.stderr.write(d));
const rpc = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
const call = async (name, args = {}) => { const t = Date.now(); const m = await rpc('tools/call', { name, arguments: args }); const text = m.result ? m.result.content[0].text : JSON.stringify(m.error); console.log(`\n=== ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)\n${text}`); return text; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await rpc('initialize', {});
  const before = await call('ragent_health', { wait_seconds: 90 });
  if (!/agent=v3\.4/.test(before)) { console.log('\nSTOP: srv-db is not on v3.4 yet'); srv.stdin.end(); return; }
  await call('ragent_self_update', { file, sha256: sha, wait_seconds: 240 });
  for (let i = 0; i < 12; i++) {
    await sleep(i === 0 ? 45000 : 20000);
    const t = await call('ragent_health', { wait_seconds: 60 });
    if (t.includes(expect)) { console.log('\nVERSION CHANGED: ' + expect); break; }
  }
  srv.stdin.end();
})().catch(e => { console.error(e); process.exit(1); });
