import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as PersonTodosModule from '@/shared/personTodos';
import type { TodoItem } from '@/shared/personTodos';
import type { Project } from '@/shared/types';
import { setDhcConfig } from '@/shared/dhcConfig';

/**
 * DHC CLI 10/05 待辦: moved out of the sidebar tabs to a right-edge handle like quick settings. On desktop the
 * opened list takes its own room beside the chat instead of floating over it; a phone has no room, so there it
 * slides over and a tap outside closes it.
 */

const todos = vi.hoisted(() => ({ items: [] as TodoItem[] }));
const calls = vi.hoisted(() => [] as string[]);
vi.mock('@/shared/personTodos', async (importOriginal) => ({
  ...(await importOriginal<typeof PersonTodosModule>()),
  startPersonTodosSync: () => () => {},
  usePersonTodos: () => todos,
  moveTodo: (_p: string, id: string, q?: string) => calls.push(`move ${id} ${q ?? 'inbox'}`),
  nestTodo: (_p: string, id: string, parent: string) => calls.push(`nest ${id} ${parent}`),
  bindTodo: (_p: string, id: string) => calls.push(`bind ${id}`),
  setTodoToday: (_p: string, id: string, on: boolean) => calls.push(`today ${id} ${on}`),
  reorderToday: (_p: string, ids: string[]) => calls.push(`order ${ids.join(',')}`),
  addTodo: (_p: string, text: string) => Boolean(text.trim()) && calls.push(`add ${text}`) > 0,
  setTodoDone: (_p: string, id: string, done: boolean) => calls.push(`done ${id} ${done}`),
  unlinkTodo: (_p: string, id: string) => calls.push(`unlink ${id}`),
  clearToday: (_p: string, ids: string[]) => calls.push(`clear ${ids.join(',')}`),
}));
vi.mock('@/modules/sidebar', () => ({
  isWorkspaceProject: () => true,
  isQueryProject: () => false,
}));

const { default: TodoDock } = await import('@/modules/todo-dock/TodoDock');

const person = (projectId: string, displayName: string) => (
  { projectId, name: projectId, displayName, fullPath: `C:\\Users\\demo\\DHC Workspace\\${displayName}`, sessions: [] }
) as unknown as Project;
const PEOPLE = [person('p1', '同事C'), person('p2', '同事A')];
const LIST = { name: '待辦清單' };

// Choosing whose list to see is a team feature (dhc.config.json "mode": "team").
beforeEach(() => setDhcConfig({ mode: 'team' }));

afterEach(() => {
  setDhcConfig({ mode: 'personal' });
  localStorage.clear();
  todos.items = [];
  calls.length = 0;
});

test('desktop: the handle opens the list in the page layout, with nothing laid over the chat, and it stays open after a reload', () => {
  const first = render(<TodoDock projects={PEOPLE} isMobile={false} />);
  assert.equal(screen.queryByRole('complementary', LIST), null);

  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));
  const panel = screen.getByRole('complementary', LIST);
  assert.ok(!/(^|\s)(fixed|absolute)(\s|$)/.test(panel.className), `docked panel must take room, got "${panel.className}"`);
  assert.equal(screen.queryByRole('button', { name: '關閉待辦清單' }), null, 'no backdrop on desktop');
  first.unmount();

  render(<TodoDock projects={PEOPLE} isMobile={false} />);
  assert.ok(screen.getByRole('complementary', LIST));
  fireEvent.click(screen.getByRole('button', { name: '收起待辦' }));
  assert.equal(screen.queryByRole('complementary', LIST), null);
});

test('phone: the list slides over the chat, a tap outside closes it, and it never opens by itself', () => {
  localStorage.setItem('dhc.todoDockOpen', '1');
  render(<TodoDock projects={PEOPLE} isMobile />);
  assert.equal(screen.queryByRole('complementary', LIST), null);

  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));
  assert.match(screen.getByRole('complementary', LIST).className, /(^|\s)fixed(\s|$)/);
  fireEvent.click(screen.getByRole('button', { name: '關閉待辦清單' }));
  assert.equal(screen.queryByRole('complementary', LIST), null);
});

test('personal mode: one list, no picker for whose to-dos', () => {
  setDhcConfig({ mode: 'personal' });
  todos.items = [{ id: 'a', text: '對帳', done: false, createdAt: '', today: true }];
  render(<TodoDock projects={PEOPLE} isMobile={false} />);
  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));

  assert.equal(screen.queryByRole('combobox', { name: '誰的待辦' }), null);
  assert.ok(screen.getByText('對帳'));
});

