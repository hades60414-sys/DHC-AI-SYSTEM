import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as CustomToolsModule from '@/shared/customTools';
import type { WorkItem } from '@/modules/tool-library/tools/projectBoardModel';
import type * as PersonTodosModule from '@/shared/personTodos';
import type { TodoItem } from '@/shared/personTodos';

/** DHC CLI 10/14 專案板: model helpers (parsing, briefs, gantt math) and one render of the window. */

const store = vi.hoisted(() => ({ data: null as unknown, saved: [] as unknown[] }));
vi.mock('@/shared/customTools', async (importOriginal) => ({
  ...(await importOriginal<typeof CustomToolsModule>()),
  loadToolData: async () => store.data,
  createToolSaver: () => ({ save: (value: unknown) => { store.saved.push(value); }, flush: async () => {} }),
}));

const todoStore = vi.hoisted(() => ({ items: [] as unknown[], added: [] as unknown[][], calls: [] as unknown[][] }));
vi.mock('@/shared/personTodos', async (importOriginal) => ({
  ...(await importOriginal<typeof PersonTodosModule>()),
  usePersonTodos: () => ({ items: todoStore.items }),
  readPersonTodos: () => ({ items: todoStore.items }),
  startPersonTodosSync: () => () => {},
  addTodo: (...args: unknown[]) => { todoStore.added.push(args); return true; },
  setTodoToday: (...args: unknown[]) => { todoStore.calls.push(['today', ...args]); },
  setTodoDone: (...args: unknown[]) => { todoStore.calls.push(['done', ...args]); },
  editTodo: (...args: unknown[]) => { todoStore.calls.push(['edit', ...args]); },
}));

const sheetRows = vi.hoisted(() => ({ rows: [] as string[][] }));
vi.mock('@/modules/tool-library/importers', () => ({
  readTextFile: (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  }),
  readSpreadsheetFile: async () => [{ name: 'Sheet1', rows: sheetRows.rows }],
}));

const model = await import('@/modules/tool-library/tools/projectBoardModel');
const { sendToTool } = await import('@/shared/toolHandoff');
const { default: ProjectBoard } = await import('@/modules/tool-library/tools/ProjectBoard');

// jsdom has no scrollIntoView (the AI chat panel calls it).
Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
  store.data = null;
  store.saved = [];
  todoStore.items = [];
  todoStore.added = [];
  todoStore.calls = [];
});

const item = (patch: Partial<WorkItem>): WorkItem => ({ ...model.emptyItem('x'), ...patch });

test('parseItems drops untitled entries, fixes swapped dates, bad columns and dangling dependencies', () => {
  const items = model.parseItems([
    { id: 'a', title: '一', start: '2026-10-20', end: '2026-10-10', column: 'nope', dependsOn: ['b', 'ghost', 'a'] },
    { id: 'b', title: '二', start: '2026-13-45' },
    { id: 'c', title: '  ' },
    'junk',
  ]);
  assert.deepEqual(items.map((entry) => entry.id), ['a', 'b']);
  assert.equal(items[0].start, '2026-10-10');
  assert.equal(items[0].end, '2026-10-20');
  assert.equal(items[0].column, 'todo');
  assert.deepEqual(items[0].dependsOn, ['b']);
  assert.equal(items[1].start, '');
  assert.deepEqual(model.parseItems('nope'), []);
  assert.deepEqual(model.parseBoards(null), []);
});

test('applyAiItems keeps handedAt for kept ids and refuses an empty list', () => {
  const previous = [item({ id: 'a', title: 'A', handedAt: '2026-10-14T01:00:00.000Z' })];
  const next = model.applyAiItems(previous, { items: [{ id: 'a', title: 'A2' }, { id: 'n1', title: 'new' }] });
  assert.equal(next?.[0].handedAt, '2026-10-14T01:00:00.000Z');
  assert.equal(next?.[1].handedAt, '');
  assert.equal(model.applyAiItems(previous, { items: [] }), null);
  assert.equal(model.applyAiItems(previous, null), null);
});

