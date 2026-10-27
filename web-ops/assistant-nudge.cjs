// 中台小助理的主動提醒（2026-10-21 夜間任務 2）。不叫模型、不碰資料庫，只讀站內狀態後把提醒貼進每個人和小助理的私聊。
//   node assistant-nudge.cjs waiting        每 5 分鐘：對話停在「等你按允許」超過 4 分鐘 → 私聊提醒那個專案的人（同一個請求只提醒一次）
//   node assistant-nudge.cjs brief          平日早上一次：今天跟你有關的事（工作日曆、到期待辦、等你按的對話、重複手動的事）
//   加 --dry 只印不貼；加 --force 週末也跑、今天已發過也重發；測試時設 NUDGE_ONLY=<聊天室 id> 只發給那個人。
// 個人關掉：~/.cloudcli/assistant/nudge-off-<projectId>（小助理聽到「不用提醒我」會建）。
// 狀態：~/.cloudcli/assistant/nudge-state.json；紀錄：D:\TAS\cc-web\assistant-nudge.log。關掉：建立 ~/.cloudcli/assistant/nudge-off。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const BASE = process.env.NUDGE_BASE || 'http://127.0.0.1:3001';
const ROOT = path.join(os.homedir(), '.cloudcli', 'assistant');
const STATE = process.env.NUDGE_STATE || path.join(ROOT, 'nudge-state.json');
const CALENDAR = process.env.NUDGE_CALENDAR || path.join(ROOT, 'work-calendar.json');
const LOG = process.env.NUDGE_LOG || path.join(__dirname, 'assistant-nudge.log');
const DB = path.join(__dirname, 'data', 'auth.db');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const ASSISTANT = 'dhc-assistant';
const WAIT_MIN = Number(process.env.NUDGE_WAIT_MIN ?? 4);

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
// A failed log write must not throw: it would skip marking a sent reminder as notified, so it gets resent every run.
const log = (line) => { if (DRY) return console.log(`(dry) ${line}`); try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {} };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

