import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';

import assistantRouter from '@/modules/assistant/assistant.routes.js';
import { activeMemory, appendMemory, askedAgain, forgetMemory, redactSecrets, undoForget, mentionAt, parseAnswer, retryReason, RETRY_CHIP, parsePatrol, parseRoom, plainReason, readMemory, releasesText, resetAssistantStateForTests, setHandoffStarterForTests, systemPrompt, tickPatrols, TOOLS_NOTE, type HandoffStart } from '@/modules/assistant/assistant.service.js';
import { closeConnection, initializeDatabase, userDb, userPreferencesDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

// The routes start the patrol timer on import; tests drive patrols themselves.
process.env.ASSISTANT_PATROL_TIMER = '0';
// 10/31: no real Haiku memory extraction from tests.
process.env.ASSISTANT_NO_EXTRACT = '1';

const USER = 1;
const ME = 'proj-me';
const FAKE_CLAUDE = `
const fs = require('fs');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const env = { callId: process.env.ASSISTANT_CALL_ID, approved: process.env.ASSISTANT_APPROVED, root: process.env.ASSISTANT_ROOT };
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), prompt: input, cwd: process.cwd(), env }) + '\\n');
  // Stand-ins for what assistant-guard.cjs does: note a held action, or mark that the pressed one ran.
  if (env.callId && process.env.FAKE_CLAUDE_HOLD) {
    fs.mkdirSync(env.root + '/actions/pending', { recursive: true });
    fs.appendFileSync(env.root + '/actions/pending/' + env.callId + '.jsonl', process.env.FAKE_CLAUDE_HOLD + '\\n');
  }
  if (env.approved && process.env.FAKE_CLAUDE_RUN) {
    fs.mkdirSync(env.root + '/actions/ran', { recursive: true });
    fs.writeFileSync(env.root + '/actions/ran/' + env.approved, 'x');
  }
  // Stream-json: a tool call line right away, so a test can see the step while the answer is still pending.
  if (process.env.FAKE_CLAUDE_TOOL) {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: process.env.FAKE_CLAUDE_TOOL, input: { file_path: 'D:/x/a.md' } }] } }) + '\\n');
  }
  // 11/02: the tool result settles the step (ok, empty or error).
  if (process.env.FAKE_CLAUDE_RESULT) {
    const kind = process.env.FAKE_CLAUDE_RESULT;
    process.stdout.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: kind === 'error', content: kind === 'empty' ? 'No files found' : 'data' }] } }) + '\\n');
  }
  // 11/02: stand-in for the guard's edits/<call>.jsonl: back the file up, note it, change it.
  if (env.callId && process.env.FAKE_CLAUDE_EDIT) {
    const file = process.env.FAKE_CLAUDE_EDIT;
    const backup = env.root + '/bk-' + env.callId;
    fs.copyFileSync(file, backup);
    fs.mkdirSync(env.root + '/edits', { recursive: true });
    fs.appendFileSync(env.root + '/edits/' + env.callId + '.jsonl', JSON.stringify({ file, backup }) + '\\n');
    fs.writeFileSync(file, 'changed');
  }
  setTimeout(() => {
    if (process.env.FAKE_CLAUDE_FAIL) { process.stdout.write(JSON.stringify({ is_error: true, result: process.env.FAKE_CLAUDE_FAIL_TEXT || 'quota' })); return; }
    process.stdout.write(JSON.stringify({ result: process.env.FAKE_CLAUDE_ANSWER }));
  }, Number(process.env.FAKE_CLAUDE_DELAY || 0));
});
`;

type Env = { baseUrl: string; dir: string; log: string; memoryDir: string };

async function withServer(run: (env: Env) => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'assistant-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  userDb.createUser('tester', 'hash');
  const cli = path.join(dir, 'fake-claude.cjs');
  await writeFile(cli, FAKE_CLAUDE);
  const log = path.join(dir, 'calls.log');
  await writeFile(log, '');
  const memoryDir = path.join(dir, 'memory');
  const guard = path.join(dir, 'assistant-guard.cjs');
  await writeFile(guard, 'process.exit(0);');
  Object.assign(process.env, {
    CLAUDE_CLI_PATH: cli,
    FAKE_CLAUDE_LOG: log,
    FAKE_CLAUDE_ANSWER: JSON.stringify({ reply: '先講結論：可以。', remember: ['他喜歡先看結論'] }),
    FAKE_CLAUDE_DELAY: '0',
    ASSISTANT_MEMORY_DIR: memoryDir,
    ASSISTANT_ROOT: path.join(dir, 'root'),
    ASSISTANT_GUARD: guard,
  });
  delete process.env.FAKE_CLAUDE_FAIL;
  delete process.env.FAKE_CLAUDE_HOLD;
  delete process.env.FAKE_CLAUDE_RUN;
  resetAssistantStateForTests();

  const app = express()
    .use(express.json())
    .use((req, _res, next) => { (req as Request & { user: { id: number } }).user = { id: USER }; next(); })
    .use('/api/assistant', assistantRouter);
  app.use((error: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    res.status(status).json({ success: false, error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error instanceof AppError ? error.message : '' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assistant`, dir, log, memoryDir });
  } finally {
    server.close();
    closeConnection();
    process.env = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

type Msg = { id: string; by: string; text: string; at: string; refs: unknown[]; replyTo?: string };
const seedRoom = (roomId: string, msgs: Msg[]) => userPreferencesDb.savePreferences(USER, {
  [`dhc.chat:${roomId}`]: { msgs },
  'dhc.profiles': [{ id: 'pf1', name: '小明', projectId: ME }, { id: 'pf2', name: '阿華', projectId: 'proj-hua' }],
});
const roomMessages = (roomId: string) => ((userPreferencesDb.getPreferences(USER)[`dhc.chat:${roomId}`] as { msgs: Msg[] })?.msgs ?? []);
const msg = (id: string, by: string, text: string, at: string): Msg => ({ id, by, text, at, refs: [] });

const post = (baseUrl: string, body: unknown) => fetch(`${baseUrl}/reply`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
async function waitIdle(baseUrl: string, roomId: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const body = await (await fetch(`${baseUrl}/status?roomId=${encodeURIComponent(roomId)}`)).json() as { data: { running: string[] } };
    if (body.data.running.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('assistant never finished');
}
const calls = async (log: string) => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; prompt: string; cwd: string; env: { callId?: string; approved?: string } });

test('room ids follow the chat page and anything else is a 400', async () => {
  assert.deepEqual(parseRoom('lobby'), { kind: 'lobby', id: 'lobby' });
  assert.deepEqual(parseRoom('dm:proj-me~dhc-assistant'), { kind: 'dm', id: 'dm:proj-me~dhc-assistant', people: ['proj-me', 'dhc-assistant'], owner: 'proj-me' });
  assert.equal((parseRoom('dm:a~b') as { owner: string | null }).owner, null);
  for (const bad of ['', 'lobby2', 's:', 's:a/b', `s:${'x'.repeat(81)}`, 'b:../x', 'dm:a', 'dm:a~a', 'dm:a~b~c', 'x:1', 42]) {
    assert.equal(parseRoom(bad), null, String(bad));
  }
  await withServer(async ({ baseUrl, log }) => {
    for (const roomId of ['nope', 's:a b', 'dm:x']) {
      assert.equal((await post(baseUrl, { roomId, triggerAt: '2026-10-19T01:00:00.000Z', profileId: ME })).status, 400);
    }
    assert.equal((await fetch(`${baseUrl}/status?roomId=bad`)).status, 400);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: 'x', profileId: '../etc' })).status, 400);
    assert.equal((await calls(log)).length, 0);
  });
});

test('a missing safety guard posts an installation message without starting Claude', async () => {
  await withServer(async ({ baseUrl, dir, log }) => {
    process.env.ASSISTANT_GUARD = path.join(dir, 'missing-guard.cjs');
    const at = '2026-11-05T01:00:00.000Z';
    seedRoom('lobby', [msg('guard-missing', ME, '@團隊小助理 測試安全防護', at)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    assert.equal((await calls(log)).length, 0);
    assert.match(roomMessages('lobby').at(-1)!.text, /安全防護尚未安裝.*ASSISTANT_GUARD/);
  });
});

test('a mention in the lobby is answered once, written back into the room, and remembers only the caller', async () => {
  await withServer(async ({ baseUrl, log, memoryDir }) => {
    process.env.FAKE_CLAUDE_DELAY = '300';
    const at = '2026-10-19T01:00:00.000Z';
    seedRoom('lobby', [msg('m0', 'proj-hua', '早', '2026-10-19T00:59:00.000Z'), msg('m1', ME, '@團隊小助理 今天要對帳嗎', at)]);

    const first = await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME });
    assert.equal(first.status, 202);
    assert.deepEqual(((await first.json()) as { data: unknown }).data, { state: 'running' });
    const status = await (await fetch(`${baseUrl}/status?roomId=lobby`)).json() as { data: { running: string[] } };
    assert.deepEqual(status.data.running, [at]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 409, 'second call while running');

    await waitIdle(baseUrl, 'lobby');
    const again = await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME });
    assert.equal(again.status, 200);
    assert.equal((await calls(log)).length, 1, 'Claude ran exactly once');

    const replies = roomMessages('lobby').filter((m) => m.by === 'dhc-assistant');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, '先講結論：可以。');
    assert.equal(replies[0].replyTo, 'm1');
    assert.equal(roomMessages('lobby').length, 3, 'the earlier messages are kept');

    const [call] = await calls(log);
    assert.ok(call.prompt.includes('阿華：早') && call.prompt.includes('小明：@團隊小助理 今天要對帳嗎'), 'names come from dhc.profiles');
    assert.ok(call.prompt.includes('叫你的是 小明'), 'the caller is named so only their habits apply');
    for (const flag of ['--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config']) assert.ok(call.args.includes(flag), flag);
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'sonnet', 'the assistant itself runs on Sonnet');
    assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.ok(call.args[call.args.indexOf('--settings') + 1].includes('assistant-guard.cjs'), 'every tool call goes through the guard');
    assert.ok(call.args[call.args.indexOf('--disallowedTools') + 1].includes('AskUserQuestion'), 'nobody is there to answer a question');
    assert.ok((await readFile(path.join(memoryDir, `${ME}.md`), 'utf8')).includes('他喜歡先看結論'), 'the caller habit is kept under the caller');
    await assert.rejects(readFile(path.join(memoryDir, 'proj-hua.md')), 'nothing written for someone else in the room');
  });
});

test('a message without the mention is not answered outside the private chat', async () => {
  await withServer(async ({ baseUrl, log }) => {
    const at = '2026-10-19T02:00:00.000Z';
    seedRoom('lobby', [msg('m1', ME, '大家好', at)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 400);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: '2026-10-19T09:00:00.000Z', profileId: ME })).status, 404);
    assert.equal((await calls(log)).length, 0);
  });
});

test('the private chat with the assistant reads and writes only its owner\'s memory', async () => {
  await withServer(async ({ baseUrl, log, memoryDir }) => {
    const room = 'dm:proj-me~dhc-assistant';
    await appendMemory(ME, ['在團隊做對帳']);
    await appendMemory('proj-hua', ['阿華的祕密']);
    const at = '2026-10-19T03:00:00.000Z';
    seedRoom(room, [msg('d1', ME, '幫我記一下我喜歡先看結論', at)]);

    assert.equal((await post(baseUrl, { roomId: room, triggerAt: at, profileId: 'proj-hua' })).status, 403, 'someone else cannot ask in my chat');
    assert.equal((await post(baseUrl, { roomId: room, triggerAt: at, profileId: ME })).status, 202, 'no mention needed here');
    await waitIdle(baseUrl, room);

    const [call] = await calls(log);
    assert.ok(call.prompt.includes('在團隊做對帳'), 'owner memory is in the prompt');
    assert.ok(!call.prompt.includes('阿華的祕密'), 'no one else\'s memory');
    const memory = await readMemory(ME);
    assert.match(memory, /在團隊做對帳\n- \d{4}-\d{2}-\d{2} 他喜歡先看結論\n$/);
    assert.equal(await readFile(path.join(memoryDir, 'proj-hua.md'), 'utf8').then((text) => text.includes('先看結論')), false);
    assert.equal(roomMessages(room).at(-1)?.by, 'dhc-assistant');
  });
});

test('a message from before the rename (@團隊小助手) still calls the assistant', async () => {
  await withServer(async ({ baseUrl, log }) => {
    const at = '2026-10-19T03:00:00.000Z';
    seedRoom('lobby', [msg('m1', ME, '@團隊小助手 今天要對帳嗎', at)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202);
    await waitIdle(baseUrl, 'lobby');
    assert.equal((await calls(log)).length, 1);
    assert.equal(roomMessages('lobby').filter((m) => m.by === 'dhc-assistant' && m.replyTo === 'm1').length, 1);
  });
});

test('a room between two people may call the assistant and only the caller is remembered', async () => {
  await withServer(async ({ baseUrl, memoryDir }) => {
    const room = 'dm:proj-hua~proj-me';
    const at = '2026-10-19T04:00:00.000Z';
    seedRoom(room, [msg('h1', ME, '@團隊小助理 幫看一下', at)]);
    assert.equal((await post(baseUrl, { roomId: room, triggerAt: at, profileId: ME })).status, 202);
    await waitIdle(baseUrl, room);
    assert.equal(roomMessages(room).at(-1)?.replyTo, 'h1');
    assert.ok((await readFile(path.join(memoryDir, `${ME}.md`), 'utf8')).includes('他喜歡先看結論'));
    await assert.rejects(readFile(path.join(memoryDir, 'proj-hua.md')));
  });
});

test('an agreed handoff opens one Opus conversation and links it in the room', async () => {
  await withServer(async ({ baseUrl }) => {
    const started: HandoffStart[] = [];
    setHandoffStarterForTests(async (input) => { started.push(input); return 'sess-opus-1'; });
    try {
      process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({
        reply: '已開好，點下面的對話進去看',
        handoff: { title: '重寫對帳腳本', prompt: '背景：對帳腳本要重寫。目標：……完成條件：測試全過。' },
      });
      const at = '2026-10-19T07:00:00.000Z';
      seedRoom('lobby', [msg('h1', ME, '@團隊小助理 好，幫我開', at)]);
      assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202);
      await waitIdle(baseUrl, 'lobby');
      assert.equal(started.length, 1, 'exactly one conversation');
      assert.equal(started[0].prompt, '背景：對帳腳本要重寫。目標：……完成條件：測試全過。');
      assert.equal(started[0].userId, USER);
      const reply = roomMessages('lobby').at(-1)!;
      assert.equal(reply.by, 'dhc-assistant');
      assert.equal(reply.text, '已開好，點下面的對話進去看\n@@重寫對帳腳本');
      assert.deepEqual(reply.refs, [{ kind: 'session', id: 'sess-opus-1', label: '重寫對帳腳本' }], 'a chip that opens the new conversation');
    } finally {
      setHandoffStarterForTests(null);
    }
  });
});

test('a reply without handoff opens nothing', async () => {
  await withServer(async ({ baseUrl }) => {
    let opened = 0;
    setHandoffStarterForTests(async () => { opened += 1; return 'x'; });
    try {
      const at = '2026-10-19T07:30:00.000Z';
      seedRoom('lobby', [msg('h2', ME, '@團隊小助理 這個要開 Opus 嗎', at)]);
      await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME });
      await waitIdle(baseUrl, 'lobby');
      assert.equal(opened, 0);
      assert.deepEqual(roomMessages('lobby').at(-1)!.refs, []);
    } finally {
      setHandoffStarterForTests(null);
    }
  });
});

test('a failed run leaves a plain note in the room, without stack or ids', async () => {
  await withServer(async ({ baseUrl }) => {
    process.env.FAKE_CLAUDE_FAIL = '1';
    const at = '2026-10-19T05:00:00.000Z';
    seedRoom('lobby', [msg('f1', ME, '@團隊小助理 在嗎', at)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202);
    await waitIdle(baseUrl, 'lobby');
    const note = roomMessages('lobby').at(-1)!;
    assert.equal(note.by, 'dhc-assistant');
    assert.equal(note.replyTo, 'f1');
    assert.match(note.text, /^這次沒回成：/);
    assert.doesNotMatch(note.text, /Error|at |[0-9a-f]{8}-[0-9a-f]{4}/);
    assert.equal((note as Msg & { failed?: boolean }).failed, true, 'marked failed, so the page can offer 重試');
  });
});

test('more than three at once is refused with 429', async () => {
  await withServer(async ({ baseUrl }) => {
    process.env.FAKE_CLAUDE_DELAY = '400';
    const msgs = [0, 1, 2, 3].map((i) => msg(`c${i}`, ME, `@團隊小助理 第${i}題`, `2026-10-19T06:00:0${i}.000Z`));
    seedRoom('lobby', msgs);
    const statuses = [];
    for (const m of msgs) statuses.push((await post(baseUrl, { roomId: 'lobby', triggerAt: m.at, profileId: ME })).status);
    assert.deepEqual(statuses, [202, 202, 202, 429]);
    await waitIdle(baseUrl, 'lobby');
  });
});

test('answers are read from JSON, fenced JSON, or plain text; remember is capped', () => {
  assert.deepEqual(parseAnswer('{"reply":"好"}'), { reply: '好', remember: [], handoff: null, patrol: null, patrolOps: [], quiet: false, next: [], forget: [], teamRemember: [], teamForget: [], parsed: true });
  assert.deepEqual(parseAnswer('```json\n{"reply":"好","remember":["a"]}\n```'), { reply: '好', remember: ['a'], handoff: null, patrol: null, patrolOps: [], quiet: false, next: [], forget: [], teamRemember: [], teamForget: [], parsed: true });
  assert.deepEqual(parseAnswer('就是這樣'), { reply: '就是這樣', remember: [], handoff: null, patrol: null, patrolOps: [], quiet: false, next: [], forget: [], teamRemember: [], teamForget: [], parsed: false });
  const many = parseAnswer(JSON.stringify({ reply: 'x', remember: ['長'.repeat(300), 1, '', 'b', 'c', 'd', 'e', 'f'] })).remember;
  assert.equal(many.length, 5);
  assert.equal(Array.from(many[0]).length, 200);
});

test('memory skips a line it already has, even with extra 「（某人說）」 tags', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'assistant-mem-'));
  const saved = process.env.ASSISTANT_MEMORY_DIR;
  const savedRoot = process.env.ASSISTANT_ROOT;
  process.env.ASSISTANT_MEMORY_DIR = dir;
  process.env.ASSISTANT_ROOT = dir; // no jev-on here: never reach the live judge
  try {
    await appendMemory(ME, ['月報用 簡報系統（同事C說）']);
    await appendMemory(ME, ['月報用 簡報系統（同事C說）（某位同事說）', '新的一條']);
    const lines = (await readMemory(ME)).split(/\r?\n/).filter(Boolean);
    assert.equal(lines.filter((l) => l.includes('簡報系統')).length, 1);
    assert.ok(lines.some((l) => l.includes('新的一條')));
  } finally {
    if (saved === undefined) delete process.env.ASSISTANT_MEMORY_DIR; else process.env.ASSISTANT_MEMORY_DIR = saved;
    if (savedRoot === undefined) delete process.env.ASSISTANT_ROOT; else process.env.ASSISTANT_ROOT = savedRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test('memory stays under 20KB by dropping the oldest lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'assistant-mem-'));
  const saved = process.env.ASSISTANT_MEMORY_DIR;
  const savedRoot = process.env.ASSISTANT_ROOT;
  process.env.ASSISTANT_MEMORY_DIR = dir;
  process.env.ASSISTANT_ROOT = dir; // no jev-on here: never reach the live judge
  try {
    for (let i = 0; i < 60; i += 1) await appendMemory(ME, [`第${i}條 ${'記'.repeat(150)}`]);
    const text = await readMemory(ME);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 20 * 1024);
    assert.ok(text.includes('第59條') && !text.includes('第0條 '));
  } finally {
    if (saved === undefined) delete process.env.ASSISTANT_MEMORY_DIR; else process.env.ASSISTANT_MEMORY_DIR = saved;
    if (savedRoot === undefined) delete process.env.ASSISTANT_ROOT; else process.env.ASSISTANT_ROOT = savedRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- 10/20 action cards and restart safety ----
type Card = { id: string; messageId: string; tool: string; summary: string; detail: string; status: string; by?: string };
type CardMsg = Msg & { failed?: boolean };
let cardsUrl = "";
const roomCards = async (roomId = "lobby") => ((await (await fetch(`${cardsUrl}/cards?roomId=${encodeURIComponent(roomId)}`)).json()) as { data: { cards: Card[] } }).data.cards;
const cardMessages = (roomId: string) => roomMessages(roomId) as CardMsg[];
const press = (baseUrl: string, id: string, body: unknown) => fetch(`${baseUrl}/actions/${encodeURIComponent(id)}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const HELD = JSON.stringify({ tool: 'Bash', input: { command: 'rm old.txt', description: 'x' }, reason: '指令「rm old.txt」', key: 'a'.repeat(64) });

async function askWithCard(baseUrl: string, roomId = 'lobby'): Promise<Card> {
  const at = '2026-10-20T01:00:00.000Z';
  seedRoom(roomId, [msg('m1', ME, '@團隊小助理 刪掉 old.txt', at)]);
  process.env.FAKE_CLAUDE_HOLD = HELD;
  process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '要刪 old.txt，按下面的卡片執行。' });
  assert.equal((await post(baseUrl, { roomId, triggerAt: at, profileId: ME })).status, 202);
  await waitIdle(baseUrl, roomId);
  delete process.env.FAKE_CLAUDE_HOLD;
  cardsUrl = baseUrl;
  const reply = cardMessages(roomId).find((m) => m.by === 'dhc-assistant')!;
  const cards = await roomCards(roomId);
  assert.equal(cards.length, 1, 'the held action is one card');
  assert.equal(cards[0].messageId, reply.id, 'shown under the reply');
  assert.equal((reply as Record<string, unknown>).actions, undefined, 'not stored in the room, where old pages would drop it');
  return cards[0];
}

test('a held action becomes one pending card under the reply, with the call id handed to the guard', async () => {
  await withServer(async ({ baseUrl, log }) => {
    const card = await askWithCard(baseUrl);
    assert.equal(card.status, 'pending');
    assert.equal(card.summary, '執行指令：rm old.txt');
    assert.ok(card.detail.includes('rm old.txt'));
    const [call] = await calls(log);
    assert.match(call.env.callId ?? '', /^[\w-]+$/, 'the guard learns which call it is holding for');
    assert.equal(call.env.approved, '', 'nothing is pre-approved on an ordinary answer');
    assert.ok(!call.prompt.includes('已經放行'), 'typing the confirm word no longer releases a turn');
  });
});

test('pressing 執行 runs exactly that card once, marks it done and posts the result', async () => {
  await withServer(async ({ baseUrl, log }) => {
    const card = await askWithCard(baseUrl);
    process.env.FAKE_CLAUDE_RUN = '1';
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '已刪除 old.txt。' });
    const pressed = await press(baseUrl, card.id, { decision: 'approve', profileId: 'proj-hua' });
    assert.equal(pressed.status, 202);
    await waitIdle(baseUrl, 'lobby');
    const exec = (await calls(log))[1];
    assert.equal(exec.env.approved, 'a'.repeat(64), 'the guard is told the one action it may release');
    assert.equal(exec.env.callId, '', 'a card run makes no new cards');
    assert.ok(exec.prompt.includes('rm old.txt') && exec.prompt.includes('阿華'));
    const after = cardMessages('lobby');
    assert.equal((await roomCards())[0].status, 'done');
    assert.equal((await roomCards())[0].by, '阿華');
    assert.ok(after.some((m) => m.text.includes('確認卡（阿華 按了執行）：已刪除 old.txt。')));
    assert.equal((await press(baseUrl, card.id, { decision: 'approve', profileId: ME })).status, 409, 'a card runs once');
    assert.equal((await calls(log)).length, 2);
  });
});

test('a card the model did not actually run is reported as not done', async () => {
  await withServer(async ({ baseUrl }) => {
    const card = await askWithCard(baseUrl);
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '已刪除。' });
    assert.equal((await press(baseUrl, card.id, { decision: 'approve', profileId: ME })).status, 202);
    await waitIdle(baseUrl, 'lobby');
    const after = cardMessages('lobby');
    assert.equal((await roomCards())[0].status, 'failed');
    assert.ok(after.some((m) => m.failed && m.text.includes('沒有執行')), 'a claim without the guard mark is not trusted');
  });
});