test('gantt layout: one-date items are one-day bars, undated go to unscheduled, today is inside the grid', () => {
  const items = [
    item({ id: 'a', title: 'A', start: '2026-10-14', end: '2026-10-16' }),
    item({ id: 'b', title: 'B', end: '2026-10-20' }),
    item({ id: 'c', title: 'C' }),
  ];
  const layout = model.ganttLayout(items, '2026-10-14', 1);
  assert.equal(layout.bars.length, 2);
  assert.equal(layout.bars[0].length, 3);
  assert.equal(layout.bars[1].length, 1);
  assert.deepEqual(layout.unscheduled.map((entry) => entry.id), ['c']);
  assert.equal(model.dateOfDay(layout.firstDay), '2026-10-13');
  assert.equal(layout.todayOffset, 1);
  assert.equal(layout.days, 9); // 10/13 .. 10/21
  assert.equal(model.ganttLayout([], '2026-10-14', 0).days, 1);
});

test('card and board briefs carry the title, note, board name, related cards and dependencies', () => {
  const board = {
    ...model.emptyBoard('月報'),
    items: [
      item({ id: 'a', title: '抓部位', note: '從 DB1', column: 'done' }),
      item({ id: 'b', title: '算風險', note: '用 VaR', start: '2026-10-15', end: '2026-10-16', dependsOn: ['a'] }),
    ],
  };
  const brief = model.cardBrief(board, board.items[1]);
  assert.match(brief, /月報/);
  assert.match(brief, /標題：算風險/);
  assert.match(brief, /用 VaR/);
  assert.match(brief, /前置工作：抓部位（完成）/);
  assert.match(brief, /2026-10-15 ~ 2026-10-16/);
  const whole = model.boardBrief(board);
  assert.match(whole, /【完成】/);
  assert.match(whole, /要等：抓部位/);
});

test('window shows the stored cards in their columns, switches to gantt, and hands a card to the AI after confirming', async () => {
  const today = model.todayText();
  store.data = {
    boards: [{
      id: 'b1',
      name: '月報',
      items: [
        { id: 'a', title: '抓部位', column: 'todo', start: today, end: today },
        { id: 'b', title: '寫說明', column: 'doing' },
      ],
    }],
  };
  const onStartWork = vi.fn();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<ProjectBoard profileId="p1" profileName="小明" isMobile={false} onClose={() => {}} onStartWork={onStartWork} />);

  await waitFor(() => assert.ok(screen.getByText('抓部位')));
  assert.ok(screen.getByTestId('column-todo').textContent?.includes('抓部位'));
  assert.ok(screen.getByTestId('column-doing').textContent?.includes('寫說明'));

  fireEvent.click(screen.getByRole('button', { name: '甘特圖' }));
  assert.ok(screen.getByTestId('bar-a'));
  assert.ok(screen.getByText('未排時程'));
  fireEvent.click(screen.getByRole('button', { name: '看板' }));

  fireEvent.click(screen.getByRole('button', { name: '交給 AI：抓部位' }));
  await waitFor(() => assert.equal(onStartWork.mock.calls.length, 1));
  assert.match(onStartWork.mock.calls[0][0], /標題：抓部位/);
  const saved = store.saved.at(-1) as { boards: Array<{ items: Array<{ id: string; column: string; handedAt: string }> }> };
  const handed = saved.boards[0].items.find((entry) => entry.id === 'a');
  assert.equal(handed?.column, 'ai');
  assert.ok(handed?.handedAt);
});

test('normalizeDate accepts slashes, dashes, dots and 民國 years; junk becomes empty', () => {
  assert.equal(model.normalizeDate('2026/10/14'), '2026-10-14');
  assert.equal(model.normalizeDate('2026-1-4'), '2026-01-04');
  assert.equal(model.normalizeDate('115/10/14'), '2026-10-14');
  assert.equal(model.normalizeDate('民國 115/10/14'), '2026-10-14');
  assert.equal(model.normalizeDate('2026-13-45'), '');
  assert.equal(model.normalizeDate('下週'), '');
});