test("the handle counts only today's open to-dos of this device's person, and the list can switch person", () => {
  todos.items = [
    { id: 'a', text: '對帳', done: false, createdAt: '', today: true },
    { id: 'b', text: '寄日報', done: false, createdAt: '', today: true },
    { id: 'c', text: '已交', done: true, createdAt: '', today: true },
    { id: 'd', text: '只在矩陣', done: false, createdAt: '', today: false, quadrant: 'q2' },
  ];
  render(<TodoDock projects={PEOPLE} isMobile={false} />);
  assert.equal(screen.getByRole('button', { name: '打開待辦' }).textContent, '2');

  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));
  const select = screen.getByRole('combobox', { name: '誰的待辦' }) as HTMLSelectElement;
  assert.equal(select.value, 'p1');
  fireEvent.change(select, { target: { value: 'p2' } });
  assert.equal(localStorage.getItem('dhc.todosPerson'), 'p2');
  assert.ok(screen.getByText('對帳'));
  assert.equal(screen.queryByText('只在矩陣'), null, 'the dock lists today only');
});

const dataTransfer = () => {
  const data: Record<string, string> = {};
  return {
    data,
    get types() { return Object.keys(data); },
    setData: (type: string, value: string) => { data[type] = value; },
    getData: (type: string) => data[type] ?? '',
    effectAllowed: 'all',
  };
};
// The matrix marks the dragged card a tick after dragstart (changing the page inside dragstart cancels a Chrome drag).
const dragTo = async (card: HTMLElement, target: HTMLElement) => {
  const dt = dataTransfer();
  fireEvent.dragStart(card, { dataTransfer: dt });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  fireEvent.dragOver(target, { dataTransfer: dt });
  fireEvent.drop(target, { dataTransfer: dt });
};
const cardOf = (text: string) => screen.getAllByText(text)[0].closest('[draggable]') as HTMLElement;

test('the matrix opens from a button, shows bound and split-out subtasks, and moves cards by dragging', async () => {
  todos.items = [
    { id: 'a', text: '季報', done: false, createdAt: '', today: false, quadrant: 'q1' },
    { id: 'b', text: '撈資料', done: false, createdAt: '', today: true, parentId: 'a' },
    { id: 'c', text: '寫 SQL', done: false, createdAt: '', today: false, parentId: 'b' },
    { id: 'd', text: '排版', done: false, createdAt: '', today: false, parentId: 'a', quadrant: 'q3' },
    { id: 'e', text: '收信', done: false, createdAt: '', today: false, quadrant: 'q2' },
  ];
  render(<TodoDock projects={PEOPLE} isMobile={false} />);
  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));
  fireEvent.click(screen.getByRole('button', { name: '打開全部待辦' }));
  const matrix = screen.getByRole('dialog', { name: '全部待辦' });
  const q1 = within(matrix).getByRole('region', { name: '重要且緊急' });
  const q3 = within(matrix).getByRole('region', { name: '緊急不重要' });

  assert.ok(within(q1).getByText('寫 SQL'), 'level-2 subtask rides inside the card');
  assert.ok(within(q1).getByText(/已拆到緊急不重要：排版/));
  assert.ok(within(q3).getByText(/屬於 季報/));
  assert.equal(within(q1).queryByRole('button', { name: '拆子任務：寫 SQL' }), null, 'no third level');
  assert.ok(within(q1).getByRole('button', { name: '拆子任務：撈資料' }));

  await dragTo(cardOf('收信'), within(matrix).getByRole('region', { name: '不重要不緊急' }));
  await dragTo(cardOf('收信'), within(q1).getByText('季報'));
  await dragTo(cardOf('季報'), within(matrix).getByRole('complementary', { name: '今日待辦' }));
  fireEvent.click(within(q3).getByRole('button', { name: '綁回原卡：排版' }));
  fireEvent.click(within(q1).getByRole('button', { name: '匯入今日：季報' }));
  assert.deepEqual(calls, ['move e q4', 'nest e a', 'today a true', 'bind d', 'today a true']);

  fireEvent.keyDown(window, { key: 'Escape' });
  assert.equal(screen.queryByRole('dialog', { name: '全部待辦' }), null);
});

test('Escape inside a text box in the matrix does not close the matrix', () => {
  todos.items = [{ id: 'a', text: '季報', done: false, createdAt: '', today: false, quadrant: 'q1' }];
  render(<TodoDock projects={PEOPLE} isMobile={false} />);
  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));
  fireEvent.click(screen.getByRole('button', { name: '打開全部待辦' }));
  fireEvent.click(screen.getByRole('button', { name: '拆子任務：季報' }));
  fireEvent.keyDown(screen.getByRole('textbox', { name: '新增子任務到季報' }), { key: 'Escape' });
  assert.ok(screen.getByRole('dialog', { name: '全部待辦' }));
  assert.equal(screen.queryByRole('textbox', { name: '新增子任務到季報' }), null);
});

