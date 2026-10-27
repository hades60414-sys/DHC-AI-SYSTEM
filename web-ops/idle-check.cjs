// Is DHC CLI idle enough to restart? One look at the live server: chat runs (night queue runs show up here too),
// background subagents / tasks, and 中台小助手 replies in progress. Prints IDLE or BUSY <who>; exit 0 = idle, 1 = busy, 2 = cannot tell.
//   node idle-check.cjs [--except <sessionId>]   (the conversation that asked for the restart does not count)
const Database = require('D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/better-sqlite3');

const BASE = 'http://127.0.0.1:3001';
const except = new Set();
for (let i = 2; i < process.argv.length; i += 1) if (process.argv[i] === '--except' && process.argv[i + 1]) except.add(process.argv[++i]);

async function json(url) {
  const response = await fetch(BASE + url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return (await response.json()).data;
}

function names(ids) {
  try {
    const db = new Database('D:/TAS/cc-web/data/auth.db', { readonly: true });
    const get = db.prepare('select custom_name from sessions where session_id = ?');
    return ids.map((id) => get.get(id)?.custom_name || id.slice(0, 8));
  } catch {
    return ids.map((id) => id.slice(0, 8));
  }
}

// The asker may pass either the CloudCLI session id or the Claude transcript id; exclude both.
try {
  const db = new Database('D:/TAS/cc-web/data/auth.db', { readonly: true });
  const get = db.prepare('select session_id, provider_session_id from sessions where session_id = ? or provider_session_id = ?');
  for (const id of [...except]) for (const row of get.all(id, id)) { except.add(row.session_id); if (row.provider_session_id) except.add(row.provider_session_id); }
} catch {}
(async () => {
  const runs = await json('/api/providers/sessions/running');
  // A server older than 10/21 answers 400 without a roomId; then assistant replies cannot be seen (noted in the output).
  const assistant = await json('/api/assistant/status').catch((error) => (/ 400$/.test(error.message) ? null : Promise.reject(error)));
  const chats = (runs.sessions || []).map((item) => item.sessionId).filter((id) => !except.has(id));
  const background = (runs.background || []).map((item) => item.sessionId ?? item).filter((id) => typeof id === 'string' && !except.has(id));
  const busy = [
    ...names(chats).map((name) => `對話「${name}」`),
    ...names(background).map((name) => `背景「${name}」`),
    ...(assistant?.running ?? []).map((item) => `小助手回覆中（${item.roomId}）`),
  ];
  const note = assistant ? '' : '（舊伺服器，沒查小助手）';
  if (busy.length === 0) { console.log(`IDLE${note}`); process.exitCode = 0; return; }
  console.log(`BUSY ${busy.join('、')}${note}`);
  process.exitCode = 1;
})().catch((error) => { console.log(`UNKNOWN ${error.message}`); process.exitCode = 2; });