test('itemsFromRows maps header columns by name, statuses to columns, and counts empty rows', () => {
  const result = model.itemsFromRows([
    ['項目', '備註', '開始', '到期', '狀態'],
    ['抓部位', '.41', '2026/10/14', '2026/10/20', '進行中'],
    ['', '', '', '', ''],
    ['寫說明', '', '115/10/21', '', '完成'],
    ['', 'x', '', '', ''],
    ['對帳', '', '', '', '不明'],
  ]);
  assert.equal(result.items.length, 3);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.items.map((entry) => entry.column), ['doing', 'done', 'todo']);
  assert.equal(result.items[0].note, '.41');
  assert.equal(result.items[0].end, '2026-10-20');
  assert.equal(result.items[1].start, '2026-10-21');
});

test('itemsFromRows without a recognisable header uses the first column and keeps the first row', () => {
  const result = model.itemsFromRows([['甲', 'a'], ['乙', 'b']]);
  assert.deepEqual(result.items.map((entry) => entry.title), ['甲', '乙']);
  assert.ok(result.items.every((entry) => entry.column === 'todo'));
});

test('itemsFromText strips bullets, numbers and checkboxes; [x] goes to 完成', () => {
  const result = model.itemsFromText('- 一\n* 二\n1. 三\n[ ] 四\n- [x] 五\n\n');
  assert.deepEqual(result.items.map((entry) => entry.title), ['一', '二', '三', '四', '五']);
  assert.equal(result.items[4].column, 'done');
  assert.equal(result.skipped, 2);
});

test('importing a spreadsheet file appends cards to the current board and says how many', async () => {
  store.data = { boards: [{ id: 'b1', name: '板', items: [{ id: 'a', title: '舊卡', column: 'todo' }], chat: [] }] };
  sheetRows.rows = [['標題', '狀態'], ['新卡一', '進行中'], ['', ''], ['新卡二', '']];
  render(<ProjectBoard profileId="p1" profileName="小明" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByText('舊卡')));
  fireEvent.change(screen.getByTestId('tool-import-input'), { target: { files: [new File(['x'], 'a.csv', { type: 'text/csv' })] } });
  await waitFor(() => assert.ok(screen.getByText('新卡一')));
  assert.ok(screen.getByText('舊卡'));
  assert.ok(screen.getByTestId('column-doing').textContent?.includes('新卡一'));
  assert.ok(screen.getByTestId('column-todo').textContent?.includes('新卡二'));
  assert.ok(screen.getByText(/匯入了 2 張卡片.*略過 1 列/));
});

test('importing a .txt list puts one card per line in 待辦', async () => {
  store.data = { boards: [{ id: 'b1', name: '板', items: [], chat: [] }] };
  render(<ProjectBoard profileId="p1" profileName="小明" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByTestId('tool-import-input')));
  fireEvent.change(screen.getByTestId('tool-import-input'), { target: { files: [new File(['- 買咖啡\n2. 開會\n'], 'list.txt', { type: 'text/plain' })] } });
  await waitFor(() => assert.ok(screen.getByText('買咖啡')));
  assert.ok(screen.getByTestId('column-todo').textContent?.includes('開會'));
});

const todo = (patch: Partial<TodoItem> & { id: string; text: string }): TodoItem => ({ done: false, createdAt: '', today: false, ...patch });

