import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

/**
 * DHC CLI 10/06 蒸餾模式: the composer's flask marks a session in one user_preferences key, like the ⚡. These
 * tests hold the store to merging with marks made on another device and filing a new conversation that was
 * flagged before its first send.
 */

const server: Record<string, unknown> = {};

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () => ({ ok: true, json: async () => ({ success: true, preferences: structuredClone(server) }) }),
      savePreferences: async (updates: Record<string, unknown>) => {
        Object.assign(server, structuredClone(updates));
        return { ok: true, json: async () => ({ success: true }) };
      },
    },
  },
}));

const distill = await import('@/shared/distillSessions');

const serverIds = () => [...(server['dhc.distillSessions'] as string[])].sort();

test('marking here keeps the mark another device added in the meantime', async () => {
  server['dhc.distillSessions'] = ['a'];
  await distill.loadDistillSessions();
  server['dhc.distillSessions'] = ['a', 'b'];

  await distill.setSessionDistill('c', true);

  assert.deepEqual(serverIds(), ['a', 'b', 'c']);
  assert.equal(distill.isDistillSessionId('b'), true);
});

test('turning the flask off removes only that session', async () => {
  server['dhc.distillSessions'] = ['a', 'b'];
  await distill.loadDistillSessions();

  await distill.setSessionDistill('a', false);

  assert.deepEqual(serverIds(), ['b']);
  assert.equal(distill.isDistillSessionId('a'), false);
});

test('a new conversation flagged before its first send starts in 蒸餾模式 once it has an id', async () => {
  server['dhc.distillSessions'] = [];
  await distill.loadDistillSessions();
  distill.setNewSessionDistill('p1', true);

  distill.fileNewSessionDistill('p2', 'other');
  distill.fileNewSessionDistill('p1', 'new1');
  await distill.setSessionDistill('noop', false);

  assert.deepEqual(serverIds(), ['new1']);
  // The flag is used up: the next new conversation in p1 starts as a normal one.
  distill.fileNewSessionDistill('p1', 'new2');
  await distill.setSessionDistill('noop', false);
  assert.deepEqual(serverIds(), ['new1']);
});

test('the note points the model at the rules file and the 結案 trigger', () => {
  assert.match(distill.DISTILL_SYSTEM_NOTE, /蒸餾任務\\README\.md/);
  assert.match(distill.DISTILL_SYSTEM_NOTE, /結案/);
});

test('junk in the stored list is ignored', () => {
  assert.deepEqual([...distill.parseDistillIds(['a', 3, '', null, 'b'])], ['a', 'b']);
  assert.deepEqual([...distill.parseDistillIds('nope')], []);
});
