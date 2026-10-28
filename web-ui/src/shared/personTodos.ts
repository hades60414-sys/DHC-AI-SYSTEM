import { useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

/**
 * DHC CLI 待辦: one to-do list per person (a workspace project is a person's folder). Lists live on the server
 * in user_preferences, one global key per project (`dhc.todos:<projectId>`), so every device shows the same list
 * and anything that reads auth.db — the 專案記憶 distiller, a night helper — can see what each person has on.
 * A save re-reads the server's copy and applies the same change, so an item added on another device stays.
 *
 * 10/06 艾森豪矩陣: a task can be split two levels down (parentId). A subtask with no quadrant of its own stays
 * bound to its parent's card; giving it a quadrant splits it out to that quadrant while it keeps its parent.
 * `today` puts any task, at any level, on 今日待辦. Items saved before 10/06 have no `today` and count as on it,
 * since that list is what 今日待辦 replaces.
 * 10/07: `todayRank` is the order dragged into 今日待辦; tasks never dragged follow, in quadrant order.
 * 10/13: optional `due` (local YYYY-MM-DD), typed as a trailing「@10/20」when adding or editing; `todayAt` is when
 * the task last went onto 今日待辦, so the list can ask about tasks left over from an earlier day.
 */
export type Quadrant = 'q1' | 'q2' | 'q3' | 'q4';
export type TodoItem = {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
  parentId?: string;
  quadrant?: Quadrant;
  today: boolean;
  todayRank?: number;
  todayAt?: string;
  due?: string;
};
export type PersonTodos = { items: TodoItem[] };

const KEY_PREFIX = 'dhc.todos:';
const QUADRANTS: readonly string[] = ['q1', 'q2', 'q3', 'q4'];
/** Root is 0; a task splits into subtasks (1), which split once more (2). */
export const MAX_TODO_DEPTH = 2;
const MAX_TEXT_LENGTH = 300;
const RELOAD_ON_FOCUS_MIN_MS = 30_000;
const EMPTY: PersonTodos = { items: [] };
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** A「@M/D」with no year that is further back than this is read as next year's date. */
const PAST_DUE_GRACE_DAYS = 60;
const DUE_TAG = /\s*@(?:(今天|明天|後天)|(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2}))\s*$/u;

const pad2 = (value: number) => String(value).padStart(2, '0');

/** Local calendar day as YYYY-MM-DD. */
export const dateKey = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD). */
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Pulls a trailing due tag off a task's text:「@10/20」「@2026/10/20」「@10-20」「@今天」「@明天」「@後天」.
 * `due` is undefined when there is no tag (or the date doesn't exist).
 */
export function splitDue(text: string, now = new Date()): { text: string; due?: string } {
  const match = DUE_TAG.exec(text);
  if (!match) return { text };
  const rest = text.slice(0, match.index);
  const [, word, year, month, day] = match;
  if (word) {
    const offset = { 今天: 0, 明天: 1, 後天: 2 }[word as '今天' | '明天' | '後天'];
    return { text: rest, due: dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)) };
  }
  const build = (y: number) => {
    const date = new Date(y, Number(month) - 1, Number(day));
    return date.getMonth() === Number(month) - 1 ? dateKey(date) : undefined;
  };
  let due = build(year ? Number(year) : now.getFullYear());
  if (due && !year && daysBetween(dateKey(now), due) < -PAST_DUE_GRACE_DAYS) due = build(now.getFullYear() + 1);
  return due ? { text: rest, due } : { text };
}

/** The task's text as it goes back into an edit box, due tag included so it can be changed or deleted. */
export function todoEditText(item: TodoItem): string {
  if (!item.due) return item.text;
  const [year, month, day] = item.due.split('-').map(Number);
  const sameYear = year === new Date().getFullYear();
  return `${item.text} @${sameYear ? '' : `${year}/`}${month}/${day}`;
}

/** Open, with a due date of today or earlier: it shows on 今日待辦 whether or not it was put there. */
export const isDueNow = (item: TodoItem, today = dateKey(new Date())) => !item.done && Boolean(item.due) && (item.due as string) <= today;

