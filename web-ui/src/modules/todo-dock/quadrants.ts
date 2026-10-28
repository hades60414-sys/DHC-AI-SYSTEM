import type { Quadrant, TodoItem } from '@/shared/personTodos';

/** In priority order (q1 first), which is also how a phone stacks them and how 今日待辦 sorts. */
export const QUADRANTS: ReadonlyArray<{ id: Quadrant; title: string; hint: string; dot: string; tint: string }> = [
  { id: 'q1', title: '重要且緊急', hint: '馬上做', dot: 'bg-red-500', tint: 'border-red-500/30 bg-red-500/[0.04]' },
  { id: 'q2', title: '重要不緊急', hint: '排時間做', dot: 'bg-blue-500', tint: 'border-blue-500/30 bg-blue-500/[0.04]' },
  { id: 'q3', title: '緊急不重要', hint: '找人做', dot: 'bg-amber-500', tint: 'border-amber-500/30 bg-amber-500/[0.04]' },
  { id: 'q4', title: '不重要不緊急', hint: '少做', dot: 'bg-gray-400', tint: 'border-gray-400/30 bg-gray-400/[0.04]' },
];

/** Desktop grid, row by row: important on top, urgent on the right next to the 今日待辦 column. */
export const DESKTOP_GRID: readonly Quadrant[] = ['q2', 'q1', 'q4', 'q3'];

export const quadrantMeta = (quadrant: Quadrant | undefined) => QUADRANTS.find((meta) => meta.id === quadrant);

/** Drag payload type shared by the matrix and the 今日待辦 drop area. */
export const TODO_DRAG_TYPE = 'application/x-dhc-todo';

export const isToday = (iso: string | undefined) => Boolean(iso) && new Date(iso as string).toDateString() === new Date().toDateString();

/** 「上層 › 上上層」, nearest first, for a subtask shown outside its parent's card. */
export function parentTrail(items: TodoItem[], item: TodoItem): string {
  const names: string[] = [];
  let parent = items.find((other) => other.id === item.parentId);
  while (parent && names.length < 2) {
    names.push(parent.text);
    parent = items.find((other) => other.id === parent?.parentId);
  }
  return names.join(' › ');
}
