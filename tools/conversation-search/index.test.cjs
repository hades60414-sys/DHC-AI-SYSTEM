'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildIndex, openDb } = require('./index.cjs');
const { search } = require('./search.cjs');
const { recall, HEADER, MAX_CHARS } = require('./recall-hook.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-test-'));
const P = (...a) => path.join(root, ...a);
const CWD_A = 'D:\\TAS\\Claude Code專案\\同事C';
const CWD_B = 'D:\\TAS\\Claude Code專案\\同事A';
const FOLDER = 'D--TAS-Claude-Code-----';
const opts = { db: P('index.db'), projectsDir: P('projects'), cardsDir: P('cards'), assistantDir: P('assistant'), authDb: null };
const NOW = Date.parse('2026-10-24T00:00:00Z');

let n = 0;
const user = (cwd, sid, content, extra = {}) => JSON.stringify({ type: 'user', uuid: 'u' + ++n, sessionId: sid, cwd, timestamp: '2026-10-20T01:00:00Z', message: { role: 'user', content }, ...extra }) + '\n';
const asst = (cwd, sid, text) => JSON.stringify({ type: 'assistant', uuid: 'a' + ++n, sessionId: sid, cwd, timestamp: '2026-10-20T01:01:00Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '秘密思考保證金' }, { type: 'text', text }] } }) + '\n';

const fileA = P('projects', FOLDER, 'sessA.jsonl');
const fileB = P('projects', FOLDER, 'sessB.jsonl');

function write(file, s) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, s); }
function bumpMtime(file) { const t = new Date(Date.now() + 5000 + ++n * 1000); fs.utimesSync(file, t, t); }
const count = (where = '1') => { const db = openDb(opts.db, { readOnly: true }); const c = db.prepare(`SELECT count(*) AS c FROM docs WHERE ${where}`).get().c; db.close(); return c; };

