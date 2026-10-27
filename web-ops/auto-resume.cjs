// Auto-resume DHC CLI sessions that stopped on "You've hit your session limit · resets 5pm".
// Runs from cc-hosts\health-check.cmd every 5 minutes. A session gets one continue message when:
//   - its last chat entry is the limit message (nobody has continued it yet), from the last 8 hours,
//   - the reset time has passed by 2 minutes,
//   - it is not 01:00-06:00 (keeps the 06:00 morning check's usage window aligned),
//   - it was not resumed for this limit message before (auto-resume-state.json),
//   - it is not listed in auto-resume-skip.txt (one Claude session id or project path fragment per line).
// 2026-10-20: also resumes sessions cut off by a host crash/reboot: the machine booted within the last 12 hours,
// the session was written in the 20 minutes before boot, and its last chat entry is not a finished assistant reply.
// usage: node auto-resume.cjs [--dry]      log: auto-resume.log
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const CLOUDCLI = 'D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/';
const WebSocket = require(CLOUDCLI + 'ws');
const Database = require(CLOUDCLI + 'better-sqlite3');

const DRY = process.argv.includes('--dry');
const PROJECTS = process.env.AUTO_RESUME_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const DB = process.env.AUTO_RESUME_DB || 'D:/TAS/cc-web/data/auth.db';
const STATE = path.join(__dirname, 'auto-resume-state.json');
const SKIP = path.join(__dirname, 'auto-resume-skip.txt');
const LOG = path.join(__dirname, 'auto-resume.log');
const MSG = '額度已恢復。請接著完成剛才因為用量上限被中斷的工作（就是我上一則訊息要的事），不用重頭解釋。';
const LIMIT_RE = /hit your (?:session |usage )?limit\s*·\s*resets (\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const BOOT_MSG = '主機剛才意外重開（藍屏或斷電），這個對話被中斷了。請先確認上一步做到哪（檔案、測試、子代理可能只做一半），再從斷點接著做完，不用重頭解釋。';
const log = (s) => { const line = `${new Date().toISOString()} ${DRY ? '[dry] ' : ''}${s}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };

function textOf(e) {
  const c = e.message?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text || '').join('') : '';
}

// Returns the limit entry and reset time if the session is waiting on a passed reset, else null.
function readTail(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size, len = Math.min(size, 256 * 1024), buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
  return buf.toString('utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// 2026-10-25: the 256 KB tail of a long session may hold no permissionMode, which fell back to 'default' and left a
// bypass session waiting on approvals nobody could give; then search the whole file for the last recorded mode.
function modeOf(file, entries) {
  const modes = entries.filter((e) => e.permissionMode).map((e) => e.permissionMode);
  if (modes.length) return modes[modes.length - 1];
  const m = [...fs.readFileSync(file, 'utf8').matchAll(/"permissionMode":"(\w+)"/g)].pop();
  return m ? m[1] : 'default';
}

function info(file, entries, last) {
  return { uuid: last.uuid, at: new Date(last.timestamp), providerId: last.sessionId, cwd: last.cwd || '', permissionMode: modeOf(file, entries) };
}

// True when the transcript was written in the 20 minutes before boot and stops mid-work:
// a pending tool call, a tool result, or an unanswered prompt.
function cutOff(file, bootAt, sidechain) {
  const mtime = fs.statSync(file).mtimeMs;
  if (mtime > bootAt || mtime < bootAt - 20 * 60e3) return null;
  const entries = readTail(file);
  const chat = entries.filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isMeta && (sidechain || !e.isSidechain));
  const last = chat[chat.length - 1];
  if (!last) return null;
  if (last.type === 'assistant' && (last.message?.stop_reason !== 'tool_use' || LIMIT_RE.test(textOf(last)))) return null;
  return { entries, last };
}

// A session the reboot cut off, either itself or through a background subagent it was waiting on.
function findInterrupted(file, bootAt) {
  if (fs.statSync(file).mtimeMs > bootAt) return null; // someone already used it after the reboot
  let hit = cutOff(file, bootAt, false);
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  if (!hit && fs.existsSync(subDir) && fs.readdirSync(subDir).some((f) => f.endsWith('.jsonl') && cutOff(path.join(subDir, f), bootAt, true))) {
    const entries = readTail(file);
    const chat = entries.filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isMeta && !e.isSidechain);
    if (chat.length) hit = { entries, last: chat[chat.length - 1] };
  }
  if (!hit) return null;
  const { entries, last } = hit;
  const c = info(file, entries, last);
  c.providerId ||= path.basename(file, '.jsonl');
  return { ...c, uuid: 'boot:' + Math.round(bootAt / 60e3) + ':' + c.providerId, boot: true };
}

function findCandidate(file, now) {
  const entries = readTail(file);
  const chat = entries.filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isMeta && !e.isSidechain);
  const last = chat[chat.length - 1];
  if (!last || last.type !== 'assistant') return null;
  const m = textOf(last).match(LIMIT_RE);
  if (!m) return null;
  const at = new Date(last.timestamp);
  if (now - at > 8 * 3600e3) return null;
  let h = Number(m[1]) % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  const reset = new Date(at); reset.setHours(h, Number(m[2] || 0), 0, 0);
  if (reset <= at) reset.setDate(reset.getDate() + 1);
  if (now < reset.getTime() + 2 * 60e3) return null;
  return { uuid: last.uuid, at, reset, providerId: last.sessionId || path.basename(file, '.jsonl'), cwd: last.cwd || '', permissionMode: modeOf(file, entries) };
}

// Sends the continue message and waits up to 20 s for the server to accept it (closing the socket does not abort the run).
function send(sessionId, model, permissionMode, content) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:3001/ws');
    const finish = (r) => { try { ws.close(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish('sent (no reply frame within 20 s)'), 20000);
    ws.on('error', (e) => { clearTimeout(timer); finish('ws error ' + e.message); });
    ws.on('open', () => {
      const skip = permissionMode === 'bypassPermissions';
      ws.send(JSON.stringify({ type: 'chat.send', sessionId, content,
        options: { model, permissionMode, toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: skip }, skipPermissions: skip, attachments: [] } }));
    });
    ws.on('message', (data) => {
      let f;
      try { f = JSON.parse(data.toString()); } catch { return; }
      if (f.sessionId !== sessionId) return;
      clearTimeout(timer);
      finish(f.kind === 'protocol_error' || f.kind === 'error' ? `failed ${f.code || ''} ${String(f.error || '').slice(0, 150)}` : 'started');
    });
  });
}

(async () => {
  const now = Date.now(), hour = new Date().getHours();
  if (hour >= 1 && hour < 6) return;
  let state = {};
  if (fs.existsSync(STATE)) { try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { log('state file unreadable, abort: ' + e.message); return; } }
  const saveState = () => { if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state, null, 1)); };
  const skip = fs.existsSync(SKIP) ? fs.readFileSync(SKIP, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')) : [];
  // Boot time; AUTO_RESUME_BOOT_AT (ISO) overrides it for dry-run tests. Wait 3 minutes after boot for the server.
  const bootAt = process.env.AUTO_RESUME_BOOT_AT ? Date.parse(process.env.AUTO_RESUME_BOOT_AT) : now - os.uptime() * 1000;
  const bootRecent = now - bootAt < 12 * 3600e3 && now - bootAt > 3 * 60e3;
  const cands = [];
  for (const dir of fs.readdirSync(PROJECTS)) {
    const full = path.join(PROJECTS, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(full, f);
      const age = now - fs.statSync(file).mtimeMs;
      const c = (age <= 8 * 3600e3 ? findCandidate(file, now) : null) || (bootRecent && age <= 12.5 * 3600e3 ? findInterrupted(file, bootAt) : null);
      if (c && (!state[c.uuid] || state[c.uuid] === 'retry') && !skip.some((s) => c.providerId === s || c.cwd.includes(s))) cands.push(c);
    }
  }
  if (!cands.length) return;
  const db = new Database(DB, { readonly: true });
  const find = db.prepare('SELECT session_id, model, isArchived FROM sessions WHERE provider_session_id = ? ORDER BY updated_at DESC LIMIT 1');
  for (const c of cands) {
    const row = find.get(c.providerId);
    const label = c.boot ? `${c.providerId} (${c.cwd}) cut off by reboot, last entry ${c.at.toLocaleString()}` : `${c.providerId} (${c.cwd}) limit ${c.at.toLocaleTimeString()} reset ${c.reset.toLocaleTimeString()}`;
    if (!row || row.isArchived) { log(`skip ${label}: ${row ? 'archived' : 'not a DHC CLI session'}`); state[c.uuid] = 'skipped'; continue; }
    if (DRY) { log(`would resume ${label} as ${row.session_id} model=${row.model || 'default'} mode=${c.permissionMode}`); continue; }
    // 2026-10-18: record before sending (an overlapping or crashed run must not send twice); failures retry up to 3 times.
    const n = (state['n:' + c.uuid] || 0) + 1;
    state['n:' + c.uuid] = n; state[c.uuid] = 'sending'; saveState();
    const r = await send(row.session_id, row.model || 'default', c.permissionMode, c.boot ? BOOT_MSG : MSG);
    log(`resume ${label}: ${r} (attempt ${n})`);
    state[c.uuid] = r.startsWith('failed') || r.startsWith('ws error') ? (n >= 3 ? 'failed' : 'retry') : 'resumed';
    saveState();
  }
  db.close();
  saveState();
})().catch((e) => log('error ' + e.stack));
