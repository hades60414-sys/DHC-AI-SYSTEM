import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as PersonTodosModule from '@/shared/personTodos';
import type { TodoItem } from '@/shared/personTodos';

/** 10/15 垃圾桶: shows only while a task is dragged; a drop deletes it with its subtasks, 復原 puts them back. */

const todos = vi.hoisted(() => ({ items: [] as TodoItem[] }));
const calls = vi.hoisted(() => [] as string[]);
vi.mock('@/shared/personTodos', async (importOriginal) => ({
  ...(await importOriginal<typeof PersonTodosModule>()),
  readPersonTodos: () => todos,
  removeTodo: (_p: string, id: string) => calls.push(`remove ${id}`),
  restoreTodos: (_p: string, items: TodoItem[]) => calls.push(`restore ${items.map((item) => item.id).join(',')}`),
}));

const { default: TodoTrash } = await import('@/modules/todo-dock/TodoTrash');
const TYPE = 'application/x-dhc-todo';
const item = (id: string, parentId?: string): TodoItem => ({ id, text: `任務${id}`, done: false, createdAt: '', today: false, ...(parentId ? { parentId } : {}) });
const transfer = (id: string) => ({ types: [TYPE], getData: (type: string) => (type === TYPE ? id : ''), dropEffect: '' });

afterEach(() => {
  calls.length = 0;
  vi.useRealTimers();
});

test('hidden until a task drag starts; dropping deletes it and 復原 restores it with its subtasks', async () => {
  todos.items = [item('a'), item('b', 'a'), item('c')];
  render(<TodoTrash personId="p1" />);
  assert.equal(screen.queryByRole('region', { name: '垃圾桶' }), null);

  const other = new Event('dragstart') as DragEvent;
  Object.defineProperty(other, 'dataTransfer', { value: { types: ['Files'] } });
  await act(async () => { window.dispatchEvent(other); await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(screen.queryByRole('region', { name: '垃圾桶' }), null, 'a file drag is not a task');

  const start = new Event('dragstart') as DragEvent;
  Object.defineProperty(start, 'dataTransfer', { value: { types: [TYPE] } });
  await act(async () => { window.dispatchEvent(start); await new Promise((r) => setTimeout(r, 5)); });
  const bin = screen.getByRole('region', { name: '垃圾桶' });
  fireEvent.dragOver(bin, { dataTransfer: transfer('a') });
  fireEvent.drop(bin, { dataTransfer: transfer('a') });
  assert.deepEqual(calls, ['remove a']);
  assert.match(screen.getByRole('status').textContent ?? '', /已刪除「任務a」與 1 個子任務/);

  fireEvent.click(screen.getByRole('button', { name: '復原' }));
  assert.deepEqual(calls, ['remove a', 'restore a,b']);
  assert.equal(screen.queryByRole('status'), null);
});

test('page mode: the bin sits over the docked list, not the window centre where the chat composer takes drops, and 復原 stays 8 seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  todos.items = [item('a')];
  render(<TodoTrash personId="p1" page />);
  const start = new Event('dragstart') as DragEvent;
  Object.defineProperty(start, 'dataTransfer', { value: { types: [TYPE] } });
  await act(async () => { window.dispatchEvent(start); await vi.advanceTimersByTimeAsync(5); });
  const bin = screen.getByRole('region', { name: '垃圾桶' });
  assert.ok(!bin.className.includes('left-1/2'), `bin must not be at the window centre, got "${bin.className}"`);
  fireEvent.drop(bin, { dataTransfer: transfer('a') });
  const bar = screen.getByRole('status');
  assert.ok(!bar.className.includes('left-1/2'));
  await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
  assert.ok(screen.getByRole('status'), 'still there after 7 s');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
  assert.equal(screen.queryByRole('status'), null, 'gone after 8 s');
});

test('a drag whose dragend never reaches the window (dragged chip re-rendered away) still ends on drop or the next mouse move', async () => {
  render(<TodoTrash personId="p1" />);
  const begin = async () => {
    const start = new Event('dragstart') as DragEvent;
    Object.defineProperty(start, 'dataTransfer', { value: { types: [TYPE] } });
    await act(async () => { window.dispatchEvent(start); await new Promise((r) => setTimeout(r, 5)); });
    assert.ok(screen.getByRole('region', { name: '垃圾桶' }));
  };
  await begin();
  await act(async () => { window.dispatchEvent(new Event('drop')); await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(screen.queryByRole('region', { name: '垃圾桶' }), null, 'drop elsewhere ends it');

  await begin();
  await act(async () => { window.dispatchEvent(new Event('mousemove')); await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(screen.queryByRole('region', { name: '垃圾桶' }), null, 'the next mouse move ends it');
});
