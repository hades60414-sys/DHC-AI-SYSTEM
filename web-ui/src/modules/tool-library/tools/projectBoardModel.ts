import type { AssistMessage } from '@/shared/customTools';
import { effectiveQuadrant } from '@/shared/personTodos';
import type { Quadrant, TodoItem } from '@/shared/personTodos';

/** DHC CLI 10/14 專案板: the data kept per person, plus pure helpers (parsing, briefs, gantt date math). */

export const COLUMNS = [
  { id: 'todo', label: '待辦' },
  { id: 'doing', label: '進行中' },
  { id: 'ai', label: '交給 AI' },
  { id: 'done', label: '完成' },
] as const;
export type ColumnId = (typeof COLUMNS)[number]['id'];
const COLUMN_IDS = new Set<string>(COLUMNS.map((column) => column.id));
export const columnLabel = (id: ColumnId) => COLUMNS.find((column) => column.id === id)?.label ?? id;

export type WorkItem = {
  id: string;
  title: string;
  note: string;
  /** YYYY-MM-DD or ''. */
  start: string;
  end: string;
  column: ColumnId;
  dependsOn: string[];
  /** When it was handed to the AI (ISO), if ever. */
  handedAt: string;
  /** The to-do (personTodos id) this card was imported from, if any. */
  todoId?: string;
};

export type ProjectBoardData = {
  id: string;
  name: string;
  items: WorkItem[];
  chat: AssistMessage[];
  updatedAt: string;
};

const MAX_ITEMS = 300;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
const dateText = (value: unknown) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  return DATE_RE.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ? raw : '';
};

export function emptyItem(title: string, column: ColumnId = 'todo'): WorkItem {
  return { id: newId('c'), title, note: '', start: '', end: '', column, dependsOn: [], handedAt: '' };
}

export const emptyBoard = (name: string): ProjectBoardData => ({
  id: newId('b'), name, items: [], chat: [], updatedAt: new Date().toISOString(),
});

/** Items from stored data or from the AI: bad entries dropped, ids made unique, dependencies pointing at nothing removed. */
export function parseItems(value: unknown): WorkItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: WorkItem[] = [];
  for (const entry of value.slice(0, MAX_ITEMS)) {
    const raw = (entry ?? {}) as Record<string, unknown>;
    const title = text(raw.title, 200).trim();
    if (!title) continue;
    let id = text(raw.id, 40) || newId('c');
    if (seen.has(id)) id = newId('c');
    seen.add(id);
    let start = dateText(raw.start);
    let end = dateText(raw.end);
    if (start && end && end < start) [start, end] = [end, start];
    items.push({
      id,
      title,
      note: stripLegacyTodoNote(text(raw.note, 2000)),
      start,
      end,
      column: COLUMN_IDS.has(raw.column as string) ? raw.column as ColumnId : 'todo',
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((dep): dep is string => typeof dep === 'string') : [],
      handedAt: text(raw.handedAt, 40),
      ...(text(raw.todoId, 40) ? { todoId: text(raw.todoId, 40) } : {}),
    });
  }
  return items.map((item) => ({ ...item, dependsOn: [...new Set(item.dependsOn)].filter((dep) => dep !== item.id && seen.has(dep)) }));
}

