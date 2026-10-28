import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

/**
 * DHC CLI 10/13 規劃白板: boards are stored per person, and a save keeps boards edited on another device.
 */

const server = vi.hoisted(() => ({ prefs: {} as Record<string, unknown>, saves: [] as Record<string, unknown>[] }));
vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () => ({ ok: true, json: async () => ({ preferences: server.prefs }) }),
      savePreferences: async (updates: Record<string, unknown>) => {
        server.saves.push(updates);
        server.prefs = { ...server.prefs, ...updates };
        return { ok: true };
      },
    },
  },
}));

const { createBoardSaver, emptyBoard, loadBoards, parseBoards, parseEdges, parseNodes } = await import('@/shared/planBoards');

afterEach(() => {
  server.prefs = {};
  server.saves = [];
  vi.useRealTimers();
});

test('stored boards are read defensively: bad boxes dropped, arrows to missing boxes dropped', () => {
  const nodes = parseNodes([{ id: 'a', text: '抓資料', x: 10 }, { id: 'b' }, { text: 'no id' }, null]);
  assert.deepEqual(nodes.map((node) => node.id), ['a', 'b']);
  assert.equal(nodes[0].w, 200, 'default width');
  const edges = parseEdges([{ from: 'a', to: 'b' }, { from: 'a', to: 'zzz' }, { from: 'a', to: 'a' }], nodes);
  assert.equal(edges.length, 1);
  assert.deepEqual(parseBoards(null), []);
  assert.equal(parseBoards({ items: [{ id: 'x' }] })[0].name, '未命名白板');
  assert.deepEqual(parseBoards({ items: [{ id: 'x', elements: [{ id: 'e' }, null] }] })[0].elements, [{ id: 'e' }]);
});

test('a save keeps boards changed on another device and drops the deleted one', async () => {
  vi.useFakeTimers();
  const mine = { ...emptyBoard('我的'), updatedAt: '2026-10-13T06:00:00Z' };
  const other = { ...emptyBoard('另一台'), updatedAt: '2026-10-13T05:00:00Z' };
  const gone = { ...emptyBoard('要刪'), updatedAt: '2026-10-13T04:00:00Z' };
  server.prefs = { 'dhc.boards:p:p1': { items: [other, gone] } };
  const saver = createBoardSaver('p1', () => assert.fail('should save'));
  saver.save(mine);
  saver.remove(gone.id);
  await saver.flush();
  const saved = parseBoards(server.prefs['dhc.boards:p:p1']);
  assert.deepEqual(saved.map((board) => board.name), ['我的', '另一台']);
  assert.equal(server.saves.length, 1, 'one write for both changes');
});

test('boards belong to the profile; the first version\'s project-keyed boards are read only when the profile has none', async () => {
  const old = emptyBoard('舊位置');
  const mine = emptyBoard('我的');
  server.prefs = { 'dhc.boards:proj1': { items: [old] }, 'dhc.boardStyle:p:prof1': { currentItemStrokeColor: '#e03131' } };
  const first = await loadBoards('prof1', 'proj1');
  assert.deepEqual(first.boards.map((board) => board.name), ['舊位置']);
  assert.deepEqual(first.style, { currentItemStrokeColor: '#e03131' }, 'the last pen colour comes back');
  server.prefs['dhc.boards:p:prof1'] = { items: [mine] };
  assert.deepEqual((await loadBoards('prof1', 'proj1')).boards.map((board) => board.name), ['我的']);
  assert.deepEqual((await loadBoards('someone-else', null)).boards, [], 'another profile sees nothing');
});
