import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

/**
 * DHC CLI 10/05 快閃任務 as a per-session ⚡: marks live in one user_preferences key. These tests hold the store
 * to merging with marks made on another device, filing a new conversation that was flagged before its first
 * send, and dropping the mark once the session is deleted.
 */

const server: Record<string, unknown> = {};

vi.mock('@/shared/api', () => ({
  api: {
    deleteSession: async () => ({ ok: true, status: 200 }),
    user: {
      preferences: async () => ({ ok: true, json: async () => ({ success: true, preferences: structuredClone(server) }) }),
      savePreferences: async (updates: Record<string, unknown>) => {
        Object.assign(server, structuredClone(updates));
        return { ok: true, json: async () => ({ success: true }) };
      },
    },
  },
}));

const flash = await import('@/shared/flashTasks');

const serverIds = () => [...(server['dhc.flashSessions'] as string[])].sort();

test('marking here keeps the mark another device added in the meantime', async () => {
  server['dhc.flashSessions'] = ['a'];
  await flash.loadFlashSessions();
  server['dhc.flashSessions'] = ['a', 'b'];

  await flash.setSessionFlash('c', true);

  assert.deepEqual(serverIds(), ['a', 'b', 'c']);
  assert.equal(flash.isFlashSessionId('b'), true);
});

test('turning the ⚡ off removes only that session', async () => {
  server['dhc.flashSessions'] = ['a', 'b'];
  await flash.loadFlashSessions();

  await flash.setSessionFlash('a', false);

  assert.deepEqual(serverIds(), ['b']);
  assert.equal(flash.isFlashSessionId('a'), false);
});

test('a new conversation flagged before its first send becomes a flash task once it has an id', async () => {
  server['dhc.flashSessions'] = [];
  await flash.loadFlashSessions();
  flash.setNewSessionFlash('p1', true);

  flash.fileNewSessionFlash('p2', 'other');
  flash.fileNewSessionFlash('p1', 'new1');
  await flash.setSessionFlash('noop', false);

  assert.deepEqual(serverIds(), ['new1']);
  // The flag is used up: the next new conversation in p1 starts as a normal one.
  flash.fileNewSessionFlash('p1', 'new2');
  await flash.setSessionFlash('noop', false);
  assert.deepEqual(serverIds(), ['new1']);
});

test('ending a flash session forgets its mark', async () => {
  server['dhc.flashSessions'] = ['x', 'y'];
  await flash.loadFlashSessions();

  await flash.endFlashSession('x');
  await flash.setSessionFlash('noop', false);

  assert.deepEqual(serverIds(), ['y']);
});

test('junk in the stored list is ignored', () => {
  assert.deepEqual([...flash.parseFlashIds(['a', 3, '', null, 'b'])], ['a', 'b']);
  assert.deepEqual([...flash.parseFlashIds('nope')], []);
});