export function parsePersonTodos(value: unknown): PersonTodos {
  const raw = value && typeof value === 'object' ? (value as { items?: unknown }).items : null;
  if (!Array.isArray(raw)) return EMPTY;
  const items = raw.filter((item): item is TodoItem => (
    Boolean(item) && typeof (item as TodoItem).id === 'string' && typeof (item as TodoItem).text === 'string'
  )).map((item) => ({
    id: item.id,
    text: item.text,
    done: item.done === true,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    ...(typeof item.doneAt === 'string' ? { doneAt: item.doneAt } : {}),
    ...(typeof item.parentId === 'string' ? { parentId: item.parentId } : {}),
    ...(QUADRANTS.includes(item.quadrant as string) ? { quadrant: item.quadrant } : {}),
    today: typeof item.today === 'boolean' ? item.today : true,
    ...(typeof item.todayRank === 'number' ? { todayRank: item.todayRank } : {}),
    ...(typeof item.todayAt === 'string' ? { todayAt: item.todayAt } : {}),
    ...(typeof item.due === 'string' && DATE_KEY.test(item.due) ? { due: item.due } : {}),
  }));
  const byId = new Map(items.map((item) => [item.id, item]));
  // A parent deleted elsewhere (or a loop) must not hide its subtasks: they become tasks of their own.
  const orphaned = (item: TodoItem) => {
    const seen = new Set<string>();
    for (let parentId = item.parentId; parentId; parentId = byId.get(parentId)?.parentId) {
      if (!byId.has(parentId) || seen.has(parentId)) return true;
      seen.add(parentId);
    }
    return false;
  };
  return {
    items: items.map((item) => {
      if (!item.parentId || !orphaned(item)) return item;
      const { parentId: _drop, ...rest } = item;
      return rest;
    }),
  };
}

const findItem = (items: TodoItem[], id: string | undefined) => (id ? items.find((item) => item.id === id) : undefined);

export function todoDepth(items: TodoItem[], id: string): number {
  let depth = 0;
  for (let parentId = findItem(items, id)?.parentId; parentId && depth <= MAX_TODO_DEPTH; depth += 1) {
    parentId = findItem(items, parentId)?.parentId;
  }
  return depth;
}

export const todoChildren = (items: TodoItem[], id: string) => items.filter((item) => item.parentId === id);

/** Every task under `id`, at any level. */
export const todoDescendants = (items: TodoItem[], id: string): TodoItem[] =>
  todoChildren(items, id).flatMap((child) => [child, ...todoDescendants(items, child.id)]);

/** Levels below `id`: 0 for a task with no subtasks. */
const todoHeight = (items: TodoItem[], id: string): number =>
  Math.max(0, ...todoChildren(items, id).map((child) => 1 + todoHeight(items, child.id)));

/** The quadrant a task shows in: its own, else the one of the card it is bound to; undefined is 未分類. */
export function effectiveQuadrant(items: TodoItem[], id: string): Quadrant | undefined {
  let item = findItem(items, id);
  for (let level = 0; item && level <= MAX_TODO_DEPTH; level += 1) {
    if (item.quadrant) return item.quadrant;
    item = findItem(items, item.parentId);
  }
  return undefined;
}

/** A subtask split out to a quadrant shows as a card of its own; the rest ride inside their parent's card. */
export const isOwnCard = (item: TodoItem) => !item.parentId || Boolean(item.quadrant);

export function canNestTodo(items: TodoItem[], id: string, parentId: string): boolean {
  if (id === parentId || !findItem(items, id) || !findItem(items, parentId)) return false;
  if (todoDescendants(items, id).some((item) => item.id === parentId)) return false;
  return todoDepth(items, parentId) + 1 + todoHeight(items, id) <= MAX_TODO_DEPTH;
}

const patchItem = (state: PersonTodos, id: string, patch: (item: TodoItem) => TodoItem): PersonTodos => ({
  items: state.items.map((item) => (item.id === id ? patch(item) : item)),
});

const withoutQuadrant = ({ quadrant: _drop, ...rest }: TodoItem): TodoItem => rest;

const withoutParent = ({ parentId: _drop, ...rest }: TodoItem): TodoItem => rest;

const withoutTodayRank = ({ todayRank: _drop, ...rest }: TodoItem): TodoItem => rest;

/**
 * Drops the task on a quadrant: a subtask moved there splits out of its parent's card but keeps its parent.
 * Dropped on 未分類 (no quadrant), a subtask leaves its parent altogether.
 */
export const withTodoMoved = (state: PersonTodos, id: string, quadrant: Quadrant | undefined): PersonTodos =>
  patchItem(state, id, (item) => (quadrant ? { ...item, quadrant } : withoutQuadrant(withoutParent(item))));

/** Cuts a subtask loose from its parent; it stays in the quadrant it shows in now. */
export const withTodoUnlinked = (state: PersonTodos, id: string): PersonTodos => {
  const quadrant = effectiveQuadrant(state.items, id);
  return patchItem(state, id, (item) => (quadrant ? { ...withoutParent(item), quadrant } : withoutParent(item)));
};

