import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import MobileRailToggle from '@/modules/project-workspace/MobileRailToggle';
import { RAIL_OPEN_EVENT, setRailCount } from '@/shared/mobileRail';

afterEach(() => vi.restoreAllMocks());

test('漢堡展開後由近到遠：工具庫、待辦、設定（畫面上由右往左）', () => {
  render(<MobileRailToggle />);
  assert.equal(screen.queryByRole('menu'), null);
  fireEvent.click(screen.getByRole('button', { name: /選單/ }));
  const menu = screen.getByRole('menu');
  assert.ok(menu.className.includes('flex-row-reverse'));
  const labels = screen.getAllByRole('menuitem').map((el) => el.textContent);
  assert.deepEqual(labels, ['工具庫', '待辦', '快速設定']);
});

test('聊天室是獨立鈕、自己顯示未讀；漢堡數字不含聊天室', () => {
  const stopChat = setRailCount('chat', 3);
  const stopTodo = setRailCount('todo', 2);
  render(<MobileRailToggle />);
  const chat = screen.getByRole('button', { name: '聊天室（3 則未讀）' });
  assert.equal(chat.textContent, '3');
  assert.equal(screen.getByRole('button', { name: /選單/ }).textContent, '2');
  act(() => stopChat());
  assert.ok(screen.getByRole('button', { name: '聊天室' }));
  act(() => stopTodo());
  assert.equal(screen.getByRole('button', { name: /選單/ }).textContent, '');
});

test('點待辦／工具庫送出開啟事件並收起；再按漢堡或點外面也會收起', () => {
  const seen: string[] = [];
  const onOpen = (e: Event) => seen.push((e as CustomEvent<string>).detail);
  window.addEventListener(RAIL_OPEN_EVENT, onOpen);
  render(<MobileRailToggle />);
  fireEvent.click(screen.getByRole('button', { name: /選單/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: '待辦' }));
  assert.deepEqual(seen, ['todo']);
  assert.equal(screen.queryByRole('menu'), null);
  fireEvent.click(screen.getByRole('button', { name: /選單/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: '工具庫' }));
  assert.deepEqual(seen, ['todo', 'library']);
  fireEvent.click(screen.getByRole('button', { name: /選單/ }));
  fireEvent.click(screen.getByRole('button', { name: '收起選單' }));
  assert.equal(screen.queryByRole('menu'), null);
  fireEvent.click(screen.getByRole('button', { name: /選單/ }));
  fireEvent.pointerDown(document.body);
  assert.equal(screen.queryByRole('menu'), null);
  window.removeEventListener(RAIL_OPEN_EVENT, onOpen);
});
