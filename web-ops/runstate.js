// Ask the live DHC CLI server which recent sessions have a run in progress (chat.subscribe -> chat_subscribed).
const WebSocket = require('D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/ws');
const Database = require('D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/better-sqlite3');
const db = new Database('D:/TAS/cc-web/data/auth.db', { readonly: true });
const rows = db.prepare("select session_id, provider, updated_at from sessions order by updated_at desc limit 12").all();
const ws = new WebSocket('ws://127.0.0.1:3001/ws');
const seen = new Map();
ws.on('open', () => ws.send(JSON.stringify({ type: 'chat.subscribe', sessions: rows.map(r => ({ sessionId: r.session_id })) })));
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.kind === 'chat_subscribed' || m.type === 'chat_subscribed') {
    seen.set(m.sessionId, m.isProcessing);
    if (seen.size === rows.length) finish();
  }
});
function finish() {
  for (const r of rows) console.log((seen.get(r.session_id) ? 'RUNNING ' : 'idle    ') + r.provider.padEnd(7) + ' ' + r.updated_at + ' ' + r.session_id);
  console.log('ANY_RUNNING=' + [...seen.values()].some(Boolean));
  ws.close(); process.exit(0);
}
setTimeout(() => { console.log('timeout; got ' + seen.size + '/' + rows.length); finish(); }, 5000);
