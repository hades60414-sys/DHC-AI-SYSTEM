import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

/**
 * DHC CLI 收納盒: boxes are labels over a project's sessions, saved in user_preferences under one key
 * per project. These tests hold the store to what the sidebar relies on: grouping, merging with
 * changes made on another device, and filing a new conversation into the box picked for it.
 */

const server: Record<string, unknown> = {};
const saves: Array<Record<string, unknown>> = [];

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () => ({ ok: true, json: async () => ({ success: true, preferences: structuredClone(server) }) }),
      savePreferences: async (updates: Record<string, unknown>) => {
        saves.push(updates);
        Object.assign(server, structuredClone(updates));
        return { ok: true, json: async () => ({ success: true }) };
      },
    },
  },
}));

const boxes = await import('@/shared/sessionBoxes');

const A = { id: 'a', name: '報表' };
const B = { id: 'b', name: '研究' };

test('sessions split into their boxes in the given order; the rest stay outside', () => {
  const state = { boxes: [A, B], assign: { s2: 'a', s4: 'b', s3: 'a' } };
  const sessions = ['s1', 's2', 's3', 's4', 's5'].map((id) => ({ id }));

  const { inBox, outside } = boxes.groupSessionsByBox(sessions, state);

  assert.deepEqual(inBox.get('a')?.map((s) => s.id), ['s2', 's3']);
  assert.deepEqual(inBox.get('b')?.map((s) => s.id), ['s4']);
  assert.deepEqual(outside.map((s) => s.id), ['s1', 's5']);
});

test('a stored assignment to a box that no longer exists is dropped when read', () => {
  const parsed = boxes.parseProjectBoxes({ boxes: [A], assign: { s1: 'a', s2: 'gone' } });

  assert.deepEqual(parsed, { boxes: [A], assign: { s1: 'a' } });
});

test('removing a box sends its sessions back outside and keeps the other boxes', () => {
  const next = boxes.withBoxRemoved({ boxes: [A, B], assign: { s1: 'a', s2: 'b' } }, 'a');

  assert.deepEqual(next, { boxes: [B], assign: { s2: 'b' } });
});

test('a move made here keeps the box another device added in the meantime', async () => {
  server['dhc.boxes:p1'] = { boxes: [A], assign: {} };
  await boxes.loadSessionBoxes();
  // Another device adds box B after this tab loaded.
  server['dhc.boxes:p1'] = { boxes: [A, B], assign: {} };

  boxes.moveSessionToBox('p1', 's1', 'a');

  assert.equal(boxes.readProjectBoxes('p1').assign.s1, 'a', 'shown at once, before the save returns');
  await vi.waitFor(() => assert.deepEqual(server['dhc.boxes:p1'], { boxes: [A, B], assign: { s1: 'a' } }));
  await vi.waitFor(() => assert.deepEqual(boxes.readProjectBoxes('p1').boxes, [A, B]));
});

test('two quick moves both reach the server', async () => {
  server['dhc.boxes:p2'] = { boxes: [A], assign: {} };
  await boxes.loadSessionBoxes();

  boxes.moveSessionToBox('p2', 's1', 'a');
  boxes.moveSessionToBox('p2', 's2', 'a');

  await vi.waitFor(() => assert.deepEqual(server['dhc.boxes:p2'], { boxes: [A], assign: { s1: 'a', s2: 'a' } }));
});

test('a new conversation lands in the box picked for it, once, and that box opens', async () => {
  server['dhc.boxes:p3'] = { boxes: [A], assign: {} };
  await boxes.loadSessionBoxes();
  boxes.setNewSessionBox('p3', 'a');

  boxes.fileNewSessionIntoBox('p3', 'new1');
  boxes.fileNewSessionIntoBox('p3', 'new2');

  const state = boxes.readProjectBoxes('p3');
  assert.equal(state.assign.new1, 'a');
  assert.equal(state.assign.new2, undefined, 'the pick is used up by the first conversation');
  await vi.waitFor(() => assert.deepEqual(server['dhc.boxes:p3'], { boxes: [A], assign: { new1: 'a' } }));
  assert.ok(JSON.parse(localStorage.getItem('dhc.boxesOpen') ?? '[]').includes('a'));
});

test('a deleted session leaves its box', async () => {
  server['dhc.boxes:p4'] = { boxes: [A], assign: { s9: 'a' } };
  await boxes.loadSessionBoxes();

  boxes.forgetSessionInBoxes('s9');

  await vi.waitFor(() => assert.deepEqual(server['dhc.boxes:p4'], { boxes: [A], assign: {} }));
});

test('creating a box ignores a blank name and trims the rest', async () => {
  assert.equal(boxes.addSessionBox('p5', '   '), null);

  const id = boxes.addSessionBox('p5', '  每日報表  ');

  assert.ok(id);
  await vi.waitFor(() => assert.deepEqual(server['dhc.boxes:p5'], { boxes: [{ id, name: '每日報表' }], assign: {} }));
  assert.ok(saves.every((update) => Object.keys(update).every((key) => key.startsWith('dhc.boxes:'))));
});