test.before(() => {
  write(fileA,
    user(CWD_A, 'sessA', '期貨保證金報表要怎麼對帳') +
    asst(CWD_A, 'sessA', '保證金報表先比對母帳權益數，再看損益分配。') +
    user(CWD_A, 'sessA', [{ type: 'tool_result', tool_use_id: 't1', content: '工具輸出保證金不該被索引' }]) +
    user(CWD_A, 'sessA', 'meta 保證金不該被索引', { isMeta: true }) +
    user(CWD_A, 'sessA', '<task-notification>保證金通知不該被索引</task-notification>') +
    user(CWD_A, 'sessA', '追問損益<system-reminder>提醒保證金不該被索引</system-reminder>') +
    user(CWD_A, 'sessA', 'This session is being continued from a previous conversation. Summary: 保證金摘要') +
    JSON.stringify({ type: 'custom-title', customTitle: '保證金對帳', sessionId: 'sessA' }) + '\n');
  write(fileB, user(CWD_B, 'sessB', '同事A的保證金問題在別的資料夾') + asst(CWD_B, 'sessB', '好的，保證金另外看。'));
  write(P('projects', FOLDER, 'sessA', 'subagents', 'agent-1.jsonl'), asst(CWD_A, 'sessA', '子代理也查了保證金報表'));
  write(P('projects', FOLDER, 'memory', 'margin.md'), '# 保證金\n\n期貨保證金報表要先合併計量部再對帳，母帳權益數拆現金保證金。\n');
  write(P('cards', 'projects', 'fund.md'), '# 基金監控\n\nFundMonitor 頁面口徑。\n');
  write(P('assistant', 'abc.md'), '小助理記得使用者喜歡簡短回答。\n');
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('first build indexes only human/assistant prose and flags compaction summaries', () => {
  const s = buildIndex(opts);
  assert.strictEqual(s.compact, 1);
  assert.strictEqual(count("text LIKE '%不該被索引%'"), 0, 'tool_result, isMeta, task-notification, system-reminder excluded');
  assert.strictEqual(count("text LIKE '%秘密思考%'"), 0, 'thinking blocks excluded');
  assert.strictEqual(count("path LIKE '%sessA.jsonl' AND role IN ('user','assistant')"), 3);
  assert.strictEqual(count("kind='subagent'"), 1);
  assert.strictEqual(count("kind='card'"), 1);
  assert.strictEqual(count("cwd='assistant:abc'"), 1);
  const r = search({ db: opts.db, query: '保證金摘要', now: NOW });
  assert.strictEqual(r.results.length, 0, 'compaction summary excluded from default search');
});

test('rerun with no changes touches nothing; append indexes only new lines', () => {
  const before = count();
  const s = buildIndex(opts);
  assert.strictEqual(s.changed, 0);
  assert.strictEqual(count(), before);
  fs.appendFileSync(fileA, asst(CWD_A, 'sessA', '新增一行講沖銷部位') + '{"type":"user","partial');
  bumpMtime(fileA);
  buildIndex(opts);
  assert.strictEqual(count(), before + 1, 'appended line once; partial trailing line not indexed yet');
  fs.appendFileSync(fileA, '":1}\n' + user(CWD_A, 'sessA', '完成的一行沖銷部位'));
  bumpMtime(fileA);
  buildIndex(opts);
  assert.strictEqual(count("text LIKE '%沖銷部位%'"), 2, 'no duplicates after second append');
});

test('a shrunken file is fully re-indexed', () => {
  write(fileB, user(CWD_B, 'sessB', '重寫後只剩這行選擇權'));
  bumpMtime(fileB);
  buildIndex(opts);
  assert.strictEqual(count("session='sessB'"), 1);
  assert.strictEqual(count("session='sessB' AND text LIKE '%選擇權%'"), 1);
});

test('conversations are keyed by real cwd, not the colliding folder name', () => {
  const a = search({ db: opts.db, query: '選擇權', cwd: CWD_A, kind: 'convo', now: NOW });
  const b = search({ db: opts.db, query: '選擇權', cwd: CWD_B, kind: 'convo', now: NOW });
  assert.strictEqual(a.results.length, 0);
  assert.strictEqual(b.results.length, 1);
  assert.strictEqual(b.results[0].session, 'sessB');
  const memB = search({ db: opts.db, query: '保證金', cwd: CWD_B, kind: 'memory', now: NOW });
  assert.strictEqual(memB.results.length, 1, 'folder memory is shared by every cwd that maps to the folder');
});

test('trigram match for >=3 chars, LIKE fallback for 2-char terms, all terms required', () => {
  const tri = search({ db: opts.db, query: '保證金', cwd: CWD_A, kind: 'convo', now: NOW });
  assert.strictEqual(tri.results[0].session, 'sessA');
  assert.strictEqual(tri.results[0].title, '保證金對帳');
  assert.match(tri.results[0].hits[0].snippet, /【保證金】/);
  const two = search({ db: opts.db, query: '損益', kind: 'convo', now: NOW });
  assert.strictEqual(two.results.length, 1);
  assert.match(two.results[0].hits.map((h) => h.snippet).join(), /【損益】/);
  const mixed = search({ db: opts.db, query: '損益 母帳權益', kind: 'convo', now: NOW });
  assert.strictEqual(mixed.results[0].hits.length, 1, 'only the message holding both terms');
  assert.strictEqual(search({ db: opts.db, query: '損益 不存在的詞', now: NOW }).results.length, 0);
});

test('subagent hits rank below the main session for the same text', () => {
  const r = search({ db: opts.db, query: '保證金報表', kind: 'convo', now: NOW });
  const sa = r.results.find((g) => g.session === 'sessA');
  assert.ok(sa.hits.every((h) => h.id !== undefined));
  const db = openDb(opts.db, { readOnly: true });
  const subId = db.prepare("SELECT id FROM docs WHERE kind='subagent'").get().id;
  db.close();
  assert.notStrictEqual(sa.hits[0].id, subId, 'main-session message outranks the subagent copy');
});

test('recall hook is a no-op without the switch file and for short or slash prompts', () => {
  const sw = P('recall-on');
  const input = { prompt: '期貨保證金報表要怎麼合併計量部對帳', cwd: CWD_A, session_id: 'other' };
  assert.strictEqual(recall(input, { db: opts.db, switchFile: sw, now: NOW }), null);
  fs.writeFileSync(sw, '');
  assert.strictEqual(recall({ ...input, prompt: '保證金呢' }, { db: opts.db, switchFile: sw, now: NOW }), null);
  assert.strictEqual(recall({ ...input, prompt: '/compact 保證金報表合併計量部' }, { db: opts.db, switchFile: sw, now: NOW }), null);
});

test('recall hook injects only strong matches, capped, and never the current session', () => {
  const sw = P('recall-on');
  fs.writeFileSync(sw, '');
  const out = recall({ prompt: '期貨保證金報表要怎麼合併計量部對帳', cwd: CWD_A, session_id: 'sessA' }, { db: opts.db, switchFile: sw, now: NOW });
  assert.ok(out.startsWith(HEADER));
  assert.ok(out.length <= MAX_CHARS);
  assert.match(out, /margin\.md/);
  assert.doesNotMatch(out, /session=sessA/);
  const lines = out.split('\n').length - 1;
  assert.ok(lines >= 1 && lines <= 3);
  const weak = recall({ prompt: '幫我寫一首詩給同事慶生好嗎', cwd: CWD_A, session_id: 'x' }, { db: opts.db, switchFile: sw, now: NOW });
  assert.strictEqual(weak, null);
});
