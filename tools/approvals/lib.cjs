// 核准單共用：核准單檔、聊天室讀寫、直接呼叫遠端代理（不經過模型）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const DIR = path.join(__dirname, 'tickets');
const LOG = path.join(__dirname, 'approvals.log');
const BASE = process.env.NUDGE_BASE || 'http://127.0.0.1:3001';
const ASSISTANT = 'dhc-assistant';
const MCP_JSON = 'D:/TAS/Claude Code專案/Harness優化/.mcp.json';
const TTL_MS = 24 * 3600 * 1000;

const sha = (machine, cmd) => crypto.createHash('sha256').update(machine + '\n' + cmd).digest('hex');
const ticketPath = (id) => path.join(DIR, id + '.json');
const load = (id) => JSON.parse(fs.readFileSync(ticketPath(id), 'utf8'));
const save = (t) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(ticketPath(t.id), JSON.stringify(t, null, 2), 'utf8'); };
const log = (line) => fs.appendFileSync(LOG, `${new Date().toISOString()}\t${line}\n`, 'utf8');

function servers() {
  return JSON.parse(fs.readFileSync(MCP_JSON, 'utf8')).mcpServers;
}
const NAMES = { rag1: 'srv-rag' }; // 使用者叫 RAG1 為 srv-rag
function label(machine) {
  if (NAMES[machine]) return NAMES[machine];
  const s = servers()[machine];
  return (s && s.env && s.env.RAGENT_LABEL) || (machine === 'ragent' ? 'srv-db' : machine);
}

const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
  return res.json();
};
const roomKey = (room) => `dhc.chat:${room}`;
async function readMsgs(room) {
  return (await api('GET', '/api/user/preferences'))?.preferences?.[roomKey(room)]?.msgs ?? [];
}
// 貼一則小助手訊息；button 有給就掛成這則的按鈕（小助手既有的追問按鈕，只掛最新一則）
async function post(room, text, button) {
  const msgs = await readMsgs(room);
  const lastAt = msgs.reduce((m, x) => (x.at > m ? x.at : m), '');
  const at = new Date(Math.max(Date.now(), lastAt ? Date.parse(lastAt) + 1 : 0)).toISOString();
  const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await api('PATCH', '/api/user/preferences', { [roomKey(room)]: { msgs: [...msgs, { id, by: ASSISTANT, text, at, refs: [] }].sort((a, b) => a.at.localeCompare(b.at)).slice(-300) } });
  if (button) {
    const nextDir = path.join(process.env.ASSISTANT_ROOT || path.join(os.homedir(), '.cloudcli', 'assistant'), 'next');
    fs.mkdirSync(nextDir, { recursive: true });
    fs.writeFileSync(path.join(nextDir, room.replace(/[^\w-]/g, '_') + '.json'), JSON.stringify({ messageId: id, items: [button] }), 'utf8');
  }
  return { id, at };
}

// 當 MCP client 叫起那台的 ragent-mcp.cjs，呼叫一個工具，拿回文字
function callTool(machine, tool, args, timeoutMs) {
  const s = servers()[machine];
  if (!s) throw new Error('沒有這台：' + machine);
  return new Promise((resolve, reject) => {
    const p = spawn(s.command, s.args, { env: { ...process.env, ...(s.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '', done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); p.kill(); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('等代理逾時')), timeoutMs);
    const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
    p.on('error', (e) => finish(e));
    p.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
        } else if (m.id === 2) {
          if (m.error) return finish(new Error(m.error.message));
          finish(null, { text: (m.result.content || []).map((x) => x.text).join('\n'), isError: !!m.result.isError });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'approvals', version: '0.1.0' } } });
  });
}

module.exports = { DIR, ASSISTANT, TTL_MS, sha, ticketPath, load, save, log, label, servers, readMsgs, post, callTool };