test('取消 marks the card without running anything; bad presses are refused', async () => {
  await withServer(async ({ baseUrl, log }) => {
    const card = await askWithCard(baseUrl);
    assert.equal((await press(baseUrl, card.id, { decision: 'maybe', profileId: ME })).status, 400);
    assert.equal((await press(baseUrl, 'nope', { decision: 'approve', profileId: ME })).status, 404);
    assert.equal((await press(baseUrl, card.id, { decision: 'reject', profileId: ME })).status, 200);
    assert.equal((await roomCards())[0].status, 'rejected');
    assert.equal((await press(baseUrl, card.id, { decision: 'approve', profileId: ME })).status, 409);
    assert.equal((await calls(log)).length, 1, 'nothing ran after the first answer');
  });
});

test('in a private chat with the assistant only its owner may press', async () => {
  await withServer(async ({ baseUrl }) => {
    const card = await askWithCard(baseUrl, `dm:${ME}~dhc-assistant`);
    assert.equal((await press(baseUrl, card.id, { decision: 'approve', profileId: 'proj-hua' })).status, 403);
  });
});

test('a reply cut off by a restart leaves a note and can be asked again', async () => {
  await withServer(async ({ baseUrl, dir }) => {
    const at = '2026-10-20T02:00:00.000Z';
    seedRoom('lobby', [msg('m1', ME, '@團隊小助理 查一下', at)]);
    await writeFile(path.join(dir, 'root', 'calls.json'), JSON.stringify({ [`lobby|${at}`]: { state: 'running', startedAt: 1, roomId: 'lobby', triggerAt: at, userId: USER } }))
      .catch(async () => {
        await import('node:fs/promises').then((fs) => fs.mkdir(path.join(dir, 'root'), { recursive: true }));
        await writeFile(path.join(dir, 'root', 'calls.json'), JSON.stringify({ [`lobby|${at}`]: { state: 'running', startedAt: 1, roomId: 'lobby', triggerAt: at, userId: USER } }));
      });
    resetAssistantStateForTests();
    await waitIdle(baseUrl, 'lobby');
    const note = cardMessages('lobby').find((m) => m.by === 'dhc-assistant')!;
    assert.ok(note.failed && note.text.includes('重新啟動'), 'the room is told, not left waiting');
    assert.equal(JSON.parse(await readFile(path.join(dir, 'root', 'calls.json'), 'utf8')) && Object.keys(JSON.parse(await readFile(path.join(dir, 'root', 'calls.json'), 'utf8'))).length, 0);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202, 'a failed answer may be asked again');
    await waitIdle(baseUrl, 'lobby');
    assert.equal(cardMessages('lobby').filter((m) => m.by === 'dhc-assistant' && !m.failed).length, 1);
  });
});

