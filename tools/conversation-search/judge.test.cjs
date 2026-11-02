'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { judge, tasks } = require('./judge.cjs');

const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-test-')), 'calls.jsonl');
const cli = (obj) => JSON.stringify({ type: 'result', is_error: false, result: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const fake = (out) => { const calls = []; const runner = async (a) => { calls.push(a); return typeof out === 'function' ? out(a) : out; }; runner.calls = calls; return runner; };
const route = (text, extra = {}) => ({ text, roomKind: 'dm', recent: [], hasAttachment: false, ...extra });
const base = { cache: false, logFile };

test('valid Haiku answer passes through with source haiku', async () => {
  const r = await judge('assistant-route', route('嗨'), { ...base, runner: fake({ code: 0, stdout: cli({ choice: 'quick', confidence: 0.9, reason: '打招呼' }) }) });
  assert.equal(r.choice, 'quick');
  assert.equal(r.source, 'haiku');
  assert.equal(r.confidence, 0.9);
});

test('JSON wrapped in a code fence still parses', async () => {
  const r = await judge('assistant-route', route('嗨'), { ...base, runner: fake({ code: 0, stdout: cli('```json\n{"choice":"local","confidence":0.8,"reason":"x"}\n```') }) });
  assert.equal(r.choice, 'local');
});

for (const [name, out, err] of [
  ['unknown choice', { code: 0, stdout: cli({ choice: 'sonnet', confidence: 0.9 }) }, /bad-choice/],
  ['non-JSON model text', { code: 0, stdout: cli('我覺得是 quick') }, /no-json/],
  ['CLI stdout not JSON', { code: 1, stdout: 'Error: auth' }, /cli-json/],
  ['CLI is_error', { code: 1, stdout: JSON.stringify({ is_error: true, result: 'rate limited' }) }, /cli-error/],
  ['timeout', { timedOut: true, stdout: '' }, /timeout/],
  ['low confidence', { code: 0, stdout: cli({ choice: 'quick', confidence: 0.4 }) }, /low-confidence/],
]) {
  test(`fallback to task default on ${name}`, async () => {
    const r = await judge('assistant-route', route('今天天氣'), { ...base, runner: fake(out) });
    assert.equal(r.choice, 'remote');
    assert.equal(r.source, 'default');
    assert.match(r.err, err);
  });
}

test('money rule lifts a quick answer to opus', async () => {
  const r = await judge('assistant-route', route('上週總損益多少'), { ...base, runner: fake({ code: 0, stdout: cli({ choice: 'quick', confidence: 0.95 }) }) });
  assert.equal(r.choice, 'opus');
  assert.equal(r.source, 'rule');
  assert.deepEqual(r.rules, ['money']);
});

test('money rule keeps handoff when Haiku picks it', async () => {
  const r = await judge('assistant-route', route('做一份部位月報簡報'), { ...base, runner: fake({ code: 0, stdout: cli({ choice: 'handoff', confidence: 0.9 }) }) });
  assert.equal(r.choice, 'handoff');
  assert.equal(r.source, 'haiku');
});

test('money rule still lifts the fallback when Haiku times out', async () => {
  const r = await judge('assistant-route', route('VaR 用了幾成'), { ...base, runner: fake({ timedOut: true, stdout: '' }) });
  assert.equal(r.choice, 'opus');
  assert.equal(r.source, 'rule');
});

test('memory-worth: save needs at least one item, extra is capped', async () => {
  const empty = await judge('memory-worth', { user: '我負責月底勾稽', assistant: '好' }, { ...base, runner: fake({ code: 0, stdout: cli({ choice: 'save', confidence: 0.9, items: [] }) }) });
  assert.equal(empty.choice, 'skip');
  assert.equal(empty.source, 'default');
  assert.deepEqual(empty.extra, { items: [] });
  const many = await judge('memory-worth', { user: '我負責月底勾稽', assistant: '好' }, { ...base, runner: fake({ code: 0, stdout: cli({ choice: 'save', confidence: 0.9, items: ['a', 'b', 'c', 'd', 'x'.repeat(300)] }) }) });
  assert.deepEqual(many.extra.items, ['a', 'b', 'c']);
});

test('memory-worth: a secret in the user text forces skip without calling Haiku', async () => {
  const runner = fake({ code: 0, stdout: cli({ choice: 'save', confidence: 0.9, items: ['x'] }) });
  const r = await judge('memory-worth', { user: '我的密碼是 abc', assistant: '收到' }, { ...base, runner });
  assert.equal(r.choice, 'skip');
  assert.equal(r.source, 'rule');
  assert.equal(runner.calls.length, 0);
});

test('cache: second identical call skips the runner, expiry calls again', async () => {
  const runner = fake({ code: 0, stdout: cli({ choice: 'local', confidence: 0.9 }) });
  const input = route('cache-test-' + process.pid + '-' + Date.now());
  const t0 = 1_000_000_000_000;
  const a = await judge('assistant-route', input, { logFile, runner, now: t0 });
  const b = await judge('assistant-route', input, { logFile, runner, now: t0 + 1000 });
  assert.equal(a.source, 'haiku');
  assert.equal(b.source, 'cache');
  assert.equal(b.choice, 'local');
  assert.equal(runner.calls.length, 1);
  const c = await judge('assistant-route', input, { logFile, runner, now: t0 + tasks['assistant-route'].cacheTtlMs + 1 });
  assert.equal(c.source, 'haiku');
  assert.equal(runner.calls.length, 2);
});

test('fallbacks are not cached', async () => {
  const input = route('nocache-' + process.pid + '-' + Date.now());
  const runner = fake({ timedOut: true, stdout: '' });
  await judge('assistant-route', input, { logFile, runner });
  await judge('assistant-route', input, { logFile, runner });
  assert.equal(runner.calls.length, 2);
});

test('call log holds length and hash, never the input text', async () => {
  const secret = '獨特字串-' + Date.now();
  await judge('assistant-route', route(secret), { ...base, runner: fake({ code: 0, stdout: cli({ choice: 'quick', confidence: 0.9 }) }) });
  const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  const last = rows.at(-1);
  assert.ok(!fs.readFileSync(logFile, 'utf8').includes(secret));
  assert.equal(last.task, 'assistant-route');
  assert.equal(last.ok, true);
  assert.equal(typeof last.inLen, 'number');
  assert.match(last.inHash, /^[0-9a-f]{16}$/);
});

test('prompt carries the input to the runner, system prompt comes from the task', async () => {
  const runner = fake({ code: 0, stdout: cli({ choice: 'quick', confidence: 0.9 }) });
  await judge('assistant-route', route('嗨', { recent: ['a', 'b', 'c', 'd'] }), { ...base, runner });
  const p = JSON.parse(runner.calls[0].prompt);
  assert.equal(p.text, '嗨');
  assert.deepEqual(p.recent, ['b', 'c', 'd']);
  assert.equal(runner.calls[0].system, tasks['assistant-route'].system);
  assert.equal(runner.calls[0].model, 'haiku');
});

test('an unsure Haiku answer gets one Sonnet opinion, which wins', async () => {
  const runner = fake((a) => ({ code: 0, stdout: cli(a.model === 'haiku' ? { choice: 'remote', confidence: 0.7 } : { choice: 'local', confidence: 0.9, reason: '讀 SOP' }) }));
  const r = await judge('assistant-route', route('哪一個代理視窗不能關？'), { ...base, runner });
  assert.deepEqual(runner.calls.map((c) => c.model), ['haiku', 'sonnet']);
  assert.equal(r.choice, 'local');
  assert.equal(r.source, 'sonnet');
});

test('a malformed Haiku answer is retried on Sonnet; a sure one is not', async () => {
  const bad = fake((a) => ({ code: 0, stdout: a.model === 'haiku' ? cli('嗯') : cli({ choice: 'quick', confidence: 0.9 }) }));
  assert.equal((await judge('assistant-route', route('嗨'), { ...base, runner: bad })).source, 'sonnet');
  const sure = fake({ code: 0, stdout: cli({ choice: 'quick', confidence: 0.9 }) });
  await judge('assistant-route', route('嗨'), { ...base, runner: sure });
  assert.deepEqual(sure.calls.map((c) => c.model), ['haiku']);
});

test('a Haiku timeout falls back without asking Sonnet, and Sonnet cannot lower a money floor', async () => {
  const slow = fake({ timedOut: true, stdout: '' });
  const r = await judge('assistant-route', route('今天天氣'), { ...base, runner: slow });
  assert.equal(slow.calls.length, 1);
  assert.equal(r.source, 'default');
  const low = fake((a) => ({ code: 0, stdout: cli(a.model === 'haiku' ? { choice: 'quick', confidence: 0.5 } : { choice: 'quick', confidence: 0.9 }) }));
  assert.equal((await judge('assistant-route', route('這月損益多少'), { ...base, runner: low })).choice, 'opus');
});

const first = (text, extra = {}) => ({ text, project: '同事E', hasAttachment: false, ...extra });

test('session-model: a sure Haiku "sonnet" for a question passes through', async () => {
  const runner = fake({ code: 0, stdout: cli({ choice: 'sonnet', confidence: 0.9, reason: '解釋' }) });
  const r = await judge('session-model', first('介紹一下去識別機制的原理'), { ...base, runner });
  assert.equal(r.choice, 'sonnet');
  assert.equal(r.source, 'haiku');
  assert.deepEqual(JSON.parse(runner.calls[0].prompt), { text: '介紹一下去識別機制的原理', project: '同事E', hasAttachment: false });
});

for (const [name, text, rule] of [
  ['money words', '為什麼庫存市值跟 BOOK 市值差這麼多', 'money'],
  ['a sum check', '幫我看一下第一張圖是不是後面兩張的加總', 'money'],
  ['a P&L lookup', '上週權證損益多少', 'money'],
  ['pasted SQL', 'select a, b from [db].[dbo].[T] where x = 1', 'code-change'],
  ['a PHP change', '幫改 php，寫一個權限例外', 'code-change'],
  ['a bug fix', '幫我修bug，按鈕按了沒反應', 'code-change'],
  ['a deploy', '把新版部署上去', 'code-change'],
]) {
  test(`session-model: ${name} is opus without asking Haiku`, async () => {
    const runner = fake({ code: 0, stdout: cli({ choice: 'sonnet', confidence: 0.99 }) });
    const r = await judge('session-model', first(text), { ...base, runner });
    assert.equal(r.choice, 'opus');
    assert.equal(r.source, 'rule');
    assert.ok(r.rules.includes(rule), r.rules.join(','));
    assert.equal(runner.calls.length, 0);
  });
}

test('session-model: any judge failure answers opus, and an unsure "sonnet" needs Sonnet to agree', async () => {
  for (const out of [{ timedOut: true, stdout: '' }, { code: 1, stdout: 'Error: auth' }, { code: 0, stdout: cli({ choice: 'haiku', confidence: 0.9 }) }]) {
    assert.equal((await judge('session-model', first('可轉債擔保比例是什麼'), { ...base, runner: fake(out) })).choice, 'opus');
  }
  const unsure = fake((a) => ({ code: 0, stdout: cli(a.model === 'haiku' ? { choice: 'sonnet', confidence: 0.65 } : { choice: 'opus', confidence: 0.8 }) }));
  const r = await judge('session-model', first('這是誰的機制'), { ...base, runner: unsure });
  assert.deepEqual(unsure.calls.map((c) => c.model), ['haiku', 'sonnet']);
  assert.equal(r.choice, 'opus');
});

const moment = (lastAssistant, extra = {}) => ({ lastUser: '好', lastAssistant, ...extra });

test('handoff-moment: a sure "later" passes through, the prompt keeps the last 1500 chars of the reply', async () => {
  const runner = fake({ code: 0, stdout: cli({ choice: 'later', confidence: 0.9, reason: '等回答' }) });
  const reply = '開頭'.repeat(1000) + '你要用 A 還是 B？';
  const r = await judge('handoff-moment', moment(reply), { ...base, runner });
  assert.equal(r.choice, 'later');
  assert.equal(r.source, 'haiku');
  assert.equal(runner.calls.length, 1);
  const p = JSON.parse(runner.calls[0].prompt);
  assert.equal(p.lastUser, '好');
  assert.equal(p.lastAssistant.length, 1500);
  assert.ok(p.lastAssistant.endsWith('你要用 A 還是 B？'));
  assert.equal(runner.calls[0].system, tasks['handoff-moment'].system);
});

test('handoff-moment: every failure and low confidence answer now, and Sonnet is never asked', async () => {
  for (const out of [{ timedOut: true, stdout: '' }, { code: 1, stdout: 'Error: auth' }, { code: 0, stdout: cli({ choice: 'maybe', confidence: 0.9 }) }, { code: 0, stdout: cli({ choice: 'later', confidence: 0.3 }) }]) {
    const runner = fake(out);
    const r = await judge('handoff-moment', moment('做完了'), { ...base, runner });
    assert.equal(r.choice, 'now');
    assert.equal(r.source, 'default');
    assert.equal(runner.calls.length, 1);
  }
});