/** Ties a split-out subtask back onto its parent's card. */
export const withTodoBound = (state: PersonTodos, id: string): PersonTodos =>
  patchItem(state, id, (item) => (item.parentId ? withoutQuadrant(item) : item));

/** Makes `id` a bound subtask of `parentId`; refused when it would loop or go past two levels down. */
export const withTodoNested = (state: PersonTodos, id: string, parentId: string): PersonTodos =>
  canNestTodo(state.items, id, parentId)
    ? patchItem(state, id, (item) => ({ ...withoutQuadrant(item), parentId }))
    : state;

export const withTodoToday = (state: PersonTodos, id: string, today: boolean, at?: string): PersonTodos =>
  patchItem(state, id, (item) => (
    today ? { ...item, today, ...(at && !item.today ? { todayAt: at } : {}) } : { ...withoutTodayRank(item), today }
  ));

/** Takes the given tasks off 今日待辦 (the 「全部移出今日」 answer to the leftover prompt). */
export const withTodayCleared = (state: PersonTodos, ids: string[]): PersonTodos => ({
  items: state.items.map((item) => (ids.includes(item.id) ? { ...withoutTodayRank(item), today: false } : item)),
});

/** Saves 今日待辦 in the order given; tasks not listed keep their place. */
export const withTodayOrder = (state: PersonTodos, ids: string[]): PersonTodos => ({
  items: state.items.map((item) => (ids.includes(item.id) ? { ...item, todayRank: ids.indexOf(item.id) } : item)),
});

export const withTodoAdded = (state: PersonTodos, item: TodoItem): PersonTodos => (
  state.items.some((existing) => existing.id === item.id) ? state : { items: [...state.items, item] }
);

export const withTodoDone = (state: PersonTodos, id: string, done: boolean, at: string): PersonTodos => ({
  items: state.items.map((item) => {
    if (item.id !== id) return item;
    const { doneAt: _drop, ...rest } = item;
    return done ? { ...rest, done: true, doneAt: at } : { ...rest, done: false };
  }),
});

/** Sets the text; the due date becomes `due`, so an edit without a tag clears it. */
export const withTodoEdited = (state: PersonTodos, id: string, text: string, due?: string): PersonTodos => ({
  items: state.items.map((item) => {
    if (item.id !== id) return item;
    const { due: _drop, ...rest } = item;
    return due ? { ...rest, text, due } : { ...rest, text };
  }),
});

/** Removes the task with all its subtasks, split out or not. */
export const withTodoRemoved = (state: PersonTodos, id: string): PersonTodos => {
  const gone = new Set([id, ...todoDescendants(state.items, id).map((item) => item.id)]);
  return { items: state.items.filter((item) => !gone.has(item.id)) };
};

/** Removes done tasks; a done task with an open subtask stays so the subtask keeps its place. */
export const withDoneCleared = (state: PersonTodos): PersonTodos => ({
  items: state.items.filter((item) => !item.done || todoDescendants(state.items, item.id).some((child) => !child.done)),
});

let byProject: ReadonlyMap<string, PersonTodos> = new Map();
let writesInFlight = 0;
let writeChain: Promise<void> = Promise.resolve();
let lastLoadAt = 0;
let lastAlertAt = 0;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function setPersonTodos(projectId: string, next: PersonTodos): void {
  const map = new Map(byProject);
  map.set(projectId, next);
  byProject = map;
  notify();
}

async function fetchPreferenceRows(): Promise<Record<string, unknown>> {
  const response = await api.user.preferences();
  if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
  const payload = (await response.json()) as { preferences?: unknown };
  return payload.preferences && typeof payload.preferences === 'object'
    ? payload.preferences as Record<string, unknown>
    : {};
}

export async function loadPersonTodos(): Promise<void> {
  lastLoadAt = Date.now();
  try {
    const rows = await fetchPreferenceRows();
    if (writesInFlight > 0) return;
    const next = new Map<string, PersonTodos>();
    for (const [key, value] of Object.entries(rows)) {
      if (key.startsWith(KEY_PREFIX)) next.set(key.slice(KEY_PREFIX.length), parsePersonTodos(value));
    }
    byProject = next;
    notify();
  } catch (error) {
    console.error('[PersonTodos] Failed to load to-dos:', error);
  }
}

