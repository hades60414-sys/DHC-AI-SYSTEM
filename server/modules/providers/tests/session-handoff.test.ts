import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import providerRouter from '@/modules/providers/provider.routes.js';
import {
  buildTakeoverPrompt,
  HANDOFF_WRITE_PROMPT,
  handoffSession,
  type HandoffDeps,
} from '@/modules/providers/services/session-handoff.service.js';

/** DHC CLI 10/24 長對話交接: the moment judge never fails; the handoff writes a note, then opens a new session. */

async function ask(body: unknown): Promise<Record<string, unknown>> {
  const app = express().use(express.json()).use('/api/providers', providerRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/providers/handoff-moment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  } finally {
    server.close();
  }
}

async function scratch(judgeSource: string): Promise<{ dir: string; log: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'handoff-'));
  const log = path.join(dir, 'judge.log');
  await writeFile(path.join(dir, 'judge.cjs'), judgeSource);
  process.env.HANDOFF_JUDGE = path.join(dir, 'judge.cjs');
  process.env.HANDOFF_SWITCH = path.join(dir, 'handoff-on');
  process.env.HANDOFF_DIR = path.join(dir, 'handoffs');
  process.env.FAKE_JUDGE_LOG = log;
  return { dir, log };
}

const recordingJudge = `exports.judge = async (task, input, opts) => {
  require('fs').appendFileSync(process.env.FAKE_JUDGE_LOG, JSON.stringify({ task, input, opts }) + '\\n');
  return { choice: process.env.FAKE_JUDGE_CHOICE || 'later', confidence: 0.9 };
};`;

test('without the switch file the moment is later/off and the judge is never called', async () => {
  const { log } = await scratch(recordingJudge);
  const moment = await ask({ lastUser: '好', lastAssistant: '做完了' });
  assert.deepEqual(moment, { choice: 'later', off: true });
  await assert.rejects(readFile(log, 'utf8'));
});

test('with the switch on, the judge sees both texts and its choice comes back', async () => {
  const { dir, log } = await scratch(recordingJudge);
  await writeFile(path.join(dir, 'handoff-on'), '');
  const moment = await ask({ lastUser: '好', lastAssistant: '你要 A 還是 B？' });
  assert.deepEqual(moment, { choice: 'later' });
  const call = JSON.parse((await readFile(log, 'utf8')).trim());
  assert.equal(call.task, 'handoff-moment');
  assert.deepEqual(call.input, { lastUser: '好', lastAssistant: '你要 A 還是 B？' });
});

test('an unknown choice, a throwing judge and an empty reply all answer now', async () => {
  const unknown = await scratch(`exports.judge = async () => ({ choice: 'maybe', confidence: 1 });`);
  await writeFile(path.join(unknown.dir, 'handoff-on'), '');
  assert.deepEqual(await ask({ lastUser: '好', lastAssistant: '完成' }), { choice: 'now' });

  const broken = await scratch(`exports.judge = async () => { throw new Error('boom'); };`);
  await writeFile(path.join(broken.dir, 'handoff-on'), '');
  assert.deepEqual(await ask({ lastUser: '好', lastAssistant: '完成' }), { choice: 'now' });
  assert.deepEqual(await ask({}), { choice: 'now' });
});

type Calls = { turns: Array<{ sessionId: string; content: string; options: Record<string, unknown> }>; created: string[]; renamed: string[][]; broadcast: string[] };

function fakeDeps(over: Partial<HandoffDeps> = {}, assistantText = '目標：交接測試'): { deps: HandoffDeps; calls: Calls } {
  const calls: Calls = { turns: [], created: [], renamed: [], broadcast: [] };
  let total = 10;
  const deps: HandoffDeps = {
    getSession: (id) => (id === 'old-1' ? { provider: 'claude', projectPath: 'D:\\proj', title: '月報' } : null),
    isRunning: () => false,
    resolveModel: async () => ({ model: 'opus[1m]', effort: 'medium' }),
    history: async () => ({
      total,
      messages: [
        { kind: 'text', role: 'user', content: '好' },
        { kind: 'text', role: 'assistant', content: assistantText },
        { kind: 'tool_use', role: 'assistant', content: '' },
      ],
    }),
    runTurn: async (sessionId, content, options) => {
      calls.turns.push({ sessionId, content, options });
      if (sessionId === 'old-1') total += 2;
      return { started: true, error: null };
    },
    createSession: (projectPath) => { calls.created.push(projectPath); return 'new-1'; },
    rename: (id, name) => { calls.renamed.push([id, name]); },
    broadcast: async (id) => { calls.broadcast.push(id); },
    ...over,
  };
  return { deps, calls };
}

