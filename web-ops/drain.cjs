// Planned-maintenance drain: pause running conversations at their next tool call, restart, then resume them.
//   node drain.cjs start --reason <text> [--except <sessionId>]...   raise drain.json; ~/.claude/hooks/drain-guard.js then
//        denies every tool call (except the checkpoint write) and records the session in drain\paused\.
//   node drain.cjs status                       who is paused, who wrote a checkpoint, what idle-check says
//   node drain.cjs resume [--dry]               remove drain.json, send each paused session one continue message
//   node drain.cjs tick                         (health-check, every 5 min) resume if the drain is older than 3 h
//   node drain.cjs cancel                       same as resume (nothing restarted; paused sessions still continue)
// tas-post-restart.cmd runs `resume` after CloudCLI is back. The asker passes its own id to --except (CloudCLI or Claude id).
'use strict';
const fs = require('fs'), path = require('path');
const { spawn, execFileSync } = require('child_process');
const Database = require('D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/better-sqlite3');

const ROOT = process.env.DRAIN_ROOT || __dirname; // DRAIN_ROOT: test folder only
const FLAG = path.join(ROOT, 'drain.json');
const DIR = path.join(ROOT, 'drain');
const PAUSED = path.join(DIR, 'paused');
const LOG = path.join(ROOT, 'drain.log');
const NODE = 'D:\\TAS\\node\\node.exe';
const MAX_AGE = 3 * 3600e3;
const [cmd, ...rest] = process.argv.slice(2);
const opt = (f) => rest.flatMap((x, i) => (x === f && rest[i + 1] ? [rest[i + 1]] : []));
const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };
const db = () => new Database('D:/TAS/cc-web/data/auth.db', { readonly: true });

// The hook sees Claude transcript ids; accept CloudCLI ids too and store both.
function expandIds(ids) {
  const out = new Set(ids), d = db();
  const get = d.prepare('select session_id, provider_session_id from sessions where session_id = ? or provider_session_id = ?');
  for (const id of ids) for (const r of get.all(id, id)) { out.add(r.session_id); if (r.provider_session_id) out.add(r.provider_session_id); }
  d.close();
  return [...out];
}

function paused() {
  if (!fs.existsSync(PAUSED)) return [];
  return fs.readdirSync(PAUSED).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(PAUSED, f), 'utf8')));
}

function resume(dry) {
  const list = paused();
  if (!dry && fs.existsSync(FLAG)) { fs.renameSync(FLAG, path.join(DIR, `drain-${Date.now()}.json`)); log('drain flag removed'); }
  const d = db();
  const find = d.prepare('select session_id, model, isArchived from sessions where provider_session_id = ? order by updated_at desc limit 1');
  for (const p of list) {
    const row = find.get(p.sessionId), ckpt = path.join(DIR, `${p.sessionId}.md`);
    if (!row || row.isArchived) { log(`skip ${p.sessionId} (${p.cwd}): ${row ? 'archived' : 'not a DHC CLI session, resume by hand'}`); }
    else {
      const msg = fs.existsSync(ckpt)
        ? `計畫性維護完成，TAS 已重啟。請先讀 ${ckpt}，確認上次做到哪（檔案、子代理可能只做一半），再接著做完，不用重頭解釋。`
        : '計畫性維護完成，TAS 已重啟。你暫停前沒寫 checkpoint：請從對話紀錄判斷做到哪（檔案、子代理可能只做一半），再接著做完，不用重頭解釋。';
      const mode = p.permissionMode || 'default';
      if (dry) log(`would resume ${row.session_id} (${p.cwd}) model=${row.model || 'default'} mode=${mode} checkpoint=${fs.existsSync(ckpt)}`);
      else {
        const out = fs.openSync(path.join(DIR, `resume-${p.sessionId}.log`), 'a');
        spawn(NODE, [path.join(__dirname, 'resume-session.cjs'), row.session_id, row.model || 'default', mode, msg], { detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
        log(`resume ${row.session_id} (${p.cwd}) mode=${mode} checkpoint=${fs.existsSync(ckpt)}`);
      }
    }
    if (!dry) fs.renameSync(path.join(PAUSED, `${p.sessionId}.json`), path.join(DIR, `resumed-${p.sessionId}-${Date.now()}.json`));
  }
  d.close();
  if (!list.length) log('resume: no paused sessions');
}

if (cmd === 'start') {
  const reason = opt('--reason')[0] || '維護';
  fs.mkdirSync(PAUSED, { recursive: true });
  const except = expandIds(opt('--except'));
  fs.writeFileSync(FLAG, JSON.stringify({ since: new Date().toISOString(), reason, except }, null, 1));
  log(`drain start: ${reason}; except ${except.join(',') || '-'}`);
} else if (cmd === 'status') {
  if (!fs.existsSync(FLAG)) console.log('no drain in progress');
  else { const f = JSON.parse(fs.readFileSync(FLAG, 'utf8')); console.log(`drain since ${f.since} (${f.reason})`); }
  for (const p of paused()) console.log(`paused ${p.sessionId} ${p.cwd} checkpoint=${fs.existsSync(path.join(DIR, `${p.sessionId}.md`))}`);
  try { console.log(execFileSync(NODE, [path.join(__dirname, 'idle-check.cjs'), ...rest], { encoding: 'utf8' }).trim()); } catch (e) { console.log(String(e.stdout || e.message).trim()); }
} else if (cmd === 'resume' || cmd === 'cancel') {
  resume(rest.includes('--dry'));
} else if (cmd === 'tick') {
  if (fs.existsSync(FLAG) && Date.now() - Date.parse(JSON.parse(fs.readFileSync(FLAG, 'utf8')).since) > MAX_AGE) { log('drain older than 3 h without a restart: resuming'); resume(false); }
} else {
  console.log('usage: node drain.cjs start --reason <text> [--except <id>] | status | resume [--dry] | tick | cancel');
  process.exitCode = 2;
}