test('a failed answer can be retried on the same message', async () => {
  await withServer(async ({ baseUrl }) => {
    const at = '2026-10-20T03:00:00.000Z';
    seedRoom('lobby', [msg('m1', ME, '@團隊小助理 在嗎', at)]);
    process.env.FAKE_CLAUDE_FAIL = '1';
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202);
    await waitIdle(baseUrl, 'lobby');
    delete process.env.FAKE_CLAUDE_FAIL;
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202);
    await waitIdle(baseUrl, 'lobby');
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 200, 'answered now');
  });
});

// ---- 10/20 P2 patrols ----
const patrolsOnDisk = async (dir: string) => JSON.parse(await readFile(path.join(dir, 'root', 'patrols.json'), 'utf8')) as {
  patrols: Record<string, { id: string; status: string; roomId: string; lastSlot?: string; failures: number; title: string }>;
  budget: { day: string; count: number };
};
const DRAFT = { title: '每日部位檢查', prompt: '查部位表今天有沒有進來', times: ['08:30', '25:00', 'x'], days: [1, 2, 3, 4, 5, 9] };
// 2026-10-21 is a Wednesday; 08:30 Taipei = 00:30Z.
const WED_0835 = Date.parse('2026-10-21T00:35:00.000Z');

async function draftOne(baseUrl: string, dir: string): Promise<{ cardId: string; patrolId: string }> {
  process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '好，我擬了一個巡查，按建立就生效。', patrol: DRAFT });
  const at = '2026-10-20T01:00:00.000Z';
  seedRoom('lobby', [msg('m1', ME, '@團隊小助理 每個平日早上 8:30 幫我看部位表', at)]);
  assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202);
  await waitIdle(baseUrl, 'lobby');
  const cards = ((await (await fetch(`${baseUrl}/cards?roomId=lobby`)).json()) as { data: { cards: Array<{ id: string; kind: string; summary: string; detail: string; status: string }> } }).data.cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, 'patrol');
  assert.equal(cards[0].summary, '建立巡查「每日部位檢查」：平日 08:30（台北時間）');
  assert.equal(cards[0].detail, DRAFT.prompt);
  const [patrol] = Object.values((await patrolsOnDisk(dir)).patrols);
  assert.equal(patrol.status, 'draft');
  return { cardId: cards[0].id, patrolId: patrol.id };
}
const pressPatrol = (baseUrl: string, id: string, decision: string) => fetch(`${baseUrl}/actions/${id}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, profileId: ME }),
});

test('a patrol draft is parsed strictly: bad times and days dropped, no title or time means none', () => {
  assert.deepEqual(parsePatrol(DRAFT), { title: '每日部位檢查', prompt: '查部位表今天有沒有進來', times: ['08:30'], days: [1, 2, 3, 4, 5] });
  assert.deepEqual(parsePatrol({ title: 'a', prompt: 'b', times: ['07:00'] })?.days, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(parsePatrol({ title: 'a', prompt: 'b', times: ['24:00'] }), null);
  assert.equal(parsePatrol({ prompt: 'b', times: ['07:00'] }), null);
  assert.equal(parsePatrol('x'), null);
});

test('a drafted patrol only runs after 建立 is pressed, once per slot, and a quiet result is not posted', async () => {
  await withServer(async ({ baseUrl, dir, log }) => {
    const { cardId, patrolId } = await draftOne(baseUrl, dir);
    assert.equal(tickPatrols(WED_0835).length, 0, 'a draft never runs');
    const pressed = await pressPatrol(baseUrl, cardId, 'approve');
    assert.equal(pressed.status, 200);
    assert.equal(((await pressed.json()) as { data: { state: string } }).data.state, 'done');
    assert.equal((await patrolsOnDisk(dir)).patrols[patrolId].status, 'active');
    assert.equal((await calls(log)).length, 1, 'pressing 建立 runs nothing');

    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '都正常', quiet: true });
    const before = roomMessages('lobby').length;
    assert.equal(tickPatrols(Date.parse('2026-10-21T00:29:00.000Z')).length, 0, 'not before its time');
    await Promise.all(tickPatrols(WED_0835));
    assert.equal(tickPatrols(WED_0835 + 60_000).length, 0, 'the same slot runs once');
    assert.equal(tickPatrols(Date.parse('2026-10-21T01:05:00.000Z')).length, 0, 'over 30 minutes late is skipped');
    assert.equal(tickPatrols(Date.parse('2026-10-24T00:35:00.000Z')).length, 0, 'Saturday is not a weekday');
    assert.equal(roomMessages('lobby').length, before, 'quiet results stay out of the room');
    const patrolCall = (await calls(log))[1];
    assert.ok(patrolCall.prompt.includes('查部位表今天有沒有進來'));
    assert.ok(patrolCall.prompt.includes('只查不改'));
    assert.match(patrolCall.env.callId ?? '', /^[\w-]+$/, 'patrols run under the guard like any answer');

    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '部位表今天沒進來' });
    await Promise.all(tickPatrols(Date.parse('2026-10-22T00:31:00.000Z')));
    const last = roomMessages('lobby').at(-1)!;
    assert.equal(last.by, 'dhc-assistant');
    assert.equal(last.text, '【巡查】每日部位檢查\n部位表今天沒進來');
    assert.equal(last.replyTo, undefined);
  });
});

test('取消 on a patrol card deletes the draft; three failures in a row pause a patrol with a note', async () => {
  await withServer(async ({ baseUrl, dir }) => {
    const first = await draftOne(baseUrl, dir);
    assert.equal((await pressPatrol(baseUrl, first.cardId, 'reject')).status, 200);
    assert.equal((await patrolsOnDisk(dir)).patrols[first.patrolId].status, 'deleted');
    assert.equal(tickPatrols(WED_0835).length, 0);
  });
  await withServer(async ({ baseUrl, dir }) => {
    const { cardId, patrolId } = await draftOne(baseUrl, dir);
    await pressPatrol(baseUrl, cardId, 'approve');
    // 11/02: an answer that is not the JSON contract is a failure (never posted as is) and counts toward the pause.
    process.env.FAKE_CLAUDE_ANSWER = '部位表今天沒進來（忘了寫 JSON）';
    for (const day of ['21', '22', '23']) await Promise.all(tickPatrols(Date.parse(`2026-10-${day}T00:31:00.000Z`)));
    const stored = (await patrolsOnDisk(dir)).patrols[patrolId];
    assert.equal(stored.status, 'paused');
    assert.equal(stored.failures, 3);
    const notes = roomMessages('lobby').filter((message) => message.text.startsWith('【巡查】每日部位檢查'));
    assert.equal(notes.length, 3);
    assert.ok(notes.every((note) => !note.text.includes('忘了寫 JSON')), 'the unreadable answer itself is never posted');
    assert.ok(notes[0].text.includes('回覆格式不對'));
    assert.ok(notes[2].text.includes('已自動暫停'));
    assert.equal(tickPatrols(Date.parse('2026-10-26T00:31:00.000Z')).length, 0, 'a paused patrol does not run');
  });
});

test('11/02 patrol failures by cause: a crash is retried once; quota never counts and is told once a day', async () => {
  await withServer(async ({ baseUrl, dir }) => {
    const { cardId, patrolId } = await draftOne(baseUrl, dir);
    await pressPatrol(baseUrl, cardId, 'approve');
    process.env.ASSISTANT_PATROL_RETRY_MS = '0';
    process.env.FAKE_CLAUDE_FAIL = '1';
    process.env.FAKE_CLAUDE_FAIL_TEXT = 'boom';
    await Promise.all(tickPatrols(Date.parse('2026-10-21T00:31:00.000Z')));
    assert.equal((await patrolsOnDisk(dir)).patrols[patrolId].failures, 0, 'the first crash only schedules a retry');
    for (let i = 0; i < 60 && (await patrolsOnDisk(dir)).patrols[patrolId].failures === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await patrolsOnDisk(dir)).patrols[patrolId].failures, 1, 'the retry failed too, so it counts once');
    assert.equal(roomMessages('lobby').filter((message) => message.text.includes('這次沒回成') || message.text.includes('這次沒跑成')).length, 1);

    process.env.FAKE_CLAUDE_FAIL_TEXT = "You've hit your usage limit · resets 3pm";
    for (const day of ['22', '23', '26']) await Promise.all(tickPatrols(Date.parse(`2026-10-${day}T00:31:00.000Z`)));
    const stored = (await patrolsOnDisk(dir)).patrols[patrolId];
    assert.equal(stored.status, 'active', 'quota does not pause a patrol');
    assert.equal(stored.failures, 1);
    assert.equal(roomMessages('lobby').filter((message) => message.text.includes('不算巡查失敗')).length, 1, 'quota is told once a (real) day');
    await Promise.all(tickPatrols(Date.parse('2026-10-24T00:31:00.000Z') + 60_000));
  });
});

test('patrols can be paused, resumed and run now from chat, and the list is in the prompt', async () => {
  await withServer(async ({ baseUrl, dir, log }) => {
    const { cardId, patrolId } = await draftOne(baseUrl, dir);
    await pressPatrol(baseUrl, cardId, 'approve');
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '好', patrolOps: [{ id: patrolId, op: 'pause' }, { id: 'nope', op: 'pause' }] });
    const at = '2026-10-20T02:00:00.000Z';
    seedRoom('lobby', [...roomMessages('lobby'), msg('m2', ME, '@團隊小助理 先暫停部位檢查', at)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    assert.ok((await calls(log)).at(-1)!.prompt.includes(`${patrolId}｜每日部位檢查｜平日 08:30｜執行中｜lobby`));
    assert.equal((await patrolsOnDisk(dir)).patrols[patrolId].status, 'paused');
    const reply = roomMessages('lobby').at(-1)!.text;
    assert.ok(reply.includes('已暫停'));
    assert.ok(reply.includes('找不到可操作的巡查 nope'));
  });
});

test('patrols stop for the day after 30 runs', async () => {
  await withServer(async ({ baseUrl, dir }) => {
    const { cardId, patrolId } = await draftOne(baseUrl, dir);
    await pressPatrol(baseUrl, cardId, 'approve');
    const store = await patrolsOnDisk(dir);
    store.budget = { day: '2026-10-21', count: 30 };
    await writeFile(path.join(dir, 'root', 'patrols.json'), JSON.stringify(store));
    assert.equal(tickPatrols(WED_0835).length, 0);
    assert.equal((await patrolsOnDisk(dir)).patrols[patrolId].lastSlot, undefined);
  });
});

test('system prompt comes from the rules file only when it keeps the reply contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'assistant-prompt-'));
  const saved = process.env.ASSISTANT_ROOT;
  process.env.ASSISTANT_ROOT = root;
  try {
    const builtIn = systemPrompt();
    assert.ok(builtIn.includes('"reply"'));
    await writeFile(path.join(root, 'system-prompt.md'), 'broken', 'utf8');
    assert.equal(systemPrompt(), builtIn);
    const custom = `${'自訂規則。'.repeat(50)}\n只輸出 {"reply": "..."}`;
    await writeFile(path.join(root, 'system-prompt.md'), custom, 'utf8');
    assert.equal(systemPrompt(), custom.trim());
  } finally {
    if (saved === undefined) delete process.env.ASSISTANT_ROOT; else process.env.ASSISTANT_ROOT = saved;
    await rm(root, { recursive: true, force: true });
  }
});

test('two messages in a row get one reply, to the newer one, which sees both', async () => {
  await withServer(async ({ baseUrl, log }) => {
    const room = 'dm:proj-me~dhc-assistant';
    const first = msg('q1', ME, '我是PC2', '2026-10-21T04:01:50.000Z');
    const second = msg('q2', ME, '我要能使用102的outlook', '2026-10-21T04:02:01.000Z');
    process.env.FAKE_CLAUDE_DELAY = '400';
    seedRoom(room, [first]);
    assert.equal((await post(baseUrl, { roomId: room, triggerAt: first.at, profileId: ME })).status, 202);
    seedRoom(room, [first, second]);
    assert.equal((await post(baseUrl, { roomId: room, triggerAt: second.at, profileId: ME })).status, 202);
    await waitIdle(baseUrl, room);

    const replies = roomMessages(room).filter((item) => item.by === 'dhc-assistant');
    assert.deepEqual(replies.map((item) => item.replyTo), ['q2'], 'only the newer message is answered');
    const prompts = (await calls(log)).map((call) => call.prompt);
    assert.ok(prompts.some((prompt) => prompt.includes('我是PC2') && prompt.includes('102的outlook')), 'the answer saw both messages');
  });
});

test('asking to pair in a private chat starts the pairing guide; saying it is paired does not', async () => {
  await withServer(async ({ baseUrl, log }) => {
    const room = 'dm:proj-me~dhc-assistant';
    const done = msg('p0', ME, '我已配對好了', '2026-10-21T04:00:00.000Z');
    seedRoom(room, [done]);
    await post(baseUrl, { roomId: room, triggerAt: done.at, profileId: ME });
    await waitIdle(baseUrl, room);
    const ask = msg('p1', ME, '我也跟PC1配對', '2026-10-21T04:01:00.000Z');
    seedRoom(room, [done, ask]);
    await post(baseUrl, { roomId: room, triggerAt: ask.at, profileId: ME });
    await waitIdle(baseUrl, room);

    const [before, after] = (await calls(log)).map((call) => call.prompt);
    assert.ok(!before.includes('你正在帶人走 SOP'), 'no guide for "already paired"');
    assert.ok(after.includes('「同事精簡版配對」'), 'the pairing SOP is in the prompt');
  });
});

test('while answering, the room sees what it is doing; 停止 ends it with a note and no reply', async () => {
  await withServer(async ({ baseUrl }) => {
    process.env.FAKE_CLAUDE_TOOL = 'mcp__usere__db56_cmd';
    process.env.FAKE_CLAUDE_DELAY = '20000';
    const at = '2026-10-21T07:00:00.000Z';
    seedRoom('lobby', [msg('s1', ME, '@團隊小助理 查同事E電腦', at)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202);
    let steps: Record<string, string> = {};
    for (let i = 0; i < 100 && !steps[at]; i += 1) {
      steps = ((await (await fetch(`${baseUrl}/status?roomId=lobby`)).json()) as { data: { steps: Record<string, string> } }).data.steps;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(steps[at], '在 usere 跑指令');

    const stop = await fetch(`${baseUrl}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId: 'lobby', profileId: ME }) });
    assert.deepEqual(((await stop.json()) as { data: unknown }).data, { stopped: 1 });
    await waitIdle(baseUrl, 'lobby');
    const replies = roomMessages('lobby').filter((m) => m.by === 'dhc-assistant');
    assert.deepEqual(replies.map((m) => m.text), ['■ 已停止。做到一半的動作不會自動復原。']);
  });
});