test('今日待辦 lists a task with its subtasks under it, each can be ticked off there, and none shows twice', () => {
  todos.items = [
    { id: 'a', text: '打磨待辦', done: false, createdAt: '', today: true, quadrant: 'q1' },
    { id: 'b', text: '加菱形', done: false, createdAt: '', today: true, parentId: 'a' },
    { id: 'c', text: '放大字', done: false, createdAt: '', today: false, parentId: 'a' },
    { id: 'd', text: '只有子任務上今日', done: false, createdAt: '', today: true, parentId: 'x' },
    { id: 'x', text: '上層', done: false, createdAt: '', today: false, quadrant: 'q2' },
  ];
  render(<TodoDock projects={PEOPLE} isMobile={false} />);
  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));
  const list = screen.getByRole('complementary', LIST);
  assert.equal(within(list).getAllByText('加菱形').length, 1, 'a subtask on today under a today parent shows once');
  fireEvent.click(within(list).getByRole('button', { name: '完成：放大字' }));
  assert.ok(within(list).getByText('↳ 上層'));
  assert.deepEqual(calls, ['done c true']);
});

test('a today row or a lone subtask drags into the chat with its open subtasks; a subtask never starts a reorder', () => {
  todos.items = [
    { id: 'a', text: '打磨待辦', done: false, createdAt: '', today: true, quadrant: 'q1' },
    { id: 'b', text: '矩陣改名', done: false, createdAt: '', today: false, parentId: 'a' },
    { id: 'c', text: '移動位置', done: false, createdAt: '', today: false, parentId: 'b' },
    { id: 'd', text: '已做完', done: true, createdAt: '', today: false, parentId: 'a' },
  ];
  render(<TodoDock projects={PEOPLE} isMobile={false} />);
  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));
  const list = screen.getByRole('complementary', LIST);
  const drag = (text: string) => {
    const data = new Map<string, string>();
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), effectAllowed: '' };
    fireEvent.dragStart(within(list).getByText(text).closest('[draggable]') as HTMLElement, { dataTransfer });
    return data;
  };
  const main = drag('打磨待辦');
  assert.equal(main.get('application/x-dhc-today'), 'a', 'a top-level row still reorders');
  assert.deepEqual(JSON.parse(main.get('application/x-dhc-todo-chat') ?? ''), { text: '打磨待辦', trail: '', subtasks: ['矩陣改名', '  移動位置'] });
  const sub = drag('矩陣改名');
  assert.equal(sub.has('application/x-dhc-today'), false);
  assert.deepEqual(JSON.parse(sub.get('application/x-dhc-todo-chat') ?? ''), { text: '矩陣改名', trail: '打磨待辦', subtasks: ['移動位置'] });
});

test('10/13: a 今日待辦 row, subtask too, drags onto a matrix quadrant to take its colour', async () => {
  todos.items = [
    { id: 'a', text: '打磨蒸餾', done: false, createdAt: '', today: true },
    { id: 'b', text: '去識別層', done: false, createdAt: '', today: false, parentId: 'x' },
    { id: 'x', text: '資安疑慮', done: false, createdAt: '', today: true, quadrant: 'q1' },
  ];
  render(<TodoDock projects={PEOPLE} isMobile={false} />);
  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));
  fireEvent.click(screen.getByRole('button', { name: '打開全部待辦' }));
  const matrix = screen.getByRole('dialog', { name: '全部待辦' });
  const today = within(matrix).getByRole('complementary', { name: '今日待辦' });
  const rowOf = (text: string) => within(today).getByText(text).closest('[draggable]') as HTMLElement;
  await dragTo(rowOf('打磨蒸餾'), within(matrix).getByRole('region', { name: '重要且緊急' }));
  await dragTo(rowOf('去識別層'), within(matrix).getByRole('region', { name: '緊急不重要' }));
  await dragTo(rowOf('打磨蒸餾'), rowOf('資安疑慮'));
  assert.deepEqual(calls, ['move a q1', 'move b q3', 'order a,x'], 'a reorder in the column does not also re-import');
});