/** Taipei wall clock as {date:'YYYY-MM-DD', day:0-6, y, m, d}. */
function taipei(now = Date.now()) {
  const t = new Date(now + 8 * 3600_000);
  return { date: t.toISOString().slice(0, 10), day: t.getUTCDay(), y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const isWeekday = (day) => day >= 1 && day <= 5;

/** Does a calendar rule fire on this Taipei date? Weekends never (no holiday table yet). */
function ruleFires(rule, today) {
  if (!isWeekday(today.day)) return false;
  switch (rule?.type) {
    case 'weekdays': return true;
    case 'date': return today.date === rule.date;
    case 'weekly': return today.day === rule.day;
    case 'monthDays': return (rule.days ?? []).includes(today.d);
    case 'lastWeekday': {
      const last = new Date(Date.UTC(today.y, today.m, 0));
      while (!isWeekday(last.getUTCDay())) last.setUTCDate(last.getUTCDate() - 1);
      return last.getUTCDate() === today.d;
    }
    case 'beforeMonthDay': return today.d <= rule.day && today.d >= rule.day - (rule.lead ?? 0);
    default: return false;
  }
}

// Owners (10-27): only `who` (confirmed by the person) gets reminded; `ask` = candidates asked once in the morning brief;
// `declined` = said "not mine", never reminded or asked again. The person's answer is recorded by this script, not the assistant model.
const arr = (x) => (Array.isArray(x) ? x : typeof x === 'string' && x ? [x] : []);
function roleOf(item, projectId) {
  if (arr(item.declined).includes(projectId)) return 'declined';
  if (arr(item.who).includes(projectId)) return 'who';
  if (arr(item.ask).includes(projectId)) return 'ask';
  return null;
}
const ASK_MAX = 3, ASK_TIMES = 2, ASK_GAP_DAYS = 7;
const LETTERS = 'ABC';
/** Candidate items to ask this person today: has an id, asked fewer than 2 times, last ask at least 7 days ago. */
function pickAsks(items, projectId, asked, todayDate) {
  return items.filter((it) => it.id && roleOf(it, projectId) === 'ask').filter((it) => {
    const h = asked[`${projectId}|${it.id}`];
    return !h || (h.n < ASK_TIMES && Date.parse(todayDate) - Date.parse(h.last) >= ASK_GAP_DAYS * 86400_000);
  }).slice(0, ASK_MAX);
}
/** One reply → {itemId: 'yes'|'no'}. The whole message must be an answer (everyday chat is ignored); letters pick items when several were asked,
 *  a bare 是／不是 only counts when one was asked. `bare` = whether a bare answer may count for this message. */
function parseClaim(text, ids, bare = true) {
  const t = String(text).replace(/[\s,，。.!！~～]+/g, '').toUpperCase();
  const all = (ans) => Object.fromEntries(ids.map((id) => [id, ans]));
  if (/^(都不是|全部不是|都不是我的?)$/.test(t)) return all('no');
  if (/^(都是|全部是|全都是|都是我的?)$/.test(t)) return all('yes');
  if (/^((不是|是)[ABC]([、和及]?[ABC])*的?)+$/.test(t)) {
    const out = {};
    for (const m of t.matchAll(/(不是|是)([ABC、和及]+)/g)) for (const l of m[2].match(/[ABC]/g)) { const id = ids[LETTERS.indexOf(l)]; if (id) out[id] = m[1] === '是' ? 'yes' : 'no'; }
    return out;
  }
  if (!bare || ids.length !== 1) return {};
  if (/^(不是|不是我|不是我的|不是喔|不是耶|不負責|不是我的是.+的?)$/.test(t)) return { [ids[0]]: 'no' };
  if (/^(是|是的|是我|是我的|對|對的|沒錯|我的|嗯對)$/.test(t)) return { [ids[0]]: 'yes' };
  return {};
}
/** Applies answers to the calendar in place; returns the items that changed (already-recorded answers are skipped). */
function applyClaims(cal, projectId, answers, at) {
  const changed = [];
  for (const [id, ans] of Object.entries(answers)) {
    const item = cal.items.find((it) => it.id === id);
    const role = item && roleOf(item, projectId);
    if (!item || (ans === 'yes' && role === 'who') || (ans === 'no' && role === 'declined')) continue;
    const drop = (k) => { item[k] = arr(item[k]).filter((x) => x !== projectId); };
    drop('ask'); drop('who'); drop('declined');
    item[ans === 'yes' ? 'who' : 'declined'].push(projectId);
    item.log = [...arr(item.log), { at, who: projectId, ans: ans === 'yes' ? '是' : '不是', src: '本人回早報確認' }];
    changed.push(item);
  }
  return changed;
}
/** Calendar, or null with a logged failure when the file is there but broken (so a bad edit is not mistaken for "nothing today"). */
function readCalendar() {
  if (!fs.existsSync(CALENDAR)) return { people: {}, items: [] };
  try { const cal = JSON.parse(fs.readFileSync(CALENDAR, 'utf8')); cal.items = arr(cal.items); cal.people ??= {}; return cal; } catch (e) { log(`FAIL calendar unreadable: ${e.message}`); return null; }
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
  return res.json();
}
const prefs = async () => (await api('GET', '/api/user/preferences'))?.preferences ?? {};
const dmRoom = (a, b) => `dm:${[a, b].sort().join('~')}`;

/** Appends one assistant message to a person's private chat with the assistant (read-modify-write right before saving). */
async function postDm(projectId, text, refs = []) {
  const key = `dhc.chat:${dmRoom(projectId, ASSISTANT)}`;
  if (DRY) { console.log(`\n[${key}]\n${text}`); return; }
  const msgs = (await prefs())[key]?.msgs ?? [];
  const lastAt = msgs.reduce((m, x) => (x.at > m ? x.at : m), '');
  const at = new Date(Math.max(Date.now(), lastAt ? Date.parse(lastAt) + 1 : 0)).toISOString();
  const message = { id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, by: ASSISTANT, text, at, refs };
  await api('PATCH', '/api/user/preferences', { [key]: { msgs: [...msgs, message].sort((a, b) => a.at.localeCompare(b.at)).slice(-300) } });
  log(`POST ${key} ${text.split('\n')[0].slice(0, 60)}`);
}

/** sessionId → {title, projectId}, and projectId → path, from the app database (read only). */
function openDb() {
  const db = new DatabaseSync(DB, { readOnly: true, timeout: 8000 });
  const projects = db.prepare('select project_id, project_path from projects').all();
  const byPath = new Map(projects.map((p) => [p.project_path.toLowerCase(), p.project_id]));
  return {
    session(id) {
      const row = db.prepare('select custom_name, project_path from sessions where session_id = ?').get(id);
      if (!row) return null;
      return { title: (row.custom_name || '未命名對話').replace(/\s+/g, ' ').trim().slice(0, 40), projectId: byPath.get(String(row.project_path).toLowerCase()) ?? null };
    },
    pathOf: (projectId) => projects.find((p) => p.project_id === projectId)?.project_path ?? null,
    /** Night-queue prompts that failed in the last day, with their session's title and project. */
    nightFailures(sinceIso) {
      return db.prepare("select session_id, failure_reason from night_queue_items where status = 'failed' and updated_at >= ?").all(sinceIso)
        .map((r) => ({ sessionId: r.session_id, reason: String(r.failure_reason ?? '').slice(0, 40), ...this.session(r.session_id) }));
    },
    close: () => db.close(),
  };
}

async function waitingList(db, state, now = Date.now()) {
  const data = (await api('GET', '/api/providers/sessions/running'))?.data ?? {};
  const seen = new Set();
  const out = [];
  for (const w of data.waiting ?? []) {
    const key = `${w.sessionId}:${w.requestId}`;
    seen.add(key);
    state.waiting[key] ??= { first: now, notified: false };
    const info = db.session(w.sessionId);
    out.push({ key, ...w, ...info, minutes: Math.round((now - state.waiting[key].first) / 60_000) });
  }
  for (const key of Object.keys(state.waiting)) if (!seen.has(key)) delete state.waiting[key];
  return out;
}

const CLAIM_WINDOW_MS = 48 * 3600_000;
/** Reads each person's replies to the morning "是你負責的嗎" question and records them in the calendar (idempotent, so it can rerun every 5 minutes). */
async function runClaims() {
  const open = readJson(STATE, {}).brief?.open ?? {};
  const now = Date.now();
  const live = Object.entries(open).filter(([, o]) => now - Date.parse(o.at) < CLAIM_WINDOW_MS);
  if (!live.length) return;
  const p = await prefs();
  const answersBy = {};
  for (const [projectId, o] of live) {
    const mine = (p[`dhc.chat:${dmRoom(projectId, ASSISTANT)}`]?.msgs ?? []).filter((m) => m.by === projectId && m.at > o.at).sort((a, b) => a.at.localeCompare(b.at));
    // A bare 是／好 only counts as the first reply after the question; lettered answers count any time in the window.
    const answers = {};
    mine.forEach((m, i) => Object.assign(answers, parseClaim(m.text, o.ids, i === 0)));
    if (Object.keys(answers).length) answersBy[projectId] = { answers };
  }
  if (!Object.keys(answersBy).length) return;
  const cal = readCalendar();
  if (!cal) return;
  const changed = [];
  for (const [projectId, { answers }] of Object.entries(answersBy)) {
    for (const it of applyClaims(cal, projectId, answers, new Date().toISOString())) changed.push(`${projectId.slice(0, 8)} ${it.log.at(-1).ans} ${it.id}`);
  }
  if (!changed.length) return;
  if (DRY) { console.log(`(dry) claims ${changed.join('; ')}`); return; }
  const bak = `${CALENDAR}.bak-${taipei().date.replace(/-/g, '')}-claim`;
  if (!fs.existsSync(bak)) fs.copyFileSync(CALENDAR, bak);
  fs.writeFileSync(CALENDAR, JSON.stringify(cal, null, 2));
  log(`claims ${changed.join('; ')}`);
}

async function runWaiting(state) {
  try { await runClaims(); } catch (e) { log(`FAIL claims ${e.message}`); }
  const db = openDb();
  try {
    for (const w of await waitingList(db, state)) {
      if (state.waiting[w.key].notified || w.minutes < WAIT_MIN || !w.projectId || fs.existsSync(path.join(ROOT, `nudge-off-${w.projectId}`))) continue;
      const tool = w.toolName ? `（${w.toolName}）` : '';
      await postDm(w.projectId, `你的對話「${w.title}」停在等你按允許${tool}，已等 ${w.minutes} 分鐘。\n→ 點下面打開按允許；常用的安全動作可以在核准設定改成自動允許。\n@@${w.title}`,
        [{ kind: 'session', id: w.sessionId, label: w.title }]);
      state.waiting[w.key].notified = true;
    }
  } finally { db.close(); }
}

// Repeated manual work: what a person typed in the last 7 days, by kind, counted in distinct days.
const REPEATS = [
  ['貼 SQL 錯誤或結果', /訊息 \d+，層級|Msg \d+|\(\d+ 個資料列受到影響\)|Invalid column|Invalid object/, '下次直接說「幫我跑這段 SELECT」，我用唯讀通道跑完把結果給你，不用來回貼'],
  ['網頁版面微調', /欄寬|欄位寬|太寬|太窄|置中|字體|顏色|欄名|版面/, '說「把這頁的版面規則記下來」，之後改頁面會先套用'],
  ['湊數對帳', /湊數|湊出|加總等於|哪幾筆/, '說「幫我湊數：目標 X」，貼上金額欄就好（工具\\湊數）'],
  ['讀信／待回信', /outlook|信箱|待回|回信|郵件/i, '說「每天早上幫我看待回信」，我設成巡查'],
  ['週報／月報同一套步驟', /週報|月報|月結|月會|簡報/, '說「把剛剛這段存成 SOP」，下次「帶我做」就好'],
  ['連 srv-src／srv-db2／srv-db', /\b(srv-src|srv-db2|srv-db)\b.*(連|查)|轉連|直連/, '直接問我要查什麼，我自己唯讀查正式機（避開 08:30–14:00、限筆數）'],
];

function typedMessages(projectPath, sinceMs) {
  const out = [];
  if (!projectPath || !fs.existsSync(PROJECTS)) return out;
  const want = projectPath.toLowerCase();
  for (const dir of fs.readdirSync(PROJECTS)) {
    const full = path.join(PROJECTS, dir);
    let files;
    try { files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(full, f);
      if (fs.statSync(file).mtimeMs < sinceMs) continue;
      let cwdOk = null;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (cwdOk === null && o.cwd) cwdOk = o.cwd.toLowerCase() === want;
        if (cwdOk === false) break;
        if (o.type !== 'user' || !o.timestamp || Date.parse(o.timestamp) < sinceMs) continue;
        const c = o.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
        if (text && !text.startsWith('<') && !/^\[Request interrupted/.test(text)) out.push({ at: o.timestamp, text });
      }
    }
  }
  return out;
}

function repeatSuggestion(projectPath, now = Date.now()) {
  const msgs = typedMessages(projectPath, now - 7 * 86400_000);
  let best = null;
  for (const [name, re, tip] of REPEATS) {
    const days = new Set(msgs.filter((m) => re.test(m.text)).map((m) => taipei(Date.parse(m.at)).date));
    if (days.size >= 3 && (!best || days.size > best.days)) best = { name, days: days.size, tip };
  }
  return best;
}

async function runBrief(state) {
  const today = taipei();
  if (!FORCE && (!isWeekday(today.day) || state.brief?.date === today.date)) { log(`brief skip ${today.date}`); return; }
  const calRead = readCalendar();
  const cal = calRead ?? { people: {}, items: [] };
  const asked = state.brief?.asked ?? {};
  const open = state.brief?.open ?? {};
  const p = await prefs();
  const db = openDb();
  try {
    const waiting = await waitingList(db, state);
    const patrols = readJson(path.join(ROOT, 'patrols.json'), { patrols: {} }).patrols;
    const dataNote = (() => {
      const data = patrols['builtin-data'];
      if (!data?.lastRunAt || Date.now() - Date.parse(data.lastRunAt) > 16 * 3600_000) return null;
      return /落後|失敗|異常|缺/.test(data.lastResult ?? '') ? `昨晚資料哨兵有異常：${String(data.lastResult).split('\n')[0].slice(0, 60)}` : null;
    })();
    let nightFailures = [];
    try { nightFailures = db.nightFailures(new Date(Date.now() - 86400_000).toISOString().replace('T', ' ').slice(0, 19)) /* sqlite CURRENT_TIMESTAMP form, UTC */; } catch (e) { log(`night-queue read failed: ${e.message}`); }
    let posted = 0;
    for (const projectId of Object.keys(cal.people).filter((id) => !process.env.NUDGE_ONLY || id === process.env.NUDGE_ONLY)) {
      if (fs.existsSync(path.join(ROOT, `nudge-off-${projectId}`))) continue;
      const lines = [];
      for (const item of cal.items) if (roleOf(item, projectId) === 'who' && ruleFires(item.rule, today)) lines.push(`${item.title}${item.prep ? ` → ${item.prep}` : ''}`);
      const todos = (p[`dhc.todos:${projectId}`]?.items ?? []).filter((t) => !t.done && t.due && t.due <= today.date);
      for (const t of todos.slice(0, 3)) lines.push(t.due === today.date ? `待辦今天到期：${t.text}` : `待辦已過期 ${Math.round((Date.parse(today.date) - Date.parse(t.due)) / 86400_000)} 天：${t.text}`);
      if (todos.length > 3) lines.push(`另有 ${todos.length - 3} 個到期待辦，在右緣待辦看`);
      const mine = waiting.filter((w) => w.projectId === projectId);
      const refs = [];
      for (const w of mine.slice(0, 2)) { lines.push(`對話「${w.title}」在等你按允許 @@${w.title}`); refs.push({ kind: 'session', id: w.sessionId, label: w.title }); }
      if (dataNote && projectId === '00000000-0000-0000-0000-000000000000') lines.push(dataNote);
      // MO's own folder is AI upkeep, not repeated desk work; skip it (it is also the biggest folder to scan).
      for (const n of nightFailures.filter((x) => x.projectId === projectId).slice(0, 2)) {
        lines.push(`昨晚夜間分流沒跑成：「${n.title}」${n.reason ? `（${n.reason}）` : ''} @@${n.title}`);
        refs.push({ kind: 'session', id: n.sessionId, label: n.title });
      }
      const rep = projectId === '00000000-0000-0000-0000-000000000000' ? null : repeatSuggestion(db.pathOf(projectId));
      if (rep) lines.push(`這 7 天有 ${rep.days} 天在做「${rep.name}」→ ${rep.tip}`);
      const asks = pickAsks(cal.items, projectId, asked, today.date);
      if (lines.length === 0 && asks.length === 0) continue;
      const text = lines.length ? [`早安，今天跟你有關的 ${lines.length} 件：`, ...lines.map((l, i) => `${i + 1}. ${l}`)] : ['早安'];
      if (asks.length) {
        text.push('', `想確認${asks.length > 1 ? '這幾件' : '這件'}是不是你負責的（之後只提醒你確認過的）：`, ...asks.map((it, i) => `${LETTERS[i]}. ${it.title}`),
          asks.length > 1 ? '回「是 A」「不是 B」或「都不是」就好；沒回最多再問一次。' : '回「是」或「不是」就好；沒回最多再問一次。');
      }
      await postDm(projectId, text.join('\n'), refs);
      for (const it of asks) { const k = `${projectId}|${it.id}`; asked[k] = { n: (asked[k]?.n ?? 0) + 1, last: today.date }; }
      if (asks.length) open[projectId] = { at: new Date().toISOString(), ids: asks.map((it) => it.id) };
      posted++;
    }
    if (calRead) {
      // Forget asks for items that were renamed or removed (not when the calendar failed to read, which would wipe every count).
      const ids = new Set(cal.items.map((it) => it.id).filter(Boolean));
      for (const k of Object.keys(asked)) if (!ids.has(k.split('|')[1])) delete asked[k];
    } else {
      // A broken calendar also has no people, so nobody would hear of it inside the loop; tell MO directly.
      await postDm('00000000-0000-0000-0000-000000000000', '工作日曆讀不到（work-calendar.json 格式壞了），今天早報沒列任何人的固定工作。→ 叫我修日曆，或從 .bak 還原。');
    }
    state.brief = { date: today.date, posted, asked, open };
    log(`brief ${today.date} posted=${posted}`);
  } finally { db.close(); }
}

module.exports = { ruleFires, taipei, repeatSuggestion, REPEATS, roleOf, pickAsks, parseClaim, applyClaims };

if (require.main === module) {
  (async () => {
    if (fs.existsSync(path.join(ROOT, 'nudge-off')) && !FORCE) return;
    const state = readJson(STATE, { waiting: {}, brief: null });
    state.waiting ??= {};
    if (!['waiting', 'brief'].includes(args[0])) { console.log('用法：node assistant-nudge.cjs waiting|brief [--dry] [--force]'); return; }
    try {
      if (args[0] === 'waiting') await runWaiting(state); else await runBrief(state);
    } finally {
      // Saved even when a run fails halfway, so reminders already sent are not sent again; only this mode's key is written back.
      if (!DRY) fs.writeFileSync(STATE, JSON.stringify({ ...readJson(STATE, {}), [args[0]]: state[args[0]] }, null, 1));
    }
  })().catch((e) => { log(`FAIL ${args[0]} ${e.message}`); console.error(e.message); process.exitCode = 1; });
}
