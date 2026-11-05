import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import BoardPicker from '@/modules/plan-board/BoardPicker';
import BoardShareDialog from '@/modules/plan-board/BoardShareDialog';
import type { PlanBoard } from '@/shared/planBoards';

/** 11/01 V3 fixes: renaming a board without double-click timing, the list clamped inside a phone window, and Co-Work closing on Esc / outside click. */

const board = (id: string, name: string) => ({ id, name, mode: 'free', nodes: [], edges: [] }) as unknown as PlanBoard;
const BOARDS = [board('a', '甲板'), board('b', '乙板')];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const picker = (over: Partial<React.ComponentProps<typeof BoardPicker>> = {}) => {
  const calls: string[] = [];
  render(
    <BoardPicker
      boards={BOARDS}
      active={BOARDS[0]}
      naming={false}
      onPick={(id) => calls.push(`pick ${id}`)}
      onCreate={() => calls.push('create')}
      onStartRename={() => calls.push('rename')}
      onRename={(name) => calls.push(`named ${name}`)}
      {...over}
    />,
  );
  return calls;
};

test('a double click 300 ms apart renames instead of opening the list (the list used to open at 220 ms)', () => {
  vi.useFakeTimers();
  const calls = picker();
  const name = screen.getByRole('button', { name: '選擇白板' });
  fireEvent.click(name, { detail: 1 });
  act(() => { vi.advanceTimersByTime(300); });
  assert.equal(screen.queryByRole('listbox'), null, 'still waiting for a possible second click');
  fireEvent.click(name, { detail: 2 });
  act(() => { vi.advanceTimersByTime(1000); });
  assert.deepEqual(calls, ['rename']);
  assert.equal(screen.queryByRole('listbox'), null);
});

test('a single click opens the list after the double-click window', () => {
  vi.useFakeTimers();
  picker();
  fireEvent.click(screen.getByRole('button', { name: '選擇白板' }), { detail: 1 });
  act(() => { vi.advanceTimersByTime(450); });
  assert.ok(screen.getByRole('listbox', { name: '白板清單' }));
});

test('each row has a pencil that picks that board and starts renaming it', () => {
  vi.useFakeTimers();
  const calls = picker();
  fireEvent.click(screen.getByRole('button', { name: '選擇白板' }), { detail: 1 });
  act(() => { vi.advanceTimersByTime(450); });
  fireEvent.click(screen.getByRole('button', { name: '改名：乙板' }));
  assert.deepEqual(calls, ['pick b', 'rename']);
  assert.equal(screen.queryByRole('listbox'), null);
});

test('the list is clamped inside a 390px window', () => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 300, right: 400, top: 10, bottom: 40, width: 100, height: 30, x: 300, y: 10, toJSON: () => ({}) });
  picker();
  fireEvent.click(screen.getByRole('button', { name: '選擇白板' }), { detail: 1 });
  act(() => { vi.advanceTimersByTime(450); });
  const left = parseFloat(screen.getByRole('listbox').style.left);
  assert.ok(left + 256 <= 390, `menu must end inside the window, left=${left}`);
  assert.ok(left >= 0);
});

const dialog = (onCancel: () => void) => render(
  <BoardShareDialog boardName="甲板" me="me" members={[]} people={new Map([['x', { name: '乙' }]])} onCancel={onCancel} onSave={async () => {}} />,
);

test('Co-Work invite dialog closes on Esc and on a click outside, not on a click inside', () => {
  const onCancel = vi.fn();
  dialog(onCancel);
  fireEvent.mouseDown(screen.getByLabelText('邀請留言'));
  assert.equal(onCancel.mock.calls.length, 0);
  fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Co-Work 白板' }));
  assert.equal(onCancel.mock.calls.length, 1);
  fireEvent.keyDown(screen.getByLabelText('邀請留言'), { key: 'Escape' });
  assert.equal(onCancel.mock.calls.length, 2);
});