test('todoRows lists open to-dos as a tree and itemsFromTodos maps due, parent and skips duplicates', () => {
  const todos = [
    todo({ id: 'p', text: '月報', quadrant: 'q1', due: '2026-10-20' }),
    todo({ id: 'c', text: '抓部位', parentId: 'p' }),
    todo({ id: 'd', text: '做完了', done: true }),
    todo({ id: 'o', text: '另一件' }),
  ];
  const rows = model.todoRows(todos);
  assert.deepEqual(rows.map((row) => [row.todo.id, row.depth, row.quadrant]), [['p', 0, 'q1'], ['c', 1, 'q1'], ['o', 0, undefined]]);
  const cards = model.itemsFromTodos(todos, new Set(['p', 'c', 'd', 'o']), new Set(['o']));
  assert.deepEqual(cards.map((card) => card.todoId), ['p', 'c']);
  assert.equal(cards[0].end, '2026-10-20');
  assert.equal(cards[0].note, '', 'the link shows on the card, no note needed');
  assert.equal(cards[1].end, '');
  assert.match(cards[1].note, /屬於：月報/);
  assert.ok(cards.every((card) => card.column === 'todo'));
});

test('cards payload becomes a named board; an empty one is refused; todoId survives parsing', () => {
  const made = model.boardFromCardsPayload({ boardName: '流程', cards: [{ id: 'a', title: '一', note: 'n' }, { id: 'b', title: '二', dependsOn: ['a'], todoId: 't1' }] });
  assert.equal(made?.name, '流程');
  assert.deepEqual(made?.items[1].dependsOn, ['a']);
  assert.equal(made?.items[1].todoId, 't1');
  assert.equal(model.boardFromCardsPayload({ cards: [] }), null);
});

test('從待辦匯入 is disabled without a project; with one the picker pre-checks 今日待辦, shows 已在板上 and imports the checked ones', async () => {
  store.data = { boards: [{ id: 'b1', name: '板', items: [{ id: 'a', title: '已有卡', column: 'todo', todoId: 't2' }], chat: [] }] };
  todoStore.items = [
    todo({ id: 't1', text: '今日的事', today: true, quadrant: 'q1', due: '2026-10-20' }),
    todo({ id: 't2', text: '已有卡', today: true }),
    todo({ id: 't3', text: '以後再說' }),
  ];
  const first = render(<ProjectBoard profileId="p1" profileName="小明" projectId={null} isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByText('已有卡')));
  assert.equal((screen.getByRole('button', { name: /從待辦匯入/ }) as HTMLButtonElement).disabled, true);
  first.unmount();

  render(<ProjectBoard profileId="p1" profileName="小明" projectId="proj" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByText('已有卡')));
  fireEvent.click(screen.getByRole('button', { name: /從待辦匯入/ }));
  const dialog = screen.getByRole('dialog', { name: '從待辦匯入' });
  assert.ok(dialog.textContent?.includes('重要且緊急'));
  assert.ok(dialog.textContent?.includes('已在板上'));
  assert.equal((screen.getByLabelText('今日的事') as HTMLInputElement).checked, true);
  assert.equal((screen.getByLabelText('以後再說') as HTMLInputElement).checked, false);
  assert.equal((screen.getByLabelText('已有卡') as HTMLInputElement).disabled, true);
  fireEvent.click(screen.getByRole('button', { name: '全不選' }));
  assert.equal((within(dialog).getByRole('button', { name: /^匯入/ }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole('button', { name: '全選' }));
  fireEvent.click(within(dialog).getByRole('button', { name: '匯入 2 項' }));
  await waitFor(() => assert.ok(screen.getByText('從待辦匯入了 2 張卡片')));
  const saved = store.saved.at(-1) as { boards: Array<{ items: WorkItem[] }> };
  const added = saved.boards[0].items.filter((entry) => entry.todoId && entry.id !== 'a');
  assert.deepEqual(added.map((entry) => entry.todoId), ['t1', 't3']);
  assert.equal(added[0].end, '2026-10-20');
});