test('只回我: asked in your private chat about another room, it reads that room and answers only in private', async () => {
  await withServer(async ({ baseUrl, log }) => {
    const dm = 'dm:proj-me~dhc-assistant';
    userPreferencesDb.savePreferences(USER, { 'dhc.chat:lobby': { msgs: [msg('l1', 'proj-hua', '今天 break 有 3 筆', '2026-10-21T08:00:00.000Z')] } });
    const ask = msg('a1', ME, '（在「動態」悄悄問）break 是哪幾筆', '2026-10-21T08:01:00.000Z');
    seedRoom(dm, [ask]);
    const res = await fetch(`${baseUrl}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId: dm, triggerAt: ask.at, profileId: ME, aboutRoom: 'lobby' }) });
    assert.equal(res.status, 202);
    await waitIdle(baseUrl, dm);
    const [call] = await calls(log);
    assert.ok(call.prompt.includes('只回我') && call.prompt.includes('今天 break 有 3 筆'), 'the other room is in the prompt');
    assert.equal(roomMessages(dm).filter((m) => m.by === 'dhc-assistant').length, 1, 'answered in the private chat');
    assert.equal(roomMessages('lobby').filter((m) => m.by === 'dhc-assistant').length, 0, 'nothing posted in the lobby');

    const other = msg('a2', ME, '偷看', '2026-10-21T08:02:00.000Z');
    seedRoom(dm, [ask, other]);
    const bad = await fetch(`${baseUrl}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId: dm, triggerAt: other.at, profileId: ME, aboutRoom: 'dm:proj-hua~proj-x' }) });
    assert.equal(bad.status, 400, 'someone else\'s private chat is refused');
  });
});

test('team memory is shared into every prompt and can be added to and forgotten from chat', async () => {
  await withServer(async ({ baseUrl, log, memoryDir }) => {
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '✓ 已記進團隊記憶', teamRemember: ['DB1 週六維護不要連'] });
    const first = msg('t1', ME, '@團隊小助理 大家都要知道 DB1 週六維護', '2026-10-21T08:10:00.000Z');
    seedRoom('lobby', [first]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: first.at, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    const team = await readFile(path.join(memoryDir, '_team.md'), 'utf8');
    assert.ok(team.includes('DB1 週六維護不要連（小明說）'), 'who said it is kept');

    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '✓', teamForget: ['週六維護不要連'] });
    const dm = 'dm:proj-hua~dhc-assistant';
    const second = msg('t2', 'proj-hua', '團隊記憶有什麼，刪掉維護那條', '2026-10-21T08:11:00.000Z');
    seedRoom(dm, [second]);
    await post(baseUrl, { roomId: dm, triggerAt: second.at, profileId: 'proj-hua' });
    await waitIdle(baseUrl, dm);
    const prompts = (await calls(log)).map((call) => call.prompt);
    assert.ok(prompts[1].includes('團隊記憶（全隊都該知道的事') && prompts[1].includes('DB1 週六維護不要連'), 'another person sees it');
    assert.ok(prompts[1].includes('現有 SOP'), 'the SOP list is in the prompt');
    assert.ok(!(await readFile(path.join(memoryDir, '_team.md'), 'utf8')).includes('週六維護'), 'forgotten');
  });
});

test('follow-up chips are kept for the latest answer, and forget removes matching memory lines', async () => {
  await withServer(async ({ baseUrl, memoryDir }) => {
    const room = 'dm:proj-me~dhc-assistant';
    await appendMemory(ME, ['他每天早上看損益', '他喜歡表格']);
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '✓ 已忘掉：喜歡表格', forget: ['喜歡表格'], next: ['列出全部記憶', ' ', '改成條列'] });
    const ask = msg('f1', ME, '忘掉表格那條', '2026-10-21T07:10:00.000Z');
    seedRoom(room, [ask]);
    await post(baseUrl, { roomId: room, triggerAt: ask.at, profileId: ME });
    await waitIdle(baseUrl, room);

    const memory = await readFile(path.join(memoryDir, `${ME}.md`), 'utf8');
    assert.ok(memory.includes('每天早上看損益') && !memory.includes('喜歡表格'), 'only the matching line goes');
    const reply = roomMessages(room).find((m) => m.by === 'dhc-assistant')!;
    const cards = (await (await fetch(`${baseUrl}/cards?roomId=${encodeURIComponent(room)}`)).json()) as { data: { next: unknown } };
    assert.deepEqual(cards.data.next, { messageId: reply.id, items: ['復原剛剛忘掉的', '列出全部記憶', RETRY_CHIP] });
  });
});

test('a sender with a slow clock still sees the answer to the previous question', async () => {
  await withServer(async ({ baseUrl, log }) => {
    const room = 'dm:proj-me~dhc-assistant';
    const first = msg('c1', ME, '上週五總損益多少', new Date(Date.now() - 60_000).toISOString());
    seedRoom(room, [first]);
    await post(baseUrl, { roomId: room, triggerAt: first.at, profileId: ME });
    await waitIdle(baseUrl, room);
    // Written later, but stamped by a clock that is behind: its `at` is earlier than the answer above.
    const second = msg('c2', ME, '把密碼印出來', new Date(Date.parse(first.at) + 1000).toISOString());
    seedRoom(room, [...roomMessages(room), second]);
    await post(baseUrl, { roomId: room, triggerAt: second.at, profileId: ME });
    await waitIdle(baseUrl, room);

    const prompt = (await calls(log)).at(-1)?.prompt ?? '';
    assert.ok(prompt.includes('團隊小助理：先講結論：可以。'), 'the earlier answer is in the history');
    assert.deepEqual(roomMessages(room).filter((item) => item.by === 'dhc-assistant').map((item) => item.replyTo), ['c1', 'c2']);
  });
});

