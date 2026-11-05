import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as PersonTodosModule from '@/shared/personTodos';
import type { TodoItem } from '@/shared/personTodos';

/** 10/18 審查 #6: Enter/Esc that confirms or cancels an input-method candidate must not add or finish a todo. */

const todos = vi.hoisted(() => ({ items: [] as TodoItem[] }));
const calls = vi.hoisted(() => [] as string[]);
vi.mock('@/shared/personTodos', async (importOriginal) => ({
  ...(await importOriginal<typeof PersonTodosModule>()),
  startPersonTodosSync: () => () => {},
  usePersonTodos: () => todos,
  addTodo: (_p: string, text: string) => Boolean(text.trim()) && calls.push(`add ${text}`) > 0,
  editTodo: (_p: string, id: string, text: string) => calls.push(`edit ${id} ${text}`),
}));

const { default: TodayTodoList } = await import('@/modules/todo-dock/TodayTodoList');
const { default: EisenhowerMatrix } = await import('@/modules/todo-dock/EisenhowerMatrix');
const item: TodoItem = { id: 't1', text: '舊字', done: false, createdAt: '2026-10-18T00:00:00Z', today: true };

afterEach(() => {
  todos.items = [];
  calls.length = 0;
});

test('今日待辦: the bottom add box ignores composing Enter, and the edit box does not finish on it', () => {
  todos.items = [item];
  render(<TodayTodoList personId="p1" />);
  fireEvent.click(screen.getByRole('button', { name: '在清單最下方新增' }));
  const add = screen.getByLabelText('新增任務到最下方');
  fireEvent.change(add, { target: { value: '買ㄇ' } });
  fireEvent.keyDown(add, { key: 'Enter', isComposing: true });
  assert.deepEqual(calls, []);
  fireEvent.keyDown(add, { key: 'Enter' });
  assert.deepEqual(calls, ['add 買ㄇ']);

  fireEvent.doubleClick(screen.getByText('舊字'));
  const edit = screen.getByLabelText('修改待辦');
  fireEvent.keyDown(edit, { key: 'Enter', isComposing: true });
  assert.equal(calls.length, 1, 'composing Enter did not save the edit');
  fireEvent.keyDown(edit, { key: 'Enter' });
  assert.equal(calls[1], 'edit t1 舊字');
});

test('全部待辦: a task edit does not finish on composing Enter', () => {
  todos.items = [{ ...item, today: false }];
  render(<EisenhowerMatrix personId="p1" personName="同事C" isMobile={false} onClose={() => {}} />);
  fireEvent.doubleClick(screen.getByText('舊字'));
  const edit = screen.getByLabelText('修改任務');
  fireEvent.keyDown(edit, { key: 'Enter', isComposing: true });
  assert.deepEqual(calls, []);
  fireEvent.keyDown(edit, { key: 'Enter' });
  assert.equal(calls[0], 'edit t1 舊字');
});