test('加到今日待辦 adds a to-do with the due date, and says so when the card already has one', async () => {
  store.data = { boards: [{ id: 'b1', name: '板', items: [
    { id: 'a', title: '新事', column: 'todo', end: '2026-10-20' },
    { id: 'b', title: '舊事', column: 'todo', todoId: 't1' },
  ], chat: [] }] };
  todoStore.items = [todo({ id: 't1', text: '舊事' })];
  render(<ProjectBoard profileId="p1" profileName="小明" projectId="proj" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByText('新事')));
  fireEvent.click(screen.getByRole('button', { name: '加到今日待辦：新事' }));
  assert.deepEqual(todoStore.added, [['proj', '新事 @2026-10-20', { today: true }]]);
  // A card linked to a to-do not on 今日待辦 offers 排進今日 instead (no second to-do).
  assert.equal(screen.queryByRole('button', { name: '加到今日待辦：舊事' }), null);
  fireEvent.click(screen.getByRole('button', { name: '排進今日待辦：舊事' }));
  assert.deepEqual(todoStore.calls, [['today', 'proj', 't1', true]]);
  assert.equal(todoStore.added.length, 1);
});

test('a linked card shows the to-do live (text, quadrant, due, 今日) and 完成 stays in step both ways', async () => {
  store.data = { boards: [{ id: 'b1', name: '板', items: [
    { id: 'a', title: '舊標題', column: 'todo', todoId: 't1', note: '來自待辦' },
    { id: 'b', title: '做完的', column: 'doing', todoId: 't2' },
  ], chat: [] }] };
  todoStore.items = [
    todo({ id: 't1', text: '待辦改過的名字', today: true, quadrant: 'q1', due: '2026-10-20' }),
    todo({ id: 't2', text: '做完的', done: true }),
  ];
  render(<ProjectBoard profileId="p1" profileName="小明" projectId="proj" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByText('待辦改過的名字')));
  const card = screen.getByText('待辦改過的名字').closest('[draggable]') as HTMLElement;
  assert.ok(within(card).getByText('今日'));
  assert.ok(within(card).getByText('到期 2026-10-20'));
  assert.equal(within(card).queryByText('來自待辦'), null, 'the old note is hidden');
  assert.ok(card.querySelector('[title^="重要且緊急"]'), 'quadrant marker');
  // t2 was ticked in 待辦: its card moved to 完成 by itself.
  await waitFor(() => assert.ok(within(screen.getByTestId('column-done')).getByText('做完的')));
  // Dragging t1's card to 完成 ticks the to-do.
  fireEvent.dragStart(card, { dataTransfer: { setData: () => {}, effectAllowed: 'move' } });
  fireEvent.drop(screen.getByTestId('column-done'), { dataTransfer: { getData: () => 'a' } });
  assert.deepEqual(todoStore.calls.at(-1), ['done', 'proj', 't1', true]);
});

test('a cards handoff creates a new board named after the whiteboard and says how many cards', async () => {
  store.data = { boards: [{ id: 'b1', name: '舊板', items: [], chat: [] }] };
  sendToTool({ tool: 'project-board', kind: 'cards', from: '規劃白板『流程』', payload: { boardName: '流程', cards: [{ id: 'x', title: '步驟一', note: '', dependsOn: [] }, { id: 'y', title: '步驟二', note: '', dependsOn: ['x'] }] } });
  render(<ProjectBoard profileId="p1" profileName="小明" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByText('步驟一')));
  assert.ok(screen.getByText('從規劃白板『流程』建立了 2 張卡片'));
  assert.equal((screen.getByLabelText('選擇專案板') as HTMLSelectElement).selectedOptions[0].textContent, '流程');
  const saved = store.saved.at(-1) as { boards: Array<{ name: string }> };
  assert.deepEqual(saved.boards.map((board) => board.name), ['流程', '舊板']);
});