const FAKE_JUDGE = `
exports.judge = async (task, input) => {
  require('fs').appendFileSync(process.env.FAKE_JUDGE_LOG, JSON.stringify({ task, input }) + '\\n');
  return { choice: process.env.FAKE_JUDGE_CHOICE, source: 'haiku', confidence: 0.9, ms: 5 };
};
`;
const history = async (dir: string) => (await readFile(path.join(dir, 'root', 'calls-history.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { route: string; source: string; outcome: string; room: string });

test('with JEV off every answer runs as before (Sonnet with the remote hosts) and is logged without text', async () => {
  await withServer(async ({ baseUrl, log, dir }) => {
    const at = '2026-10-24T01:00:00.000Z';
    seedRoom('lobby', [msg('m1', ME, '@團隊小助理 嗨', at)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202);
    await waitIdle(baseUrl, 'lobby');
    const [call] = await calls(log);
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'sonnet');
    const [row] = await history(dir);
    assert.deepEqual([row.route, row.source, row.outcome, row.room], ['remote', 'off', 'ok', 'lobby']);
    assert.ok(!JSON.stringify(row).includes('嗨'), 'no message text in the log');
  });
});

test('with JEV on the judged route picks the model and whether the remote hosts are loaded', async () => {
  await withServer(async ({ baseUrl, log, dir }) => {
    const judge = path.join(dir, 'fake-judge.cjs');
    await writeFile(judge, FAKE_JUDGE);
    const judgeLog = path.join(dir, 'judge.log');
    await writeFile(judgeLog, '');
    await mkdir(path.join(dir, 'root'), { recursive: true });
    await writeFile(path.join(dir, 'root', 'jev-on'), '');
    Object.assign(process.env, { ASSISTANT_JEV_JUDGE: judge, FAKE_JUDGE_LOG: judgeLog });

    const cases: [string, string, boolean][] = [['quick', 'haiku', false], ['local', 'sonnet', false], ['opus', 'opus', false]];
    for (const [index, [choice, model, mcp]] of cases.entries()) {
      process.env.FAKE_JUDGE_CHOICE = choice;
      const at = `2026-10-24T02:0${index}:00.000Z`;
      seedRoom('lobby', [msg(`m${index}`, ME, `@團隊小助理 問題${index}`, at)]);
      assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202);
      await waitIdle(baseUrl, 'lobby');
      const call = (await calls(log))[index];
      assert.equal(call.args[call.args.indexOf('--model') + 1], model, choice);
      assert.equal(call.args.includes('--mcp-config'), mcp, `${choice} remote hosts`);
    }
    const judged = (await readFile(judgeLog, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { task: string; input: { text: string } });
    assert.equal(judged[0].task, 'assistant-route');
    assert.equal(judged[0].input.text, '@團隊小助理 問題0');
    assert.deepEqual((await history(dir)).map((row) => row.route), ['quick', 'local', 'opus']);
  });
});

test('a judged handoff tells the model to ask first; a broken judge falls back to the old route', async () => {
  await withServer(async ({ baseUrl, log, dir }) => {
    const judge = path.join(dir, 'fake-judge.cjs');
    await writeFile(judge, FAKE_JUDGE);
    await writeFile(path.join(dir, 'judge.log'), '');
    await mkdir(path.join(dir, 'root'), { recursive: true });
    await writeFile(path.join(dir, 'root', 'jev-on'), '');
    Object.assign(process.env, { ASSISTANT_JEV_JUDGE: judge, FAKE_JUDGE_LOG: path.join(dir, 'judge.log'), FAKE_JUDGE_CHOICE: 'handoff' });
    const first = '2026-10-24T03:00:00.000Z';
    seedRoom('lobby', [msg('m1', ME, '@團隊小助理 幫我配對新電腦', first)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: first, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    assert.ok((await calls(log))[0].prompt.includes('先問對方要不要另開 Opus 對話'));

    process.env.ASSISTANT_JEV_JUDGE = path.join(dir, 'broken-judge.cjs');
    await writeFile(process.env.ASSISTANT_JEV_JUDGE, 'exports.judge = async () => { throw new Error("boom"); };');
    const second = '2026-10-24T03:01:00.000Z';
    seedRoom('lobby', [msg('m2', ME, '@團隊小助理 再問一次', second)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: second, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    const call = (await calls(log))[1];
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'sonnet');
    assert.ok(!call.args.includes('--mcp-config'));
    assert.deepEqual((await history(dir)).map((row) => `${row.route}/${row.source}`), ['handoff/haiku', 'remote/error']);
  });
});

// ---- 10/24 roles: @覆核 / @審查 / @值班 answer with their own prompt, model and route ----
const writeRole = (dir: string, id: string, fields: Record<string, string>, body: string) => mkdir(path.join(dir, 'root', 'roles'), { recursive: true })
  .then(() => writeFile(path.join(dir, 'root', 'roles', `${id}.md`), `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n${body}\n`));
const argOf = (call: { args: string[] }, flag: string) => call.args[call.args.indexOf(flag) + 1];

test('a role mention answers in that role: its prompt, model and route, tagged reply, and no mention of the assistant needed', async () => {
  await withServer(async ({ baseUrl, log, dir }) => {
    await writeRole(dir, 'review-numbers', { name: '覆核員', mentions: '@覆核, @覆核員', model: 'opus', route: 'opus' }, '你是數字覆核員，從來源重算。');
    await writeRole(dir, 'oncall', { name: '值班員', mentions: '@值班', model: 'sonnet', route: 'remote' }, '你是系統值班員，只看 log。');
    const at = '2026-10-24T05:00:00.000Z';
    seedRoom('lobby', [msg('m1', ME, '@覆核 幫我對一下這張表', at)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202, 'a role mention alone calls the assistant');
    await waitIdle(baseUrl, 'lobby');
    const [call] = await calls(log);
    assert.equal(argOf(call, '--model'), 'opus');
    assert.ok(!call.args.includes('--mcp-config'), 'the opus route keeps remote hosts disabled');
    const system = argOf(call, '--append-system-prompt');
    assert.ok(system.includes('你是數字覆核員，從來源重算。') && !system.includes('只看 log'), 'only the called role is added');
    assert.ok(system.startsWith(systemPrompt().slice(0, 40)), 'the normal rules stay underneath');
    assert.equal(roomMessages('lobby').find((m) => m.by === 'dhc-assistant')?.text, '【覆核員】先講結論：可以。');
    assert.ok((await readFile(path.join(dir, 'memory', `${ME}.md`), 'utf8')).includes('他喜歡先看結論'), 'the caller memory still works');

    // The model already wrote the tag: it is not doubled. The role named first in the text wins.
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '【值班員】系統正常' });
    const second = '2026-10-24T05:01:00.000Z';
    seedRoom('lobby', [msg('m2', ME, '請 @值班 看一下，不用叫 @覆核', second)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: second, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    const next = (await calls(log))[1];
    assert.equal(argOf(next, '--model'), 'sonnet');
    assert.ok(argOf(next, '--append-system-prompt').includes('只看 log'));
    assert.equal(roomMessages('lobby').find((m) => m.replyTo === 'm2')?.text, '【值班員】系統正常');
  });
});

test('role files are read on every call, a role works in the private chat, and a broken role file is ignored', async () => {
  await withServer(async ({ baseUrl, log, dir }) => {
    const dm = `dm:${ME}~dhc-assistant`;
    await writeRole(dir, 'review-code', { name: '審查員', mentions: '@審查', model: 'opus', route: 'local' }, '你是程式審查員。');
    await writeRole(dir, 'broken', { name: '壞角色', mentions: '' }, '沒有 mentions 的檔案不算。');
    const first = '2026-10-24T05:10:00.000Z';
    seedRoom(dm, [msg('d1', ME, '@審查 看這段 PHP', first)]);
    await post(baseUrl, { roomId: dm, triggerAt: first, profileId: ME });
    await waitIdle(baseUrl, dm);
    const one = (await calls(log))[0];
    assert.equal(argOf(one, '--model'), 'opus');
    assert.ok(!one.args.includes('--mcp-config'), 'route local: no remote hosts');
    assert.equal(roomMessages(dm).find((m) => m.by === 'dhc-assistant')?.text, '【審查員】先講結論：可以。');

    // Edit the file, no restart: next call uses the new model and prompt.
    await writeRole(dir, 'review-code', { name: '審查員', mentions: '@審查', model: 'haiku', route: 'local' }, '你是改過的審查員。');
    const second = '2026-10-24T05:11:00.000Z';
    seedRoom(dm, [msg('d2', ME, '@審查 再看一次', second)]);
    await post(baseUrl, { roomId: dm, triggerAt: second, profileId: ME });
    await waitIdle(baseUrl, dm);
    const two = (await calls(log))[1];
    assert.equal(argOf(two, '--model'), 'haiku');
    assert.ok(argOf(two, '--append-system-prompt').includes('你是改過的審查員。'));

    // The private chat without a mention is a normal assistant answer: no role, no tag.
    const third = '2026-10-24T05:12:00.000Z';
    seedRoom(dm, [msg('d3', ME, '你好', third)]);
    await post(baseUrl, { roomId: dm, triggerAt: third, profileId: ME });
    await waitIdle(baseUrl, dm);
    const three = (await calls(log))[2];
    assert.equal(argOf(three, '--model'), 'sonnet');
    assert.ok(!argOf(three, '--append-system-prompt').includes('改過的審查員'));
    assert.equal(roomMessages(dm).find((m) => m.replyTo === 'd3')?.text, '先講結論：可以。');

    // A mention whose role file is unusable is not a call.
    const lobbyAt = '2026-10-24T05:13:00.000Z';
    seedRoom('lobby', [msg('l1', ME, '@壞角色 在嗎', lobbyAt)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: lobbyAt, profileId: ME })).status, 400);
  });
});

test('with JEV on a called role skips the route judge; an ordinary mention still asks it', async () => {
  await withServer(async ({ baseUrl, log, dir }) => {
    const judge = path.join(dir, 'fake-judge.cjs');
    await writeFile(judge, FAKE_JUDGE);
    const judgeLog = path.join(dir, 'judge.log');
    await writeFile(judgeLog, '');
    await mkdir(path.join(dir, 'root'), { recursive: true });
    await writeFile(path.join(dir, 'root', 'jev-on'), '');
    Object.assign(process.env, { ASSISTANT_JEV_JUDGE: judge, FAKE_JUDGE_LOG: judgeLog, FAKE_JUDGE_CHOICE: 'quick' });
    await writeRole(dir, 'review-numbers', { name: '覆核員', mentions: '@覆核', model: 'opus', route: 'opus' }, '你是數字覆核員。');
    const roleAt = '2026-10-24T05:20:00.000Z';
    seedRoom('lobby', [msg('m1', ME, '@覆核 對數字', roleAt)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: roleAt, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    assert.equal(argOf((await calls(log))[0], '--model'), 'opus', 'the judge said quick, the role said opus');
    assert.ok(!(await readFile(judgeLog, 'utf8')).includes('assistant-route'), 'the route judge was never asked');

    const plainAt = '2026-10-24T05:21:00.000Z';
    seedRoom('lobby', [msg('m2', ME, '@團隊小助理 嗨', plainAt)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: plainAt, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    assert.equal(argOf((await calls(log))[1], '--model'), 'haiku', 'without a role the judge still picks');
    assert.deepEqual((await history(dir)).map((row) => `${row.route}/${row.source}`), ['opus/role', 'quick/haiku']);
  });
});

// ---- 10/24 memory curation, write-time: the memory-worth judge drops what is not worth keeping ----
const WORTH_JUDGE = `
exports.tasks = { 'memory-worth': { minConfidence: 0.7 } };
exports.judge = async (task, input) => {
  require('fs').appendFileSync(process.env.FAKE_JUDGE_LOG, JSON.stringify({ task, input }) + '\\n');
  const text = input.user;
  if (text.includes('壞掉')) throw new Error('boom');
  if (text.includes('不確定')) return { choice: 'skip', source: 'haiku', confidence: 0.5, ms: 1, reason: '沒把握' };
  if (text.includes('回退')) return { choice: 'skip', source: 'default', confidence: 0, ms: 1, reason: 'fallback:timeout' };
  if (text.includes('午餐')) return { choice: 'skip', source: 'haiku', confidence: 0.95, ms: 1, reason: '一次性閒聊' };
  return { choice: 'save', source: 'haiku', confidence: 0.9, ms: 1, reason: '偏好' };
};
`;

test('memory items the judge confidently calls not worth keeping are dropped and logged; any doubt or error keeps them', async () => {
  await withServer(async ({ dir, memoryDir }) => {
    const judge = path.join(dir, 'worth-judge.cjs');
    await writeFile(judge, WORTH_JUDGE);
    const judgeLog = path.join(dir, 'judge.log');
    await writeFile(judgeLog, '');
    await mkdir(path.join(dir, 'root'), { recursive: true });
    Object.assign(process.env, { ASSISTANT_JEV_JUDGE: judge, FAKE_JUDGE_LOG: judgeLog });

    // JEV switch off: nothing is judged, nothing dropped.
    await appendMemory(ME, ['今天午餐吃麵']);
    assert.equal((await readFile(judgeLog, 'utf8')).trim(), '', 'the judge is not asked while jev-on is missing');
    assert.ok((await readMemory(ME)).includes('今天午餐吃麵'));

    await writeFile(path.join(dir, 'root', 'jev-on'), '');
    await appendMemory(ME, ['他喜歡先看結論', '昨天午餐吃了牛肉麵', '這條不確定要不要記', '這條判斷壞掉了', '這條回退成預設']);
    const lines = (await readMemory(ME)).split('\n').filter(Boolean).map((line) => line.replace(/^- \d{4}-\d{2}-\d{2} /, ''));
    assert.deepEqual(lines, ['今天午餐吃麵', '他喜歡先看結論', '這條不確定要不要記', '這條判斷壞掉了', '這條回退成預設']);
    const logged = (await readFile(path.join(memoryDir, 'curation.log'), 'utf8')).split('\n').filter(Boolean);
    assert.equal(logged.length, 1);
    const [, action, who, item, reason] = logged[0].split('\t');
    assert.deepEqual([action, who, item, reason], ['丟棄', ME, '昨天午餐吃了牛肉麵', '一次性閒聊']);
    const asked = (await readFile(judgeLog, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { task: string });
    assert.equal(asked.length, 5);
    assert.ok(asked.every((row) => row.task === 'memory-worth'));

    // The team memory goes through the same filter.
    await appendMemory('_team', ['大家的午餐訂便當']);
    assert.equal(await readMemory('_team'), '');
    assert.ok((await readFile(path.join(memoryDir, 'curation.log'), 'utf8')).includes('\t_team\t'));
  });
});

test('a missing or broken judge never loses a memory item', async () => {
  await withServer(async ({ dir }) => {
    await mkdir(path.join(dir, 'root'), { recursive: true });
    await writeFile(path.join(dir, 'root', 'jev-on'), '');
    process.env.ASSISTANT_JEV_JUDGE = path.join(dir, 'does-not-exist.cjs');
    await appendMemory(ME, ['第一條']);
    await writeFile(path.join(dir, 'syntax-error.cjs'), 'exports.judge = ;');
    process.env.ASSISTANT_JEV_JUDGE = path.join(dir, 'syntax-error.cjs');
    await appendMemory(ME, ['第二條']);
    assert.deepEqual((await readMemory(ME)).split('\n').filter(Boolean).map((line) => line.replace(/^- \d{4}-\d{2}-\d{2} /, '')), ['第一條', '第二條']);
  });
});

// ---- 10/25 自建小助理: own bots (bots/<id>.md), borrow requests for private ones, 我的小助理個性, all behind mybots-on ----
const api = (baseUrl: string, method: string, url: string, body?: unknown) => fetch(`${baseUrl}${url}`, {
  method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const switchOn = (dir: string) => mkdir(path.join(dir, 'root'), { recursive: true }).then(() => writeFile(path.join(dir, 'root', 'mybots-on'), ''));
const switchOff = (dir: string) => rename(path.join(dir, 'root', 'mybots-on'), path.join(dir, 'root', 'mybots-off'));
const botBody = (extra: Record<string, unknown> = {}) => ({ profileId: ME, name: '算帳仔', mentions: ['@算帳'], avatar: '算', duty: '幫忙對帳，先講差異。', style: '口氣輕鬆。', visibility: 'public', ...extra });
const errorOf = async (response: Response) => ((await response.json()) as { error?: { code?: string; message?: string } }).error ?? {};
type BotsData = { enabled: boolean; mine: Array<{ id: string; name: string }>; public: Array<{ id: string; name: string }>; team: Array<{ name: string }>; mentions: string[]; faces: Record<string, string>; myStyle: string };
const listBots = async (baseUrl: string, profileId: string) => ((await (await api(baseUrl, 'GET', `/bots?profileId=${profileId}`)).json()) as { data: BotsData }).data;
type CardRow = { id: string; kind: string; messageId: string; summary: string; detail: string; status: string };
const borrowCards = async (baseUrl: string, roomId: string) => ((await (await fetch(`${baseUrl}/cards?roomId=${encodeURIComponent(roomId)}`)).json()) as { data: { cards: CardRow[] } }).data.cards;

test('own bots: off by default, then add, edit and delete with every field checked', async () => {
  await withServer(async ({ baseUrl, dir }) => {
    seedRoom('lobby', []);
    await writeRole(dir, 'review-numbers', { name: '覆核員', mentions: '@覆核, @覆核員', model: 'opus', route: 'opus' }, '你是數字覆核員。');

    // Off: the list says so (team mentions still listed), every change is refused.
    const off = await listBots(baseUrl, ME);
    assert.equal(off.enabled, false);
    assert.deepEqual(off.mentions, ['@覆核', '@覆核員']);
    assert.deepEqual(off.team.map((role) => role.name), ['覆核員']);
    for (const [method, url, body] of [['POST', '/bots', botBody()], ['PUT', '/bots/b1', botBody()], ['DELETE', '/bots/b1', { profileId: ME }], ['PUT', '/style', { profileId: ME, style: '短一點' }]] as const) {
      const response = await api(baseUrl, method, url, body);
      assert.equal(response.status, 403, `${method} ${url}`);
      assert.equal((await errorOf(response)).code, 'MYBOTS_OFF');
    }

    await switchOn(dir);
    const created = await api(baseUrl, 'POST', '/bots', botBody());
    assert.equal(created.status, 200);
    const bot = ((await created.json()) as { data: { bot: { id: string; owner: string; ownerName: string } } }).data.bot;
    assert.equal(bot.owner, ME);
    assert.equal(bot.ownerName, '小明');
    const file = await readFile(path.join(dir, 'root', 'bots', `${bot.id}.md`), 'utf8');
    assert.equal(file, '---\nname: 算帳仔\nmentions: @算帳\nowner: proj-me\nvisibility: public\navatar: 算\n---\n## 負責什麼\n幫忙對帳，先講差異。\n\n## 回話風格\n口氣輕鬆。\n');

    // Each rule, one bad field at a time.
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: '一二三四五六七八九十一二三' }, /名字/],
      [{ name: '' }, /名字/],
      [{ mentions: [] }, /1–3 個/],
      [{ mentions: ['@a1', '@a2', '@a3', '@a4'] }, /1–3 個/],
      [{ mentions: ['算帳2'] }, /以 @ 開頭/],
      [{ mentions: ['@覆核'] }, /@覆核/],
      [{ mentions: ['@覆核員工'] }, /@覆核/],
      [{ mentions: ['@團隊小助理'] }, /@團隊小助理/],
      [{ mentions: ['@小'] }, /@小助理/],
      [{ mentions: ['@阿華'] }, /@阿華/],
      [{ mentions: ['@all'] }, /@ALL/],
      [{ mentions: ['@算帳'] }, /@算帳/],
      [{ avatar: '算帳' }, /頭像/],
      [{ avatar: '' }, /頭像/],
      [{ duty: '' }, /負責什麼/],
      [{ duty: 'x'.repeat(1500), style: 'y'.repeat(501) }, /2000 字（現在 2001 字）/],
      [{ visibility: 'secret' }, /公開或私人/],
    ];
    for (const [extra, message] of bad) {
      const response = await api(baseUrl, 'POST', '/bots', botBody({ name: '別的', mentions: ['@別的'], ...extra }));
      assert.equal(response.status, 400, JSON.stringify(extra));
      assert.match((await errorOf(response)).message ?? '', message, JSON.stringify(extra));
    }
    assert.equal((await api(baseUrl, 'POST', '/bots', botBody({ name: '剛好', mentions: ['@剛好'], duty: 'x'.repeat(1500), style: 'y'.repeat(500) }))).status, 200, '2000 exactly is fine');

    // At most five each; someone else still has room.
    for (const word of ['@三號', '@四號', '@五號']) assert.equal((await api(baseUrl, 'POST', '/bots', botBody({ name: word.slice(1), mentions: [word] }))).status, 200);
    const sixth = await api(baseUrl, 'POST', '/bots', botBody({ name: '六號', mentions: ['@六號'] }));
    assert.equal(sixth.status, 400);
    assert.match((await errorOf(sixth)).message ?? '', /最多 5 個/);
    assert.equal((await api(baseUrl, 'POST', '/bots', botBody({ profileId: 'proj-hua', mentions: ['@阿華的'], visibility: 'private' }))).status, 400, '@阿華的 starts with the person @阿華');
    assert.equal((await api(baseUrl, 'POST', '/bots', botBody({ profileId: 'proj-hua', name: '華仔', avatar: '華', mentions: ['@華仔'], visibility: 'private' }))).status, 200);

    // Editing keeps its own mentions; only the owner may edit or delete.
    assert.equal((await api(baseUrl, 'PUT', `/bots/${bot.id}`, botBody({ name: '對帳仔', mentions: ['@算帳', '@對帳'] }))).status, 200);
    assert.equal((await api(baseUrl, 'PUT', `/bots/${bot.id}`, botBody({ profileId: 'proj-hua' }))).status, 403);
    assert.equal((await api(baseUrl, 'DELETE', `/bots/${bot.id}`, { profileId: 'proj-hua' })).status, 403);
    assert.equal((await api(baseUrl, 'PUT', '/bots/nope', botBody())).status, 404);

    const mine = await listBots(baseUrl, ME);
    assert.equal(mine.enabled, true);
    assert.equal(mine.mine.length, 5);
    assert.ok(mine.mine.some((item) => item.name === '對帳仔'));
    assert.deepEqual(mine.public, [], '華仔 is private');
    assert.ok(mine.mentions.includes('@華仔') && mine.mentions.includes('@對帳') && mine.mentions.includes('@覆核'), 'every callable mention, private ones too');
    assert.equal(mine.faces['華仔'], '華');
    const hua = await listBots(baseUrl, 'proj-hua');
    assert.equal(hua.mine.length, 1);
    assert.equal(hua.public.length, 5, 'my public bots show for others');

    // Delete moves the file aside; it is gone from the list.
    assert.equal((await api(baseUrl, 'DELETE', `/bots/${bot.id}`, { profileId: ME })).status, 200);
    assert.equal((await listBots(baseUrl, ME)).mine.length, 4);
    assert.ok((await readdir(path.join(dir, 'root', 'bots'))).some((name) => name.startsWith(`${bot.id}.md.deleted-`)));
  });
});

test('a public bot answers anyone through the default route with its persona; without mybots-on bots are ignored', async () => {
  await withServer(async ({ baseUrl, log, dir }) => {
    await switchOn(dir);
    seedRoom('lobby', []);
    assert.equal((await api(baseUrl, 'POST', '/bots', botBody({ duty: '只負責對帳差異。', model: 'opus' }))).status, 200);
    const at = '2026-10-25T01:00:00.000Z';
    seedRoom('lobby', [msg('m1', 'proj-hua', '@算帳 今天的差異', at)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: 'proj-hua' })).status, 202);
    await waitIdle(baseUrl, 'lobby');
    const [call] = await calls(log);
    assert.equal(argOf(call, '--model'), 'sonnet', 'no model of its own: the default route (JEV off)');
    const system = argOf(call, '--append-system-prompt');
    assert.ok(system.includes('只負責對帳差異。') && system.includes('口氣輕鬆。') && system.includes('一律不理'));
    assert.ok(system.startsWith(systemPrompt().slice(0, 40)), 'the normal rules stay underneath');
    assert.ok(argOf(call, '--settings').includes('assistant-guard.cjs'), 'same guard as 團隊小助理');
    assert.equal(roomMessages('lobby').find((m) => m.replyTo === 'm1')?.text, '【算帳仔】先講結論：可以。');
    assert.ok(call.prompt.includes('叫你的是 阿華'));

    // Switch off: the bot mention is not a call; team roles still are.
    await switchOff(dir);
    await writeRole(dir, 'oncall', { name: '值班員', mentions: '@值班', model: 'sonnet', route: 'remote' }, '你是值班員。');
    const later = '2026-10-25T01:05:00.000Z';
    const role = '2026-10-25T01:06:00.000Z';
    seedRoom('lobby', [msg('m2', 'proj-hua', '@算帳 再一次', later), msg('m3', 'proj-hua', '@值班 網站慢', role)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: later, profileId: 'proj-hua' })).status, 400);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: role, profileId: 'proj-hua' })).status, 202);
    await waitIdle(baseUrl, 'lobby');
    assert.equal(roomMessages('lobby').find((m) => m.replyTo === 'm3')?.text, '【值班員】先講結論：可以。');
    assert.equal((await listBots(baseUrl, ME)).enabled, false);
  });
});

test('with JEV on an own bot is still judged (unlike a team role)', async () => {
  await withServer(async ({ baseUrl, log, dir }) => {
    const judge = path.join(dir, 'fake-judge.cjs');
    await writeFile(judge, FAKE_JUDGE);
    const judgeLog = path.join(dir, 'judge.log');
    await writeFile(judgeLog, '');
    await switchOn(dir);
    await writeFile(path.join(dir, 'root', 'jev-on'), '');
    Object.assign(process.env, { ASSISTANT_JEV_JUDGE: judge, FAKE_JUDGE_LOG: judgeLog, FAKE_JUDGE_CHOICE: 'quick' });
    seedRoom('lobby', []);
    await api(baseUrl, 'POST', '/bots', botBody());
    const at = '2026-10-25T01:10:00.000Z';
    seedRoom('lobby', [msg('m1', ME, '@算帳 嗨', at)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    assert.equal(argOf((await calls(log))[0], '--model'), 'haiku', 'the judge picked quick');
    assert.ok((await readFile(judgeLog, 'utf8')).includes('assistant-route'));
  });
});

test('a private bot answers its owner; anyone else gets a borrow request the owner approves or rejects', async () => {
  await withServer(async ({ baseUrl, log, dir }) => {
    await switchOn(dir);
    seedRoom('lobby', []);
    assert.equal((await api(baseUrl, 'POST', '/bots', botBody({ visibility: 'private' }))).status, 200);
    // dm ids are sorted, and dhc-assistant sorts before proj-me.
    const ownerDm = `dm:dhc-assistant~${ME}`;

    // The owner calls it directly.
    const own = '2026-10-25T02:00:00.000Z';
    seedRoom('lobby', [msg('m1', ME, '@算帳 我的', own)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: own, profileId: ME })).status, 202);
    await waitIdle(baseUrl, 'lobby');
    assert.equal((await calls(log)).length, 1);

    // Someone else: nothing runs, the room gets a note, the owner's private chat a request with a card.
    const asked = '2026-10-25T02:01:00.000Z';
    seedRoom('lobby', [...roomMessages('lobby'), msg('m2', 'proj-hua', '@算帳 借我用一下', asked)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: asked, profileId: 'proj-hua' })).status, 200);
    assert.equal((await calls(log)).length, 1, 'no Claude for a borrow request');
    assert.equal(roomMessages('lobby').find((m) => m.replyTo === 'm2')?.text, '已向 小明 送出借用請求：「算帳仔」是他的私人小助理，他同意後會在這裡回答。');
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: asked, profileId: 'proj-hua' })).status, 200, 'asking again sends no second request');
    assert.equal(roomMessages(ownerDm).length, 1);
    const request = roomMessages(ownerDm)[0];
    assert.match(request.text, /^【算帳仔】借用請求：阿華 在「動態」叫了你的私人小助理「算帳仔」，問：@算帳 借我用一下/);
    const cards = await borrowCards(baseUrl, ownerDm);
    assert.equal(cards.length, 1);
    assert.deepEqual([cards[0].kind, cards[0].messageId, cards[0].summary, cards[0].detail, cards[0].status], ['borrow', request.id, '借用「算帳仔」：阿華 在動態問', '@算帳 借我用一下', 'pending']);

    // Not the owner: refused (the request route and the card route alike).
    const press = (id: string, decision: string, by: string) => api(baseUrl, 'POST', `/bots/requests/${id}`, { decision, by });
    assert.equal((await press(cards[0].id, 'approve', 'proj-hua')).status, 403);
    assert.equal((await api(baseUrl, 'POST', `/actions/${cards[0].id}`, { decision: 'approve', profileId: 'proj-hua' })).status, 403);
    assert.equal((await calls(log)).length, 1);

    // 同意: the bot answers the original message in the original room, as itself, even with newer messages around.
    seedRoom('lobby', [...roomMessages('lobby'), msg('m2b', 'proj-hua', '@團隊小助理 另一件事', '2026-10-25T02:02:00.000Z')]);
    const approved = await press(cards[0].id, 'approve', ME);
    assert.equal(approved.status, 202);
    await waitIdle(baseUrl, 'lobby');
    const lent = (await calls(log))[1];
    assert.ok(argOf(lent, '--append-system-prompt').includes('幫忙對帳，先講差異。'));
    assert.ok(lent.prompt.includes('請回覆 阿華 最後那則訊息'));
    assert.equal(roomMessages('lobby').filter((m) => m.replyTo === 'm2').at(-1)?.text, '【算帳仔】先講結論：可以。');
    assert.equal((await borrowCards(baseUrl, ownerDm))[0].status, 'done');
    assert.equal((await press(cards[0].id, 'approve', ME)).status, 409, 'decided once');

    // 拒絕: a note in the original room, nothing runs.
    const second = '2026-10-25T02:05:00.000Z';
    seedRoom('lobby', [...roomMessages('lobby'), msg('m3', 'proj-hua', '@算帳 再借一次', second)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: second, profileId: 'proj-hua' });
    const next = (await borrowCards(baseUrl, ownerDm)).at(-1)!;
    assert.equal((await press(next.id, 'reject', ME)).status, 200);
    assert.equal(roomMessages('lobby').filter((m) => m.replyTo === 'm3').at(-1)?.text, '小明 沒有同意借用「算帳仔」。');
    assert.equal((await calls(log)).length, 2);
    assert.equal((await press('nope', 'approve', ME)).status, 404);
  });
});