test('handoff: the old session writes the note, a file is saved, the new session starts with the same run options', async () => {
  const { dir } = await scratch(recordingJudge);
  const { deps, calls } = fakeDeps();
  const result = await handoffSession('old-1', { permissionMode: 'plan' }, 7, deps, new Date(2026, 9, 24, 14, 5));

  assert.equal(result.newSessionId, 'new-1');
  assert.equal(result.handoffPath, path.join(dir, 'handoffs', 'old-1-202610241405.md'));
  assert.equal(await readFile(result.handoffPath, 'utf8'), '目標：交接測試\n');

  assert.equal(calls.turns.length, 2);
  assert.equal(calls.turns[0].sessionId, 'old-1');
  assert.equal(calls.turns[0].content, HANDOFF_WRITE_PROMPT);
  assert.equal(calls.turns[1].sessionId, 'new-1');
  assert.equal(calls.turns[1].content, buildTakeoverPrompt('old-1', result.handoffPath, '目標：交接測試'));
  for (const turn of calls.turns) {
    assert.equal(turn.options.model, 'opus[1m]');
    assert.equal(turn.options.effort, 'medium');
    assert.equal(turn.options.permissionMode, 'plan');
  }
  assert.deepEqual(calls.created, ['D:\\proj']);
  assert.deepEqual(calls.renamed, [['new-1', '月報（接手）']]);
  assert.deepEqual(calls.broadcast, ['new-1']);
});

test('handoff: without a permission mode from the page the CLI default (bypassPermissions) is used', async () => {
  await scratch(recordingJudge);
  const { deps, calls } = fakeDeps();
  await handoffSession('old-1', {}, null, deps);
  assert.equal(calls.turns[0].options.permissionMode, 'bypassPermissions');
});

for (const [name, over, message] of [
  ['an unknown session', { getSession: () => null }, /找不到/],
  ['a non-claude session', { getSession: () => ({ provider: 'codex', projectPath: 'D:\\p', title: '' }) }, /Claude/],
  ['a running session', { isRunning: () => true }, /執行中/],
  ['a turn that does not start', { runTurn: async () => ({ started: false, error: 'busy' }) }, /寫交接失敗/],
  ['a note that never appears (history did not grow)', { history: async () => ({ total: 10, messages: [{ kind: 'text', role: 'assistant', content: '舊的' }] }) }, /沒有寫出/],
  ['an empty note', { history: async () => ({ total: 99, messages: [] }) }, /沒有寫出/],
] as Array<[string, Partial<HandoffDeps>, RegExp]>) {
  test(`handoff: ${name} gives a readable error and opens no new session`, async () => {
    await scratch(recordingJudge);
    const { deps, calls } = fakeDeps(over);
    await assert.rejects(handoffSession('old-1', {}, null, deps), (error: Error) => message.test(error.message));
    assert.deepEqual(calls.created, []);
  });
}

test('handoff: an unexpected exception becomes a Chinese error, and a rename failure does not stop the handoff', async () => {
  await scratch(recordingJudge);
  const boom = fakeDeps({ resolveModel: async () => { throw new Error('disk'); } });
  await assert.rejects(handoffSession('old-1', {}, null, boom.deps), /交接失敗：disk/);

  const noRename = fakeDeps({ rename: () => { throw new Error('x'); } });
  const result = await handoffSession('old-1', {}, null, noRename.deps);
  assert.equal(result.newSessionId, 'new-1');
});