/** Loads the lists now and whenever the tab comes back into view; returns the cleanup. */
export function startPersonTodosSync(): () => void {
  void loadPersonTodos();
  const reloadWhenVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadAt > RELOAD_ON_FOCUS_MIN_MS) {
      void loadPersonTodos();
    }
  };
  document.addEventListener('visibilitychange', reloadWhenVisible);
  return () => document.removeEventListener('visibilitychange', reloadWhenVisible);
}

function updatePersonTodos(projectId: string, change: (current: PersonTodos) => PersonTodos): Promise<void> {
  setPersonTodos(projectId, change(readPersonTodos(projectId)));
  writesInFlight += 1;
  writeChain = writeChain.then(async () => {
    try {
      const latest = parsePersonTodos((await fetchPreferenceRows())[KEY_PREFIX + projectId]);
      const next = change(latest);
      const response = await api.user.savePreferences({ [KEY_PREFIX + projectId]: next });
      if (!response.ok) throw new Error(`Failed to save to-dos (${response.status})`);
      if (writesInFlight === 1) setPersonTodos(projectId, next);
    } catch (error) {
      console.error('[PersonTodos] Failed to save to-dos:', error);
      if (Date.now() - lastAlertAt > 10_000) {
        lastAlertAt = Date.now();
        alert('待辦沒有存到伺服器，請重新整理頁面後再試一次。');
      }
    } finally {
      writesInFlight -= 1;
    }
  });
  return writeChain;
}

export function readPersonTodos(projectId: string): PersonTodos {
  return byProject.get(projectId) ?? EMPTY;
}

export function usePersonTodos(projectId: string): PersonTodos {
  return useSyncExternalStore(subscribe, () => readPersonTodos(projectId), () => EMPTY);
}

const cleanText = (text: string) => text.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT_LENGTH);

type NewTodoPlace = { parentId?: string; quadrant?: Quadrant; today?: boolean };

export function addTodo(projectId: string, text: string, place: NewTodoPlace = {}): boolean {
  const { text: body, due } = splitDue(text);
  const trimmed = cleanText(body);
  if (!trimmed) return false;
  if (place.parentId && todoDepth(readPersonTodos(projectId).items, place.parentId) >= MAX_TODO_DEPTH) return false;
  const createdAt = new Date().toISOString();
  const item: TodoItem = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: trimmed,
    done: false,
    createdAt,
    ...(place.parentId ? { parentId: place.parentId } : {}),
    ...(place.quadrant && !place.parentId ? { quadrant: place.quadrant } : {}),
    today: place.today === true,
    ...(place.today ? { todayAt: createdAt } : {}),
    ...(due ? { due } : {}),
  };
  void updatePersonTodos(projectId, (state) => withTodoAdded(state, item));
  return true;
}

export function moveTodo(projectId: string, id: string, quadrant: Quadrant | undefined): void {
  void updatePersonTodos(projectId, (state) => withTodoMoved(state, id, quadrant));
}

export function unlinkTodo(projectId: string, id: string): void {
  void updatePersonTodos(projectId, (state) => withTodoUnlinked(state, id));
}

export function bindTodo(projectId: string, id: string): void {
  void updatePersonTodos(projectId, (state) => withTodoBound(state, id));
}

export function nestTodo(projectId: string, id: string, parentId: string): boolean {
  if (!canNestTodo(readPersonTodos(projectId).items, id, parentId)) return false;
  void updatePersonTodos(projectId, (state) => withTodoNested(state, id, parentId));
  return true;
}

export function setTodoToday(projectId: string, id: string, today: boolean): void {
  const at = new Date().toISOString();
  void updatePersonTodos(projectId, (state) => withTodoToday(state, id, today, at));
}

export function clearToday(projectId: string, ids: string[]): void {
  void updatePersonTodos(projectId, (state) => withTodayCleared(state, ids));
}

export function reorderToday(projectId: string, ids: string[]): void {
  void updatePersonTodos(projectId, (state) => withTodayOrder(state, ids));
}

export function setTodoDone(projectId: string, id: string, done: boolean): void {
  const at = new Date().toISOString();
  void updatePersonTodos(projectId, (state) => withTodoDone(state, id, done, at));
}

export function editTodo(projectId: string, id: string, text: string): void {
  const { text: body, due } = splitDue(text);
  const trimmed = cleanText(body);
  if (trimmed) void updatePersonTodos(projectId, (state) => withTodoEdited(state, id, trimmed, due));
}

export function removeTodo(projectId: string, id: string): void {
  void updatePersonTodos(projectId, (state) => withTodoRemoved(state, id));
}

export function clearDoneTodos(projectId: string): void {
  void updatePersonTodos(projectId, withDoneCleared);
}