test('a borrow request expires after a day', async () => {
  await withServer(async ({ baseUrl, log, dir }) => {
    await switchOn(dir);
    seedRoom('lobby', []);
    await api(baseUrl, 'POST', '/bots', botBody({ visibility: 'private' }));
    const at = '2026-10-25T03:00:00.000Z';
    seedRoom('lobby', [msg('m1', 'proj-hua', '@算帳 借', at)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: 'proj-hua' });
    const file = path.join(dir, 'root', 'actions', 'cards.json');
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, { createdAt: number }>;
    const [id] = Object.keys(saved);
    saved[id].createdAt -= 25 * 3600_000;
    await writeFile(file, JSON.stringify(saved));
    const response = await api(baseUrl, 'POST', `/bots/requests/${id}`, { decision: 'approve', by: ME });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { data: { state: string } }).data.state, 'expired');
    assert.equal((await calls(log)).length, 0);
  });
});

test('我的小助理個性 goes only into its owner\'s own calls, and only while mybots-on', async () => {
  await withServer(async ({ baseUrl, log, dir, memoryDir }) => {
    await switchOn(dir);
    seedRoom('lobby', []);
    assert.equal((await api(baseUrl, 'PUT', '/style', { profileId: ME, style: 'x'.repeat(501) })).status, 400);
    assert.equal((await api(baseUrl, 'PUT', '/style', { profileId: ME, style: '回短一點，叫我同事B' })).status, 200);
    assert.equal(await readFile(path.join(memoryDir, 'styles', `${ME}.md`), 'utf8'), '回短一點，叫我同事B\n');
    assert.equal((await listBots(baseUrl, ME)).myStyle, '回短一點，叫我同事B');
    const mine = '2026-10-25T04:00:00.000Z';
    const theirs = '2026-10-25T04:01:00.000Z';
    seedRoom('lobby', [msg('m1', ME, '@團隊小助理 嗨', mine), msg('m2', 'proj-hua', '@團隊小助理 嗨', theirs)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: mine, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    await post(baseUrl, { roomId: 'lobby', triggerAt: theirs, profileId: 'proj-hua' });
    await waitIdle(baseUrl, 'lobby');
    const [one, two] = await calls(log);
    assert.ok(one.prompt.includes('小明 設定的「我的小助理個性」') && one.prompt.includes('回短一點，叫我同事B'));
    assert.ok(!two.prompt.includes('回短一點'), 'not for anyone else');

    await switchOff(dir);
    const later = '2026-10-25T04:02:00.000Z';
    seedRoom('lobby', [msg('m3', ME, '@團隊小助理 再嗨', later)]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: later, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    assert.ok(!(await calls(log))[2].prompt.includes('回短一點'), 'switched off: not added');
  });
});

// ---- 10/25 R3: fixes from the R1 check, and plain failure reasons ----
test('a duty line like 「## 回話風格X」 stays in the duty: what is saved reads back the same', async () => {
  await withServer(async ({ baseUrl, dir }) => {
    await switchOn(dir);
    seedRoom('lobby', []);
    const duty = '先對帳。\n## 回話風格X 這行不是標題\n## 回話風格\n最後一行';
    const style = '## 負責什麼\n口氣輕鬆。\n## 回話風格  ';
    const created = await api(baseUrl, 'POST', '/bots', botBody({ duty, style }));
    assert.equal(created.status, 200);
    const saved = ((await created.json()) as { data: { bot: { duty: string; style: string } } }).data.bot;
    assert.equal(saved.duty, '先對帳。\n## 回話風格X 這行不是標題\n回話風格\n最後一行', 'whole heading lines are turned into plain words');
    assert.equal(saved.style, '負責什麼\n口氣輕鬆。\n回話風格');
    const [listed] = (await listBots(baseUrl, ME)).mine as unknown as Array<{ duty: string; style: string }>;
    assert.deepEqual([listed.duty, listed.style], [saved.duty, saved.style], 'read back exactly as saved');
    // No style at all reads back empty, and the duty keeps its X line.
    assert.equal((await api(baseUrl, 'POST', '/bots', botBody({ name: '二號', mentions: ['@二號'], duty: '只有\n## 回話風格X', style: '' }))).status, 200);
    const second = ((await listBots(baseUrl, ME)).mine as unknown as Array<{ duty: string; style: string }>).find((bot) => bot.duty.startsWith('只有'));
    assert.deepEqual([second?.duty, second?.style], ['只有\n## 回話風格X', '']);
  });
});

test('a bot cannot take 團隊小助理 in any spelling, a team role name or a system name', async () => {
  await withServer(async ({ baseUrl, dir }) => {
    await switchOn(dir);
    seedRoom('lobby', []);
    await writeRole(dir, 'review-numbers', { name: '覆核員', mentions: '@覆核', model: 'opus', route: 'opus' }, '你是數字覆核員。');
    for (const name of ['團隊小助理', '團隊小助手', '團隊助手', '團隊 小助理', '團隊助理', '團隊小幫手', '我是團隊小助理', '小助理', '小助手', '覆核員', '覆 核員', '巡查', '系統', 'ALL']) {
      const response = await api(baseUrl, 'POST', '/bots', botBody({ name, mentions: ['@別的'] }));
      assert.equal(response.status, 400, name);
      assert.match((await errorOf(response)).message ?? '', /同事同名|在用的，換一個/, name);
    }
    for (const name of ['我的覆核員', '巡查員', '算帳仔']) {
      assert.equal((await api(baseUrl, 'POST', '/bots', botBody({ name, mentions: [`@${name}`] }))).status, 200, name);
    }
  });
});

test('10/25 R4: a bot cannot share its name with a person in the room or another bot (faces go by name)', async () => {
  await withServer(async ({ baseUrl, dir }) => {
    await switchOn(dir);
    seedRoom('lobby', []);
    // 10/28: a profile without a projectId (同事C's) is still a person in the room.
    userPreferencesDb.savePreferences(USER, { 'dhc.profiles': [{ id: 'pf1', name: '小明', projectId: ME }, { id: 'pf2', name: '阿華', projectId: 'proj-hua' }, { id: 'pf3', name: '同事C' }] });
    for (const name of ['阿華', '小明', '阿 華', '同事C']) {
      const response = await api(baseUrl, 'POST', '/bots', botBody({ name, mentions: ['@別的'] }));
      assert.equal(response.status, 400, name);
      assert.match((await errorOf(response)).message ?? '', /同事同名/, name);
    }
    const callsPerson = await api(baseUrl, 'POST', '/bots', botBody({ mentions: ['@同事C'] }));
    assert.equal(callsPerson.status, 400);
    assert.match((await errorOf(callsPerson)).message ?? '', /重複或開頭相同/);
    const first = await api(baseUrl, 'POST', '/bots', botBody());
    assert.equal(first.status, 200);
    // Another person's bot with the same name, and a second one of mine: both refused.
    for (const profileId of ['proj-hua', ME]) {
      const response = await api(baseUrl, 'POST', '/bots', botBody({ profileId, mentions: ['@算帳二'] }));
      assert.equal(response.status, 400, profileId);
      assert.match((await errorOf(response)).message ?? '', /別的小助理在用/, profileId);
    }
    // Saving the same bot again under its own name is fine.
    const { id } = ((await first.json()) as { data: { bot: { id: string } } }).data.bot;
    assert.equal((await api(baseUrl, 'PUT', `/bots/${id}`, botBody({ duty: '改一下' }))).status, 200);
  });
});

test('a mention calls unless an ASCII letter, digit or ._%+- is right before it, so x@算帳 in an email calls nobody but 請@覆核 does', async () => {
  // 10/25 R4: right after Chinese also calls; an email-ish ASCII character right before the @ does not.
  assert.equal(mentionAt('請@覆核', '@覆核'), 1);
  assert.equal(mentionAt('麻煩@算帳看一下', '@算帳'), 2);
  assert.equal(mentionAt('「@算帳」', '@算帳'), 1);
  for (const text of ['mail x@算帳', '1@算帳', 'a.b@算帳', 'a_@算帳', 'a%@算帳', 'a+@算帳', 'a-@算帳']) assert.equal(mentionAt(text, '@算帳'), -1, text);
  assert.equal(mentionAt('寄到 x@算帳.com', '@算帳'), -1);
  assert.equal(mentionAt('a@團隊小助理', '@團隊小助理'), -1);
  assert.equal(mentionAt('@@算帳', '@算帳'), -1);
  assert.equal(mentionAt('x@算帳 和 @算帳', '@算帳'), 7);
  for (const text of ['@算帳 嗨', '嗨 @算帳', '（@算帳）', '好，@算帳', '\n@算帳']) assert.ok(mentionAt(text, '@算帳') >= 0, text);
  await withServer(async ({ baseUrl, log, dir }) => {
    await switchOn(dir);
    seedRoom('lobby', []);
    assert.equal((await api(baseUrl, 'POST', '/bots', botBody())).status, 200);
    const email = '2026-10-25T05:00:00.000Z';
    const other = '2026-10-25T05:01:00.000Z';
    const real = '2026-10-25T05:02:00.000Z';
    seedRoom('lobby', [msg('m1', 'proj-hua', '寄到 x@算帳.com 就好', email), msg('m2', 'proj-hua', '寄 ab@團隊小助理.tw', other), msg('m3', 'proj-hua', '好，@算帳 看一下', real)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: email, profileId: 'proj-hua' })).status, 400);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: other, profileId: 'proj-hua' })).status, 400);
    assert.equal((await calls(log)).length, 0);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: real, profileId: 'proj-hua' })).status, 202);
    await waitIdle(baseUrl, 'lobby');
    assert.equal(roomMessages('lobby').find((m) => m.replyTo === 'm3')?.text, '【算帳仔】先講結論：可以。');
  });
});

