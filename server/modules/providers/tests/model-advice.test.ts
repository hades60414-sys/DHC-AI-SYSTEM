import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import providerRouter from '@/modules/providers/provider.routes.js';

async function ask(body: unknown): Promise<Record<string, unknown>> {
  const app = express().use(express.json()).use('/api/providers', providerRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/providers/model-advice`, {
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-advice-'));
  const log = path.join(dir, 'judge.log');
  await writeFile(path.join(dir, 'judge.cjs'), judgeSource);
  process.env.MODEL_ADVICE_JUDGE = path.join(dir, 'judge.cjs');
  process.env.MODEL_ADVICE_SWITCH = path.join(dir, 'model-advice-on');
  process.env.FAKE_JUDGE_LOG = log;
  return { dir, log };
}

const recordingJudge = `exports.judge = async (task, input, opts) => {
  require('fs').appendFileSync(process.env.FAKE_JUDGE_LOG, JSON.stringify({ task, input, opts }) + '\\n');
  return { choice: process.env.FAKE_JUDGE_CHOICE || 'sonnet', confidence: 0.9, reason: '問答', source: 'haiku' };
};`;

test('without the switch file the advice is opus/off and the judge is never called', async () => {
  const { log } = await scratch(recordingJudge);
  const advice = await ask({ text: '介紹一下去識別機制', projectPath: 'C:\\Users\\demo\\DHC Workspace\\同事D', hasAttachment: false });
  assert.equal(advice.advice, 'opus');
  assert.equal(advice.source, 'off');
  await assert.rejects(readFile(log, 'utf8'));
});

test('with the switch on, the judge sees the first message and the project folder name', async () => {
  const { dir, log } = await scratch(recordingJudge);
  await writeFile(path.join(dir, 'model-advice-on'), '');
  const advice = await ask({ text: '介紹一下去識別機制', projectPath: 'C:\\Users\\demo\\DHC Workspace\\同事D', hasAttachment: true });
  assert.equal(advice.advice, 'sonnet');
  assert.equal(advice.source, 'haiku');
  assert.equal(typeof advice.ms, 'number');
  const call = JSON.parse((await readFile(log, 'utf8')).trim());
  assert.equal(call.task, 'session-model');
  assert.deepEqual(call.input, { text: '介紹一下去識別機制', project: '同事D', hasAttachment: true });
  assert.equal(call.opts.timeoutMs, 6000);
});

test('an unknown choice, a throwing judge and a judge slower than 6 s all answer opus', async () => {
  const unknown = await scratch(`exports.judge = async () => ({ choice: 'haiku', confidence: 1 });`);
  await writeFile(path.join(unknown.dir, 'model-advice-on'), '');
  assert.equal((await ask({ text: '嗨' })).advice, 'opus');

  const broken = await scratch(`exports.judge = async () => { throw new Error('boom'); };`);
  await writeFile(path.join(broken.dir, 'model-advice-on'), '');
  const failed = await ask({ text: '嗨' });
  assert.equal(failed.advice, 'opus');
  assert.equal(failed.source, 'error');

  const slow = await scratch(`exports.judge = () => new Promise((r) => setTimeout(() => r({ choice: 'sonnet', confidence: 1 }), 9000).unref());`);
  await writeFile(path.join(slow.dir, 'model-advice-on'), '');
  const started = Date.now();
  const late = await ask({ text: '嗨' });
  assert.equal(late.advice, 'opus');
  assert.equal(late.source, 'error');
  assert.ok(Date.now() - started < 8000);
});