export function parseBoards(value: unknown): ProjectBoardData[] {
  const raw = (value ?? {}) as { boards?: unknown };
  if (!Array.isArray(raw.boards)) return [];
  return raw.boards
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((entry) => typeof entry.id === 'string' && entry.id)
    .map((entry) => ({
      id: entry.id as string,
      name: text(entry.name, 80) || '未命名',
      items: parseItems(entry.items),
      chat: Array.isArray(entry.chat)
        ? entry.chat
          .map((item) => (item ?? {}) as Record<string, unknown>)
          .filter((item) => (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
          .map((item) => ({ role: item.role as 'user' | 'assistant', text: text(item.text, 4000) }))
        : [],
      updatedAt: text(entry.updatedAt, 40),
    }));
}

/** What the AI returned replaces the list; handedAt stays with items whose id it kept (the AI is not told about it). */
export function applyAiItems(previous: WorkItem[], result: unknown): WorkItem[] | null {
  const items = parseItems((result as { items?: unknown } | null)?.items);
  if (items.length === 0) return null;
  const handed = new Map(previous.map((item) => [item.id, item.handedAt]));
  const todoIds = new Map(previous.map((item) => [item.id, item.todoId]));
  return items.map((item) => {
    const todoId = item.todoId || todoIds.get(item.id);
    return { ...item, handedAt: item.handedAt || handed.get(item.id) || '', ...(todoId ? { todoId } : {}) };
  });
}

/** What the AI sees: the items without handedAt. */
export const aiContext = (board: ProjectBoardData, today: string) => ({
  boardName: board.name,
  today,
  items: board.items.map(({ handedAt: _handedAt, todoId: _todoId, ...rest }) => rest),
});

const dateRange = (item: WorkItem) => {
  if (item.start && item.end) return `${item.start} ~ ${item.end}`;
  if (item.start) return `${item.start} 起`;
  if (item.end) return `${item.end} 前`;
  return '';
};

const itemLine = (item: WorkItem, items: WorkItem[]) => {
  const parts = [`[${columnLabel(item.column)}] ${item.title}`];
  const range = dateRange(item);
  if (range) parts.push(`（${range}）`);
  const deps = item.dependsOn.map((id) => items.find((other) => other.id === id)?.title).filter(Boolean);
  if (deps.length > 0) parts.push(`，要等：${deps.join('、')}`);
  if (item.note.trim()) parts.push(`——${item.note.trim().replace(/\s+/g, ' ')}`);
  return `- ${parts.join('')}`;
};

/** One card handed to the AI: the card, what it waits for, and the other cards for context. */
export function cardBrief(board: ProjectBoardData, item: WorkItem): string {
  const waitingFor = item.dependsOn.map((id) => board.items.find((other) => other.id === id)).filter((dep): dep is WorkItem => Boolean(dep));
  const others = board.items.filter((other) => other.id !== item.id);
  const lines = [
    `請幫我完成專案板「${board.name}」裡的這一項工作：`,
    '',
    `標題：${item.title}`,
    `說明：${item.note.trim() || '（沒有補充說明）'}`,
  ];
  const range = dateRange(item);
  if (range) lines.push(`時程：${range}`);
  if (waitingFor.length > 0) lines.push(`前置工作：${waitingFor.map((dep) => `${dep.title}（${columnLabel(dep.column)}）`).join('、')}`);
  if (others.length > 0) lines.push('', '板上的其他工作（供你了解全貌，這次只做上面這一項）：', ...others.map((other) => itemLine(other, board.items)));
  lines.push('', '做完請說明改了什麼、怎麼驗證；有不確定的地方先問我。');
  return lines.join('\n');
}

/** The whole board as a work order. */
export function boardBrief(board: ProjectBoardData): string {
  const lines = [`請依專案板「${board.name}」的工作清單協助我推進，優先處理「交給 AI」欄的項目：`, ''];
  for (const column of COLUMNS) {
    const inColumn = board.items.filter((item) => item.column === column.id);
    if (inColumn.length === 0) continue;
    lines.push(`【${column.label}】`, ...inColumn.map((item) => itemLine(item, board.items)), '');
  }
  lines.push('做每一項前先說明打算怎麼做；有不確定的地方先問我。');
  return lines.join('\n');
}

// ---- gantt date math: dates are whole days counted from the Unix epoch, in UTC so daylight saving cannot shift them ----
const DAY_MS = 86_400_000;
export const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
export const dateOfDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
export const todayText = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

export type GanttBar = { item: WorkItem; offset: number; length: number };
export type GanttLayout = { firstDay: number; days: number; todayOffset: number; bars: GanttBar[]; unscheduled: WorkItem[] };

/** An item with only one date is a one-day bar; items with neither go under 未排時程. The grid always shows today. */
export function ganttLayout(items: WorkItem[], today: string, padding = 2): GanttLayout {
  const spans = items.filter((item) => item.start || item.end).map((item) => ({
    item,
    start: dayNumber(item.start || item.end),
    end: dayNumber(item.end || item.start),
  }));
  const todayDay = dayNumber(today);
  const first = Math.min(todayDay, ...spans.map((span) => span.start)) - padding;
  const last = Math.max(todayDay, ...spans.map((span) => span.end)) + padding;
  return {
    firstDay: first,
    days: last - first + 1,
    todayOffset: todayDay - first,
    bars: spans.map((span) => ({ item: span.item, offset: span.start - first, length: span.end - span.start + 1 })),
    unscheduled: items.filter((item) => !item.start && !item.end),
  };
}

/** The Monday on or before a day number (day 0 = 1970-01-01, a Thursday). */
export const mondayOfDay = (day: number) => day - ((((day + 3) % 7) + 7) % 7);
export const GANTT_MIN_DAYS = 28;

/** Gantt window: starts on the Monday of the earliest of this week and the earliest bar, lasts at least 4 weeks, covers the latest end + 3 days, rounded up to whole weeks. */
export function ganttWindow(items: WorkItem[], today: string, minDays = GANTT_MIN_DAYS): { firstDay: number; days: number } {
  const todayDay = dayNumber(today);
  const dated = items.filter((item) => item.start || item.end);
  const starts = dated.map((item) => dayNumber(item.start || item.end));
  const ends = dated.map((item) => dayNumber(item.end || item.start));
  const firstDay = mondayOfDay(Math.min(todayDay, ...starts));
  const last = Math.max(firstDay + minDays - 1, todayDay, ...ends.map((end) => end + 3));
  return { firstDay, days: Math.ceil((last - firstDay + 1) / 7) * 7 };
}

/** The layout the gantt view draws: bars and unscheduled like ganttLayout, over ganttWindow. */
export function ganttGrid(items: WorkItem[], today: string): GanttLayout {
  const { firstDay, days } = ganttWindow(items, today);
  return {
    firstDay,
    days,
    todayOffset: dayNumber(today) - firstDay,
    bars: items.filter((item) => item.start || item.end).map((item) => {
      const start = dayNumber(item.start || item.end);
      const end = dayNumber(item.end || item.start);
      return { item, offset: start - firstDay, length: end - start + 1 };
    }),
    unscheduled: items.filter((item) => !item.start && !item.end),
  };
}

/** Column width: at least minWidth, stretched so the days fill the space beside the label. */
export const ganttDayWidth = (containerWidth: number, labelWidth: number, days: number, minWidth: number) =>
  Math.max(minWidth, days > 0 ? Math.floor((containerWidth - labelWidth) / days) : minWidth);

/** Day index inside the window for a pixel offset from the grid's left edge, clamped to the window. */
export const dayIndexAt = (x: number, dayWidth: number, days: number) => Math.min(days - 1, Math.max(0, Math.floor(x / dayWidth)));

/** Move a span by whole days, keeping its length. */
export const moveSpan = (start: string, end: string, deltaDays: number) => ({
  start: dateOfDay(dayNumber(start) + deltaDays),
  end: dateOfDay(dayNumber(end) + deltaDays),
});

/** Change the end by whole days; never before the start. */
export const resizeSpan = (start: string, end: string, deltaDays: number) => ({
  start,
  end: dateOfDay(Math.max(dayNumber(start), dayNumber(end) + deltaDays)),
});

// ---- import: spreadsheet rows or a plain list become cards ----
export const MAX_BOARD_ITEMS = MAX_ITEMS;

/** 2026/10/14, 2026-10-14, 2026.10.14, 民國 115/10/14 -> yyyy-MM-dd; anything else -> ''. */
export function normalizeDate(value: string): string {
  const raw = value.trim().replace(/^民國\s*/, '民國').replace(/\s.*$/, '');
  const match = /^(民國)?(\d{2,4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(raw);
  if (!match) return '';
  let year = Number(match[2]);
  if (match[1] || year < 1000) year += 1911;
  const date = `${year}-${match[3].padStart(2, '0')}-${match[4].padStart(2, '0')}`;
  return dateText(date);
}

const headerRules: Array<{ key: 'title' | 'note' | 'start' | 'end' | 'column'; re: RegExp }> = [
  { key: 'title', re: /標題|工作|項目|title|task|name|名稱/i },
  { key: 'note', re: /說明|備註|note|desc/i },
  { key: 'start', re: /開始|start|起/i },
  { key: 'end', re: /結束|到期|end|due|止/i },
  { key: 'column', re: /狀態|欄|status|state/i },
];

export function columnFromText(value: string): ColumnId {
  const v = value.trim().toLowerCase();
  if (/完成|done|結案|closed|finish/.test(v)) return 'done';
  if (/進行|doing|progress|處理中|wip/.test(v)) return 'doing';
  if (/ai/.test(v)) return 'ai';
  return 'todo';
}

export type ImportResult = { items: WorkItem[]; skipped: number };

/** Header row matched by name; no match -> first column is the title and the first row is data. */
export function itemsFromRows(rows: string[][]): ImportResult {
  const nonEmpty = rows.filter((row) => row.some((cell) => cell.trim()));
  if (nonEmpty.length === 0) return { items: [], skipped: rows.length };
  const map: Partial<Record<'title' | 'note' | 'start' | 'end' | 'column', number>> = {};
  nonEmpty[0].forEach((cell, index) => {
    const rule = headerRules.find((r) => map[r.key] === undefined && r.re.test(cell.trim()));
    if (rule && cell.trim()) map[rule.key] = index;
  });
  const hasHeader = Object.keys(map).length > 0;
  if (!hasHeader) map.title = 0;
  else if (map.title === undefined) {
    const used = new Set(Object.values(map));
    const first = nonEmpty[0].findIndex((_, index) => !used.has(index));
    map.title = first >= 0 ? first : 0;
  }
  const items: WorkItem[] = [];
  let skipped = rows.length - nonEmpty.length;
  for (const row of hasHeader ? nonEmpty.slice(1) : nonEmpty) {
    const cell = (key: keyof typeof map) => (map[key] === undefined ? '' : (row[map[key] as number] ?? '').trim());
    const title = cell('title').slice(0, 200);
    if (!title) { skipped += 1; continue; }
    let start = normalizeDate(cell('start'));
    let end = normalizeDate(cell('end'));
    if (start && end && end < start) [start, end] = [end, start];
    items.push({ ...emptyItem(title, columnFromText(cell('column'))), note: cell('note').slice(0, 2000), start, end });
  }
  return { items, skipped };
}

/** One item per line; leading -, *, 1. and [ ] / [x] are stripped. */
export function itemsFromText(content: string): ImportResult {
  const lines = content.split(/\r?\n/);
  const items: WorkItem[] = [];
  let skipped = 0;
  for (const line of lines) {
    const done = /^\s*(?:[-*]\s*)?\[[xX]\]/.test(line);
    const title = line.replace(/^\s*(?:[-*•]\s+|\d+[.)、]\s+)?(?:\[[ xX]?\]\s*)?/, '').trim().slice(0, 200);
    if (!title) { skipped += 1; continue; }
    items.push(emptyItem(title, done ? 'done' : 'todo'));
  }
  return { items, skipped };
}

// ---- 待辦 <-> cards ----
export const QUADRANT_LABEL: Record<Quadrant, string> = {
  q1: '重要且緊急', q2: '重要不緊急', q3: '緊急不重要', q4: '不緊急不重要',
};

export type TodoRow = { todo: TodoItem; depth: number; quadrant?: Quadrant };

/** Open to-dos as a flat tree: subtasks follow their parent, indented. A subtask whose parent is done or gone stands at the top. */
export function todoRows(items: TodoItem[]): TodoRow[] {
  const open = items.filter((todo) => !todo.done);
  const ids = new Set(open.map((todo) => todo.id));
  const rows: TodoRow[] = [];
  const walk = (todo: TodoItem, depth: number) => {
    rows.push({ todo, depth, quadrant: effectiveQuadrant(items, todo.id) });
    for (const child of open.filter((other) => other.parentId === todo.id)) walk(child, depth + 1);
  };
  for (const todo of open.filter((other) => !other.parentId || !ids.has(other.parentId))) walk(todo, 0);
  return rows;
}

/** Cards in 待辦 for the picked to-dos (in list order); to-dos already on the board are skipped. */
export function itemsFromTodos(items: TodoItem[], pickedIds: ReadonlySet<string>, onBoard: ReadonlySet<string>): WorkItem[] {
  const byId = new Map(items.map((todo) => [todo.id, todo]));
  return todoRows(items)
    .filter(({ todo }) => pickedIds.has(todo.id) && !onBoard.has(todo.id))
    .map(({ todo }) => {
      const parent = todo.parentId ? byId.get(todo.parentId) : undefined;
      return {
        ...emptyItem(todo.text.slice(0, 200)),
        end: todo.due ?? '',
        note: parent ? `屬於：${parent.text}` : '',
        todoId: todo.id,
      };
    });
}

/**
 * A card linked to a to-do follows it: 待辦 done ⇒ card in 完成; 待辦 reopened while the card sits in 完成 ⇒ back to
 * 待辦. Returns the same array when nothing needs to move, so callers can skip a save.
 */
export function syncWithTodos(items: WorkItem[], todos: TodoItem[]): WorkItem[] {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  let changed = false;
  const next = items.map((item) => {
    const todo = item.todoId ? byId.get(item.todoId) : undefined;
    if (!todo) return item;
    if (todo.done && item.column !== 'done') { changed = true; return { ...item, column: 'done' as const }; }
    if (!todo.done && item.column === 'done') { changed = true; return { ...item, column: 'todo' as const }; }
    return item;
  });
  return changed ? next : items;
}

/** A note written by the first 從待辦匯入 (10/14 morning); the link itself now shows on the card. */
export const stripLegacyTodoNote = (note: string) => note.replace(/^來自待辦\n?/, '');

/** Cards handed over by another tool (kind 'cards'): { boardName?, cards: [{ id?, title, note?, dependsOn? }] }. */
export function boardFromCardsPayload(payload: unknown): { name: string; items: WorkItem[] } | null {
  const raw = (payload ?? {}) as { boardName?: unknown; cards?: unknown };
  const items = parseItems(raw.cards).slice(0, MAX_ITEMS);
  if (items.length === 0) return null;
  return { name: text(raw.boardName, 80).trim() || '匯入的專案板', items };
}