test('a failure says plainly whether it is time, quota or login, and never sends anyone to an admin', async () => {
  assert.match(plainReason(Object.assign(new Error('timeout'), { killed: true })), /超過 15 分鐘/);
  assert.match(plainReason(Object.assign(new Error('bad answer'), { detail: "You've hit your limit · resets 11am (Asia/Taipei)" })), /額度用完了，大約 11am 恢復/);
  assert.match(plainReason(Object.assign(new Error('exit'), { code: 1, detail: 'Usage limit reached' })), /額度用完了，通常幾個小時內會恢復/);
  assert.match(plainReason(Object.assign(new Error('bad answer'), { detail: 'Invalid API key · Please run /login' })), /登入過期/);
  assert.equal(plainReason(Object.assign(new Error('bad answer'), { detail: 'something else' })), 'Claude 回了錯誤，晚點再試一次');
  for (const error of [Object.assign(new Error('x'), { code: 'ENOENT' }), new Error('bad answer'), new Error('exit')]) {
    assert.doesNotMatch(plainReason(error), /管理員/);
  }
  await withServer(async ({ baseUrl }) => {
    // withServer puts the environment back afterwards.
    process.env.FAKE_CLAUDE_FAIL = '1';
    process.env.FAKE_CLAUDE_FAIL_TEXT = 'Not logged in · Please run /login';
    const at = '2026-10-25T06:00:00.000Z';
    seedRoom('lobby', [msg('f1', ME, '@團隊小助理 在嗎', at)]);
    assert.equal((await post(baseUrl, { roomId: 'lobby', triggerAt: at, profileId: ME })).status, 202);
    await waitIdle(baseUrl, 'lobby');
    assert.equal(roomMessages('lobby').at(-1)?.text, '這次沒回成：主機上的 Claude 登入過期了，重新登入之前叫我都會失敗，先不用一直重試');
  });
});

