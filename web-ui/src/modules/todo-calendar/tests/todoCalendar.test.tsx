import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as PersonTodosModule from '@/shared/personTodos';
import type { TodoItem } from '@/shared/personTodos';
import { dateKey, withTodoDue } from '@/shared/personTodos';
import type { Project } from '@/shared/types';

/**
 * DHC CLI 10/15 行事曆: the 待辦 list by due date. Dragging sets or clears `due`, typing into a day adds a task due
 * that day, ☀ puts a task on 今日待辦, and the handle counts overdue tasks.
 */

const todos = vi.hoisted(() => ({ items: [] as TodoItem[] }));
const calls = vi.hoisted(() => [] as string[]);
vi.mock('@/shared/personTodos', async (importOriginal) => ({
  ...(await importOriginal<typeof PersonTodosModule>()),
  usePersonTodos: () => todos,
  setTodoDue: (_p: string, id: string, due?: string) => calls.push(`due ${id} ${due ?? 'none'}`),
  setTodoToday: (_p: string, id: string, on: boolean) => calls.push(`today ${id} ${on}`),
  setTodoDone: (_p: string, id: string, done: boolean) => calls.push(`done ${id} ${done}`),
  addTodo: (_p: string, text: string, place: { due?: string }) => Boolean(text.trim()) && calls.push(`add ${text} ${place.due}`) > 0,
}));
vi.mock('@/modules/sidebar', () => ({
  isWorkspaceProject: () => true,
  isQueryProject: () => false,
}));

const { default: TodoCalendar } = await import('@/modules/todo-calendar/TodoCalendar');

const PEOPLE = [{ projectId: 'p1', name: 'p1', displayName: '同事C', fullPath: 'C:\\x\\同事C', sessions: [] }] as unknown as Project[];
const shift = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateKey(date);
};
const item = (id: string, text: string, extra: Partial<TodoItem> = {}): TodoItem => ({ id, text, done: false, createdAt: '', today: false, ...extra });

const dataTransfer = () => {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() { return [...store.keys()]; },
    effectAllowed: '',
    dropEffect: '',
  };
};

afterEach(() => {
  localStorage.clear();
  todos.items = [];
  calls.length = 0;
});

test('Escape and the close button close the window', () => {
  let closed = 0;
  render(<TodoCalendar projects={PEOPLE} isMobile={false} onClose={() => { closed += 1; }} />);
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: '收起行事曆' }));
  assert.equal(closed, 2);
});

test('dragging an unscheduled task onto a day sets its due date; dragging a chip to 未排期 clears it', () => {
  const target = shift(1);
  todos.items = [item('u', '沒期限的事'), item('d', '有期限的事', { due: shift(0) })];
  render(<TodoCalendar projects={PEOPLE} isMobile={false} onClose={() => {}} />);

  const unscheduled = screen.getByRole('region', { name: '未排期' });
  const row = within(unscheduled).getByText('沒期限的事').closest('li') as HTMLElement;
  const transfer = dataTransfer();
  fireEvent.dragStart(row, { dataTransfer: transfer });
  const [, month, day] = target.split('-').map(Number);
  const cell = screen.getAllByRole('gridcell').find((node) => node.getAttribute('aria-label')?.startsWith(`${month}月${day}日`)) as HTMLElement;
  fireEvent.dragOver(cell, { dataTransfer: transfer });
  fireEvent.drop(cell, { dataTransfer: transfer });
  assert.deepEqual(calls, [`due u ${target}`]);

  const chip = screen.getAllByText('有期限的事').find((node) => node.closest('[draggable="true"]')) as HTMLElement;
  const back = dataTransfer();
  fireEvent.dragStart(chip.closest('[draggable="true"]') as HTMLElement, { dataTransfer: back });
  fireEvent.dragOver(unscheduled, { dataTransfer: back });
  fireEvent.drop(unscheduled, { dataTransfer: back });
  assert.deepEqual(calls.slice(1), ['due d none']);
});

test('a task typed into the chosen day is added with that day as its due date, and ☀ puts a task on 今日待辦', () => {
  todos.items = [item('t', '今天的事', { due: shift(0) })];
  render(<TodoCalendar projects={PEOPLE} isMobile={false} onClose={() => {}} />);

  const day = screen.getByRole('region', { name: '這天的待辦' });
  fireEvent.click(within(day).getByRole('button', { name: '加到今日待辦 今天的事' }));
  fireEvent.change(within(day).getByRole('textbox', { name: '新增到這天' }), { target: { value: '寫週報' } });
  fireEvent.click(within(day).getByRole('button', { name: '新增' }));
  assert.deepEqual(calls, ['today t true', `add 寫週報 ${shift(0)}`]);
});

test('withTodoDue sets and clears only the due date', () => {
  const state = { items: [item('x', '文字', { due: '2026-10-01', today: true })] };
  assert.deepEqual(withTodoDue(state, 'x', '2026-10-20').items[0], { ...state.items[0], due: '2026-10-20' });
  const cleared = withTodoDue(state, 'x', undefined).items[0];
  assert.equal('due' in cleared, false);
  assert.equal(cleared.text, '文字');
});

test('double-clicking a day opens a box in that cell: Enter adds with that due date and stays open, Escape closes', () => {
  render(<TodoCalendar projects={PEOPLE} isMobile={false} onClose={() => {}} />);
  const target = shift(4);
  const [, month, day] = target.split('-').map(Number);
  const cell = screen.getAllByRole('gridcell').find((node) => node.getAttribute('aria-label')?.startsWith(`${month}月${day}日`)) as HTMLElement;
  fireEvent.doubleClick(cell);
  const box = within(cell).getByRole('textbox', { name: '在這天新增待辦' });
  fireEvent.change(box, { target: { value: '開會' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  assert.deepEqual(calls, [`add 開會 ${target}`]);
  assert.ok(within(cell).getByRole('textbox', { name: '在這天新增待辦' }), 'stays open for the next one');
  fireEvent.keyDown(within(cell).getByRole('textbox', { name: '在這天新增待辦' }), { key: 'Escape' });
  assert.equal(within(cell).queryByRole('textbox'), null);
});