test('a subtask dragged back to 未分類 leaves its parent; a split-out card has 獨立', async () => {
  todos.items = [
    { id: 'a', text: '季報', done: false, createdAt: '', today: false, quadrant: 'q1' },
    { id: 'b', text: '撈資料', done: false, createdAt: '', today: false, parentId: 'a' },
    { id: 'd', text: '排版', done: false, createdAt: '', today: false, parentId: 'a', quadrant: 'q3' },
  ];
  render(<TodoDock projects={PEOPLE} isMobile={false} />);
  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));
  fireEvent.click(screen.getByRole('button', { name: '打開全部待辦' }));
  const matrix = screen.getByRole('dialog', { name: '全部待辦' });
  await dragTo(cardOf('撈資料'), within(matrix).getByRole('complementary', { name: '未分類' }));
  fireEvent.click(within(matrix).getByRole('button', { name: '獨立：排版' }));
  assert.deepEqual(calls, ['move b inbox', 'unlink d']);
});

test('10/07: 今日待辦 rows drag into a new order, and ＋ on an empty box opens an input at the bottom', () => {
  todos.items = [
    { id: 'a', text: '對帳', done: false, createdAt: '', today: true, quadrant: 'q1' },
    { id: 'b', text: '寄日報', done: false, createdAt: '', today: true, quadrant: 'q2' },
    { id: 'c', text: '開會', done: false, createdAt: '', today: true, todayRank: 0 },
  ];
  render(<TodoDock projects={PEOPLE} isMobile={false} />);
  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));
  const rows = () => screen.getAllByText(/對帳|寄日報|開會/).map((node) => node.textContent);
  assert.deepEqual(rows(), ['開會', '對帳', '寄日報'], 'a dragged rank comes first, the rest by quadrant');

  const dt = dataTransfer();
  fireEvent.dragStart(cardOf('寄日報'), { dataTransfer: dt });
  fireEvent.dragOver(cardOf('開會'), { dataTransfer: dt, clientY: -1 });
  fireEvent.drop(cardOf('開會'), { dataTransfer: dt, clientY: -1 });
  assert.deepEqual(calls, ['order b,c,a']);

  assert.equal(screen.queryByRole('textbox', { name: '新增任務到最下方' }), null);
  fireEvent.click(screen.getByRole('button', { name: '在清單最下方新增' }));
  const bottom = screen.getByRole('textbox', { name: '新增任務到最下方' });
  const list = bottom.closest('ul')!;
  assert.equal(list.lastElementChild, bottom.closest('li'), 'the input sits under the last task');
  fireEvent.change(bottom, { target: { value: '補報表' } });
  fireEvent.keyDown(bottom, { key: 'Enter' });
  assert.deepEqual(calls.slice(1), ['add 補報表']);
  assert.equal((bottom as HTMLInputElement).value, '', 'stays open, emptied, for the next one');
  fireEvent.keyDown(bottom, { key: 'Escape' });
  assert.equal(screen.queryByRole('textbox', { name: '新增任務到最下方' }), null);
});

test('10/13: a task due today or overdue shows on top of 今日待辦 by itself; leftovers from earlier days are asked about once', () => {
  const day = (offset: number) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return date;
  };
  const key = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  todos.items = [
    { id: 'a', text: '對帳', done: false, createdAt: day(0).toISOString(), today: true, todayAt: day(0).toISOString() },
    { id: 'b', text: '舊的', done: false, createdAt: day(-3).toISOString(), today: true, todayAt: day(-3).toISOString() },
    { id: 'c', text: '交季報', done: false, createdAt: day(-1).toISOString(), today: false, due: key(day(-2)), quadrant: 'q2' },
    { id: 'd', text: '下週的', done: false, createdAt: day(0).toISOString(), today: false, due: key(day(7)) },
  ];
  render(<TodoDock projects={PEOPLE} isMobile={false} />);
  assert.equal(screen.getByRole('button', { name: '打開待辦' }).textContent, '3', 'the overdue task counts');
  fireEvent.click(screen.getByRole('button', { name: '打開待辦' }));
  const list = screen.getByRole('complementary', LIST);
  assert.deepEqual(within(list).getAllByText(/對帳|舊的|交季報|下週的/).map((node) => node.firstChild?.textContent), ['交季報', '對帳', '舊的']);
  assert.ok(within(list).getByText('過 2 天'));
  assert.equal(within(list).queryByRole('button', { name: '移出今日：交季報' }), null, 'a due task cannot be taken off today');

  assert.ok(within(list).getByText('之前留下 1 項還沒做完'));
  fireEvent.click(within(list).getByRole('button', { name: '全部移出今日' }));
  assert.deepEqual(calls, ['clear b']);
  assert.equal(within(list).queryByText('之前留下 1 項還沒做完'), null, 'asked once a day');
});
