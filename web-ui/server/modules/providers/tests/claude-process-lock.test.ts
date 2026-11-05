import assert from 'node:assert/strict';
import test from 'node:test';

import { acquireProcessLock } from '@/modules/providers/list/claude/claude-runtime.provider.js';

type ProcessLock = {
  setInstance: (instance: { close?: () => void }) => void;
  release: () => void;
  previous: boolean;
};
const acquire = acquireProcessLock as (key: string, options?: { log?: (message: string) => void; stopWaitMs?: number; killWaitMs?: number }) => Promise<ProcessLock>;

// DHC CLI 2026-10-24: 同一個 provider session 同時只能有一個 CLI 程序（見 acquireProcessLock）。
const quiet = () => undefined;

test('第一個啟動不用等，也不算有前一個程序', async () => {
  const lock = await acquire('s-first', { log: quiet });
  assert.equal(lock.previous, false);
  lock.release();
});

test('第二個啟動要等第一個程序結束（release）才放行', async () => {
  const a = await acquire('s-serial', { log: quiet });
  const order: string[] = [];
  const bPromise = acquire('s-serial', { log: quiet, stopWaitMs: 5000 }).then((b) => { order.push('b-start'); return b; });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(order, [], 'a 還沒結束，b 不可啟動');
  order.push('a-release' as never);
  a.release();
  const b = await bPromise;
  assert.deepEqual(order, ['a-release', 'b-start']);
  assert.equal(b.previous, true);
  b.release();
});

test('三個同時啟動排成一條隊，不會有兩個同時放行', async () => {
  const a = await acquire('s-queue', { log: quiet });
  let running = 0;
  let maxRunning = 0;
  const run = async () => {
    const l = await acquire('s-queue', { log: quiet, stopWaitMs: 5000 });
    running += 1; maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1; l.release();
  };
  const p = Promise.all([run(), run()]);
  await new Promise((r) => setTimeout(r, 30));
  a.release();
  await p;
  assert.equal(maxRunning, 1);
});

test('前一個程序卡住不退出：逾時後呼叫 close()，並記一行 log', async () => {
  const logs: string[] = [];
  const a = await acquire('s-stuck', { log: (m: string) => logs.push(m) });
  let closed = false;
  a.setInstance({ close: () => { closed = true; a.release(); } });
  const b = await acquire('s-stuck', { log: (m: string) => logs.push(m), stopWaitMs: 30, killWaitMs: 200 });
  assert.equal(closed, true);
  assert.ok(logs.some((m) => m.includes('s-stuck') && m.includes('waiting')));
  b.release();
});

test('close() 也沒用時仍會放行（不會永遠卡死），並記 log', async () => {
  const logs: string[] = [];
  const a = await acquire('s-dead', { log: quiet });
  a.setInstance({ close: () => undefined });
  const b = await acquire('s-dead', { log: (m: string) => logs.push(m), stopWaitMs: 20, killWaitMs: 20 });
  assert.ok(logs.some((m) => m.includes('starting anyway')));
  b.release();
  a.release();
});

test('release 後鎖自動清掉，不同 session 互不影響', async () => {
  const x = await acquire('s-x', { log: quiet });
  const y = await acquire('s-y', { log: quiet });
  assert.equal(y.previous, false);
  x.release();
  y.release();
  const x2 = await acquire('s-x', { log: quiet });
  assert.equal(x2.previous, false);
  x2.release();
});