test('gantt window starts on a Monday, lasts at least 4 weeks and extends to the latest end + 3 days', () => {
  // 2026-10-14 is a Wednesday; its Monday is 10-12.
  const empty = model.ganttWindow([], '2026-10-14');
  assert.equal(model.dateOfDay(empty.firstDay), '2026-10-12');
  assert.equal(empty.days, 28);
  const early = model.ganttWindow([item({ start: '2026-10-01', end: '2026-10-02' })], '2026-10-14');
  assert.equal(model.dateOfDay(early.firstDay), '2026-09-28');
  const late = model.ganttWindow([item({ start: '2026-10-14', end: '2026-12-01' })], '2026-10-14');
  assert.ok(late.firstDay + late.days - 1 >= model.dayNumber('2026-12-04'));
  assert.equal(late.days % 7, 0);
  assert.equal(model.ganttGrid([item({ id: 'u' })], '2026-10-14').unscheduled.length, 1);
  assert.equal(model.ganttDayWidth(100, 176, 28, 28), 28);
  assert.equal(model.ganttDayWidth(1176, 176, 28, 28), 35);
});

test('moving a span keeps its length, resizing never ends before the start, month boundaries roll over', () => {
  assert.deepEqual(model.moveSpan('2026-10-30', '2026-11-02', 3), { start: '2026-11-02', end: '2026-11-05' });
  assert.deepEqual(model.moveSpan('2026-03-01', '2026-03-03', -2), { start: '2026-02-27', end: '2026-03-01' });
  assert.deepEqual(model.resizeSpan('2026-10-10', '2026-10-12', -9), { start: '2026-10-10', end: '2026-10-10' });
  assert.deepEqual(model.resizeSpan('2026-10-30', '2026-10-31', 2), { start: '2026-10-30', end: '2026-11-02' });
  assert.equal(model.dayIndexAt(-5, 28, 28), 0);
  assert.equal(model.dayIndexAt(60, 28, 28), 2);
  assert.equal(model.dayIndexAt(9999, 28, 28), 27);
});

test('dropping an unscheduled chip on a day of the drop lane schedules it for that single day', async () => {
  store.data = { boards: [{ id: 'b1', name: '板', items: [{ id: 'a', title: '沒日期', column: 'todo' }], chat: [] }] };
  render(<ProjectBoard profileId="p1" profileName="小明" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByText('沒日期')));
  fireEvent.click(screen.getByRole('button', { name: '甘特圖' }));
  assert.ok(screen.getByText('拖到這裡排日期'));
  assert.ok(screen.getByText(/把下面的工作拖到日期上/));
  const chip = screen.getByText('沒日期').closest('button') as HTMLElement;
  const target = model.dateOfDay(model.ganttWindow([], model.todayText()).firstDay + 9);
  fireEvent.dragStart(chip, { dataTransfer: { setData: () => {}, effectAllowed: 'move' } });
  fireEvent.drop(screen.getByTestId(`drop-${target}`), { dataTransfer: { getData: () => 'a' } });
  await waitFor(() => assert.ok(screen.getByTestId('bar-a')));
  const saved = store.saved.at(-1) as { boards: Array<{ items: WorkItem[] }> };
  assert.equal(saved.boards[0].items[0].start, target);
  assert.equal(saved.boards[0].items[0].end, target);
});

test('scheduling a linked card in the 甘特圖 sets its to-do due date', async () => {
  store.data = { boards: [{ id: 'b1', name: '板', items: [{ id: 'a', title: '備份', column: 'todo', todoId: 't1' }], chat: [] }] };
  todoStore.items = [todo({ id: 't1', text: '備份論文' })];
  render(<ProjectBoard profileId="p1" profileName="小明" projectId="proj" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByText('備份論文')));
  fireEvent.click(screen.getByRole('button', { name: '甘特圖' }));
  const chip = screen.getByText('備份論文').closest('button') as HTMLElement;
  const day = model.dateOfDay(model.ganttWindow([], model.todayText()).firstDay + 9);
  fireEvent.dragStart(chip, { dataTransfer: { setData: () => {}, effectAllowed: 'move' } });
  fireEvent.drop(screen.getByTestId(`drop-${day}`), { dataTransfer: { getData: () => 'a' } });
  assert.deepEqual(todoStore.calls.at(-1), ['edit', 'proj', 't1', `備份論文 @${day}`]);
});
