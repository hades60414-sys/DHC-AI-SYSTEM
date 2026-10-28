import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import type { TodoItem as TodoItemShape } from '@/shared/personTodos';

/**
 * DHC CLI 待辦: one list per person under `dhc.todos:<projectId>`. The store must keep items another device
 * added, keep lists of different people apart, and survive junk in the stored value.
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

const todos = await import('@/shared/personTodos');

const texts = (projectId: string) =>
  todos.parsePersonTodos(server[`dhc.todos:${projectId}`]).items.map((item) => `${item.done ? '✓' : '·'}${item.text}`);

const flush = async () => {
  // Every write is chained; a no-op edit waits for the queue to drain.
  todos.editTodo('drain', 'missing', 'x');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await todos.loadPersonTodos();
};

test('an item added here keeps the item another device added in the meantime', async () => {
  server['dhc.todos:p1'] = { items: [{ id: 'a', text: '對帳', done: false, createdAt: '2026-10-05T01:00:00Z' }] };
  await todos.loadPersonTodos();
  server['dhc.todos:p1'] = {
    items: [
      { id: 'a', text: '對帳', done: false, createdAt: '2026-10-05T01:00:00Z' },
      { id: 'b', text: '寫日報', done: false, createdAt: '2026-10-05T02:00:00Z' },
    ],
  };

  assert.equal(todos.addTodo('p1', '  回測   參數  '), true);
  await flush();

  assert.deepEqual(texts('p1'), ['·對帳', '·寫日報', '·回測 參數']);
});

test('done, undo, edit, remove and clear-done each touch only their item and person', async () => {
  server['dhc.todos:p1'] = {
    items: [
      { id: 'a', text: 'A', done: false, createdAt: '' },
      { id: 'b', text: 'B', done: false, createdAt: '' },
      { id: 'c', text: 'C', done: false, createdAt: '' },
    ],
  };
  server['dhc.todos:p2'] = { items: [{ id: 'z', text: 'Z', done: false, createdAt: '' }] };
  await todos.loadPersonTodos();

  todos.setTodoDone('p1', 'a', true);
  todos.setTodoDone('p1', 'b', true);
  todos.setTodoDone('p1', 'b', false);
  todos.editTodo('p1', 'c', 'C2');
  await flush();
  assert.deepEqual(texts('p1'), ['✓A', '·B', '·C2']);
  assert.ok(todos.readPersonTodos('p1').items[0].doneAt);
  assert.equal(todos.readPersonTodos('p1').items[1].doneAt, undefined);

  todos.clearDoneTodos('p1');
  todos.removeTodo('p1', 'c');
  await flush();
  assert.deepEqual(texts('p1'), ['·B']);
  assert.deepEqual(texts('p2'), ['·Z']);
});

test('blank items are refused and junk in the stored value is dropped', () => {
  assert.equal(todos.addTodo('p3', '   '), false);
  assert.deepEqual(todos.parsePersonTodos({ items: [{ id: 'a', text: 'ok' }, { id: 1 }, null, 'x'] }).items, [
    { id: 'a', text: 'ok', done: false, createdAt: '', today: true },
  ]);
  assert.deepEqual(todos.parsePersonTodos('nope'), { items: [] });
});

const tree = (...items: Array<Partial<TodoItemShape> & { id: string }>) =>
  todos.parsePersonTodos({ items: items.map((item) => ({ text: item.id, createdAt: '', today: false, ...item })) });

test('10/06: items saved before the matrix land on 今日待辦; new ones only when asked', async () => {
  assert.equal(todos.parsePersonTodos({ items: [{ id: 'old', text: '舊' }] }).items[0].today, true);
  server['dhc.todos:p4'] = { items: [] };
  await todos.loadPersonTodos();
  todos.addTodo('p4', '放矩陣', { quadrant: 'q2' });
  todos.addTodo('p4', '今天做', { today: true });
  await flush();
  const saved = todos.readPersonTodos('p4').items;
  assert.deepEqual(saved.map((item) => [item.text, item.quadrant, item.today]), [['放矩陣', 'q2', false], ['今天做', undefined, true]]);
});

test('subtasks go two levels down and no further, and a split-out subtask keeps its parent', async () => {
  server['dhc.todos:p5'] = { items: [{ id: 'a', text: 'A', done: false, createdAt: '', quadrant: 'q1', today: false }] };
  await todos.loadPersonTodos();
  assert.equal(todos.addTodo('p5', 'B', { parentId: 'a' }), true);
  await flush();
  const b = todos.readPersonTodos('p5').items.find((item) => item.text === 'B')!;
  assert.equal(todos.addTodo('p5', 'C', { parentId: b.id }), true);
  await flush();
  const c = todos.readPersonTodos('p5').items.find((item) => item.text === 'C')!;
  assert.equal(todos.addTodo('p5', 'D', { parentId: c.id }), false, 'a third level is refused');

  let state = todos.readPersonTodos('p5');
  assert.equal(todos.effectiveQuadrant(state.items, c.id), 'q1', 'bound subtasks show in the parent card quadrant');
  state = todos.withTodoMoved(state, b.id, 'q3');
  assert.equal(state.items.find((item) => item.id === b.id)!.parentId, 'a');
  assert.equal(todos.effectiveQuadrant(state.items, c.id), 'q3', 'a split-out subtask takes its own subtasks along');
  assert.ok(todos.isOwnCard(state.items.find((item) => item.id === b.id)!));
  state = todos.withTodoBound(state, b.id);
  assert.equal(todos.effectiveQuadrant(state.items, b.id), 'q1');
});

test('nesting refuses loops and anything deeper than two levels', () => {
  const state = tree({ id: 'a' }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }, { id: 'x' }, { id: 'y', parentId: 'x' });
  assert.equal(todos.canNestTodo(state.items, 'a', 'c'), false, 'under its own subtask');
  assert.equal(todos.canNestTodo(state.items, 'x', 'b'), false, 'x has a subtask, so under b it would reach level 3');
  assert.equal(todos.canNestTodo(state.items, 'y', 'b'), true);
  assert.equal(todos.canNestTodo(state.items, 'x', 'a'), true);
  assert.equal(todos.withTodoNested(state, 'x', 'c'), state);
  const nested = todos.withTodoNested(tree({ id: 'a', quadrant: 'q1' }, { id: 'x', quadrant: 'q4' }), 'x', 'a');
  assert.deepEqual(nested.items.find((item) => item.id === 'x'), { id: 'x', text: 'x', done: false, createdAt: '', today: false, parentId: 'a' });
});

test('removing a task takes its subtasks; clearing done keeps a done task that still has open subtasks; orphans survive', () => {
  const state = tree({ id: 'a' }, { id: 'b', parentId: 'a', quadrant: 'q2' }, { id: 'c', parentId: 'b' }, { id: 'z' });
  assert.deepEqual(todos.withTodoRemoved(state, 'a').items.map((item) => item.id), ['z']);

  const done = tree({ id: 'a', done: true }, { id: 'b', parentId: 'a' }, { id: 'c', done: true }, { id: 'd', parentId: 'c', done: true });
  assert.deepEqual(todos.withDoneCleared(done).items.map((item) => item.id), ['a', 'b']);

  assert.equal(tree({ id: 'b', parentId: 'gone' }).items[0].parentId, undefined);
  assert.deepEqual(tree({ id: 'p', parentId: 'q' }, { id: 'q', parentId: 'p' }).items.map((item) => item.parentId), [undefined, undefined]);
});

test('a subtask dropped on 未分類 leaves its parent; 獨立 cuts it loose but keeps it where it shows', () => {
  const state = tree({ id: 'a', quadrant: 'q1' }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'a', quadrant: 'q3' });
  const toInbox = todos.withTodoMoved(state, 'b', undefined).items.find((item) => item.id === 'b')!;
  assert.equal(toInbox.parentId, undefined);
  assert.equal(toInbox.quadrant, undefined);
  const loose = todos.withTodoUnlinked(state, 'b').items.find((item) => item.id === 'b')!;
  assert.deepEqual([loose.parentId, loose.quadrant], [undefined, 'q1']);
  const split = todos.withTodoUnlinked(state, 'c').items.find((item) => item.id === 'c')!;
  assert.deepEqual([split.parentId, split.quadrant], [undefined, 'q3']);
});

test('10/07: the dragged order of 今日待辦 is saved and survives a reload; leaving today drops it', () => {
  const state = tree({ id: 'a', today: true }, { id: 'b', today: true }, { id: 'c', today: true });
  const ordered = todos.withTodayOrder(state, ['c', 'a']);
  assert.deepEqual(ordered.items.map((item) => item.todayRank), [1, undefined, 0]);
  assert.deepEqual(todos.parsePersonTodos(JSON.parse(JSON.stringify(ordered))).items.map((item) => item.todayRank), [1, undefined, 0]);
  const off = todos.withTodoToday(ordered, 'c', false).items.find((item) => item.id === 'c')!;
  assert.deepEqual([off.today, off.todayRank], [false, undefined]);
});

test('10/13: a trailing @date becomes the due date; edits keep, change or clear it', async () => {
  const now = new Date(2026, 9, 13, 12);
  assert.deepEqual(todos.splitDue('寄季報 @10/20', now), { text: '寄季報', due: '2026-10-20' });
  assert.deepEqual(todos.splitDue('寄季報 @2027/1/5', now), { text: '寄季報', due: '2027-01-05' });
  assert.deepEqual(todos.splitDue('寄季報@明天', now), { text: '寄季報', due: '2026-10-14' });
  assert.deepEqual(todos.splitDue('對帳 @10/1', now), { text: '對帳', due: '2026-10-01' }, 'recently past stays this year (overdue)');
  assert.deepEqual(todos.splitDue('年初盤點 @1/10', now), { text: '年初盤點', due: '2027-01-10' }, 'far past means next year');
  assert.deepEqual(todos.splitDue('寄給 a@b.com', now), { text: '寄給 a@b.com' });
  assert.deepEqual(todos.splitDue('寄 @2/30', now), { text: '寄 @2/30' }, 'no such day');

  todos.addTodo('pd', '寄季報 @10/20');
  await flush();
  const [item] = todos.parsePersonTodos(server['dhc.todos:pd']).items;
  assert.equal(item.text, '寄季報');
  assert.match(item.due ?? '', /^\d{4}-10-20$/);
  todos.editTodo('pd', item.id, '寄季報給主管');
  await flush();
  assert.equal(todos.parsePersonTodos(server['dhc.todos:pd']).items[0].due, undefined, 'an edit without the tag clears the date');
});

test('10/13: going onto today stamps todayAt once; clearToday takes tasks off', () => {
  const base = { items: [{ id: 'a', text: 'x', done: false, createdAt: '', today: false }] };
  const on = todos.withTodoToday(base, 'a', true, '2026-10-13T01:00:00Z');
  assert.equal(on.items[0].todayAt, '2026-10-13T01:00:00Z');
  assert.equal(todos.withTodoToday(on, 'a', true, '2026-10-14T01:00:00Z').items[0].todayAt, '2026-10-13T01:00:00Z');
  assert.equal(todos.withTodayCleared(on, ['a']).items[0].today, false);
});