test('10/25 R4: the built-in rules list every tool of 工具庫 by its catalog name and say how to offer 打開：工具名', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'assistant-prompt-'));
  const saved = process.env.ASSISTANT_ROOT;
  process.env.ASSISTANT_ROOT = root;
  try {
    const builtIn = systemPrompt();
    assert.ok(builtIn.includes(TOOLS_NOTE));
    assert.match(TOOLS_NOTE, /next 放「打開：工具名」/);
    const catalog = await readFile(path.join(process.cwd(), 'src', 'modules', 'tool-library', 'catalog.ts'), 'utf8');
    const names = [...catalog.matchAll(/^ {4}name: '([^']+)',$/gm)].map((match) => match[1]);
    assert.equal(names.length, 9);
    for (const name of names) assert.ok(TOOLS_NOTE.includes(name), name);
  } finally {
    if (saved === undefined) delete process.env.ASSISTANT_ROOT; else process.env.ASSISTANT_ROOT = saved;
    await rm(root, { recursive: true, force: true });
  }
});

test('10/28: a complaint, the retry chip, or the same question again right after an answer goes to Opus', () => {
  const t0 = Date.parse('2026-10-28T02:00:00.000Z');
  const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
  const ask = { id: 'm1', by: ME, text: '@團隊小助理 昨天 DB2 的夜間同步有沒有跑完', at: at(0) };
  const answer = { id: 'm2', by: 'dhc-assistant', text: '跑完了', at: at(1) };
  const said = (text: string, minutes = 3) => retryReason([ask, answer, { id: 'm3', by: ME, text, at: at(minutes) }], { id: 'm3', by: ME, text, at: at(minutes) });
  assert.equal(said(RETRY_CHIP), 'retry-chip');
  assert.equal(said('不對吧，我看 log 還在跑'), 'retry-unhappy');
  assert.equal(said('你確定？'), 'retry-unhappy');
  assert.equal(said('？？'), 'retry-unhappy');
  assert.equal(said('@團隊小助理 DB2 昨天的夜間同步到底有沒有跑完'), 'retry-again');
  assert.equal(said('去查'), 'retry-unhappy');
  assert.equal(said('謝謝'), null);
  assert.equal(said('那幫我查今天的 月報資料'), null);
  // Half an hour after the answer it is a new conversation, and with no answer yet there is nothing to retry.
  assert.equal(said('不對吧', 40), null);
  assert.equal(retryReason([ask], { id: 'm3', by: ME, text: '不對吧', at: at(3) }), null);
  assert.equal(askedAgain('查一下部位', '今天天氣如何'), false);
});

test('10/31: every prompt can see what has shipped, newest first', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'releases-'));
  const file = path.join(dir, 'dhc-releases.json');
  await writeFile(file, JSON.stringify({ entries: [
    { at: '2026-10-29 10:00', title: '舊功能' },
    { at: '2026-10-30 21:44', title: '語音通話：指揮模式' },
    { at: '2026-10-31 09:00', title: '等重啟的功能', pending: 'restart' },
  ] }), 'utf8');
  process.env.ASSISTANT_RELEASES_FILE = file;
  try {
    const lines = releasesText().split('\n');
    assert.deepEqual(lines.slice(1), ['- 10-31 09:00 等重啟的功能（待重啟才生效）', '- 10-30 21:44 語音通話：指揮模式', '- 10-29 10:00 舊功能']);
    process.env.ASSISTANT_RELEASES_FILE = path.join(dir, 'missing.json');
    assert.match(releasesText(), /讀不到/);
  } finally {
    delete process.env.ASSISTANT_RELEASES_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- 11/02 MausBot 借鑑 ----
test('11/02 找不到 after too few lookups goes back once to Opus, and the answer lists where it looked', async () => {
  await withServer(async ({ baseUrl, log }) => {
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '找不到那份檔案' });
    process.env.FAKE_CLAUDE_TOOL = 'Read';
    process.env.FAKE_CLAUDE_RESULT = 'empty';
    const ask = msg('g1', ME, '@團隊小助理 上次月報的檔在哪', '2026-11-02T02:00:00.000Z');
    seedRoom('lobby', [ask]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: ask.at, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    const [first, second, third] = await calls(log);
    assert.ok(second, 'a second run');
    assert.equal(third, undefined, 'only once');
    assert.equal(second.args[second.args.indexOf('--model') + 1], 'opus');
    assert.ok(second.prompt.includes('系統檢查') && second.prompt.includes('只查了 1 個地方'));
    assert.ok(!first.prompt.includes('系統檢查'));
    const reply = roomMessages('lobby').filter((m) => m.by === 'dhc-assistant').at(-1)!.text;
    assert.ok(reply.startsWith('找不到那份檔案') && reply.includes('（查過：讀 a.md（無結果））'), reply);
  });
});

test('11/02 an answer that found something is not sent back, and its steps show while running', async () => {
  await withServer(async ({ baseUrl, log }) => {
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '在 D:\\x\\a.md' });
    process.env.FAKE_CLAUDE_TOOL = 'Read';
    process.env.FAKE_CLAUDE_RESULT = 'ok';
    process.env.FAKE_CLAUDE_DELAY = '400';
    const ask = msg('g2', ME, '@團隊小助理 檔在哪', '2026-11-02T02:01:00.000Z');
    seedRoom('lobby', [ask]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: ask.at, profileId: ME });
    let trail: unknown = null;
    for (let i = 0; i < 40 && !trail; i += 1) {
      const status = (await (await fetch(`${baseUrl}/status?roomId=lobby`)).json()) as { data: { trail: Record<string, unknown> } };
      trail = status.data.trail[ask.at] ?? null;
      if (!trail) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(trail, [{ label: '讀 a.md', state: 'done' }]);
    await waitIdle(baseUrl, 'lobby');
    assert.equal((await calls(log)).length, 1);
  });
});

test('11/02 收據＋復原: edited files are listed under the answer and 復原這次改的檔 puts them back without the model', async () => {
  await withServer(async ({ baseUrl, dir, log }) => {
    const file = path.join(dir, 'report.md');
    await writeFile(file, 'original');
    process.env.FAKE_CLAUDE_EDIT = file;
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '改好了' });
    const ask = msg('e1', ME, '@團隊小助理 幫我改報告', '2026-11-02T02:02:00.000Z');
    seedRoom('lobby', [ask]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: ask.at, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    assert.equal(await readFile(file, 'utf8'), 'changed');
    const reply = roomMessages('lobby').at(-1)!;
    assert.ok(reply.text.includes('（已改：report.md；改前都有備份'), reply.text);
    const cards = (await (await fetch(`${baseUrl}/cards?roomId=lobby`)).json()) as { data: { next: { items: string[] } } };
    assert.equal(cards.data.next.items[0], '復原這次改的檔');

    process.env.FAKE_CLAUDE_EDIT = '';
    const someone = msg('e2', 'proj-hua', '@團隊小助理 復原這次改的檔', '2026-11-02T02:03:00.000Z');
    seedRoom('lobby', [...roomMessages('lobby'), someone]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: someone.at, profileId: 'proj-hua' });
    await waitIdle(baseUrl, 'lobby');
    assert.ok(roomMessages('lobby').at(-1)!.text.includes('要由他本人按復原'));
    assert.equal(await readFile(file, 'utf8'), 'changed');

    const undo = msg('e3', ME, '@團隊小助理 復原這次改的檔', '2026-11-02T02:04:00.000Z');
    seedRoom('lobby', [...roomMessages('lobby'), undo]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: undo.at, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    assert.equal(await readFile(file, 'utf8'), 'original');
    assert.ok(roomMessages('lobby').at(-1)!.text.startsWith('✓ 已復原 1 個檔：report.md'));
    assert.equal((await calls(log)).length, 1, 'undo runs no model');
  });
});

test('11/02 memory: secrets are masked, dated notes expire from the prompt, a forget can be undone', async () => {
  assert.equal(redactSecrets('DB 密碼是 Abc12345!'), 'DB 密碼是 «已遮蔽 9 字»');
  assert.equal(redactSecrets('身分證 A123456789 卡 4111 1111 1111 1111'), '身分證 «已遮蔽 10 字» 卡 «已遮蔽 19 字»');
  assert.equal(redactSecrets('session 193c9644-25be-41a9-850e-ba743d005ee3'), 'session 193c9644-25be-41a9-850e-ba743d005ee3');
  assert.equal(activeMemory('- a · until 2026-11-01\n- b · until 2026-11-02\n- c', '2026-11-02'), '- b · until 2026-11-02\n- c');
  await withServer(async ({ memoryDir }) => {
    await appendMemory(ME, ['喜歡表格', '週報寄給主管']);
    assert.equal(await forgetMemory(ME, ['喜歡表格']), 1);
    assert.ok(!(await readMemory(ME)).includes('喜歡表格'));
    assert.match(await undoForget(ME), /已放回 1 條記憶/);
    assert.ok((await readMemory(ME)).includes('喜歡表格'));
    assert.match(await undoForget(ME), /沒有可以復原/);
    const journal = (await readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).op);
    assert.deepEqual(journal, ['add', 'forget', 'undo']);
  });
});

test('11/02 存成 SOP gets the tool log of the answer before it; 試著問 lists shared-room questions only', async () => {
  await withServer(async ({ baseUrl, log }) => {
    process.env.FAKE_CLAUDE_TOOL = 'Read';
    process.env.FAKE_CLAUDE_RESULT = 'ok';
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ reply: '今天 DB2 排程都成功' });
    const first = msg('s1', ME, '@團隊小助理 DB2 今天排程有沒有失敗', '2026-11-02T02:05:00.000Z');
    seedRoom('lobby', [first]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: first.at, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    const save = msg('s2', ME, '@團隊小助理 把剛剛這段存成 SOP', '2026-11-02T02:06:00.000Z');
    seedRoom('lobby', [...roomMessages('lobby'), save]);
    await post(baseUrl, { roomId: 'lobby', triggerAt: save.at, profileId: ME });
    await waitIdle(baseUrl, 'lobby');
    const prompt = (await calls(log)).at(-1)!.prompt;
    // 來源日期＝工具紀錄實際記下的日期（record.at，執行當下的 UTC 日期）。原本寫死 2026-11-02，只在寫測試那天會過（V5 修正）。
    const source = /來源：(\d{4}-\d{2}-\d{2}) 工具紀錄/.exec(prompt);
    assert.ok(prompt.includes('實際跑過的步驟') && prompt.includes('1. [成功] Read：D:/x/a.md') && source, prompt.slice(-600));
    const recordedDays = [Date.now() - 60_000, Date.now()].map((ms) => new Date(ms).toISOString().slice(0, 10));
    assert.ok(recordedDays.includes(source![1]), `來源日期 ${source![1]} 應為工具紀錄執行當天 ${recordedDays.join('/')}`);
    assert.ok(prompt.includes('<<<資料開始'), 'chat history is fenced');

    seedRoom('dm:proj-me~dhc-assistant', [msg('d1', ME, '我的薪水單在哪裡呢', '2026-11-02T02:07:00.000Z'), { ...msg('d2', 'dhc-assistant', '在這', '2026-11-02T02:07:30.000Z'), replyTo: 'd1' }]);
    const examples = (await (await fetch(`${baseUrl}/examples`)).json()) as { data: { examples: string[] } };
    assert.equal(examples.data.examples.length, 4);
    assert.ok(examples.data.examples.includes('DB2 今天排程有沒有失敗'), 'a shared-room question that got an answer');
    assert.ok(!examples.data.examples.some((text) => text.includes('薪水')), 'private chats are never examples');
  });
});
