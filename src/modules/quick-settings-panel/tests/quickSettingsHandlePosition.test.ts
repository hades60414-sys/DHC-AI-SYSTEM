import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test } from 'vitest';

import { useQuickSettingsDrag } from '@/modules/quick-settings-panel/hooks/useQuickSettingsDrag';

/**
 * DHC：快速設定的把手在桌面預設放最低（跟輸入框同一排），不擋對話跳轉拉桿。舊版每次載入都把
 * 預設值 50 存進 localStorage，所以存的 50 要當成沒拖過；之後只有真的拖過才存。
 */

const KEY = 'quickSettingsHandlePosition';

beforeEach(() => {
  localStorage.clear();
});

test('desktop default sits at the bottom and is not written to storage', () => {
  const { result } = renderHook(() => useQuickSettingsDrag({ isMobile: false }));

  assert.equal(result.current.handleStyle.top, '90%');
  assert.equal(localStorage.getItem(KEY), null);
});

test('the 50 that old builds saved on every load counts as never dragged', () => {
  localStorage.setItem(KEY, JSON.stringify({ y: 50 }));

  const { result } = renderHook(() => useQuickSettingsDrag({ isMobile: false }));

  assert.equal(result.current.handleStyle.top, '90%');
});

test('a position the user dragged to is kept', () => {
  localStorage.setItem(KEY, JSON.stringify({ y: 72 }));

  const { result } = renderHook(() => useQuickSettingsDrag({ isMobile: false }));

  assert.equal(result.current.handleStyle.top, '72%');
});

test('mobile keeps the handle in the middle', () => {
  const { result } = renderHook(() => useQuickSettingsDrag({ isMobile: true }));

  assert.equal(result.current.handleStyle.bottom, `${window.innerHeight / 2}px`);
});

test('dragging moves the handle and saves where it was dropped', () => {
  const { result } = renderHook(() => useQuickSettingsDrag({ isMobile: false }));

  act(() => {
    result.current.startDrag({ type: 'mousedown', clientY: 600, stopPropagation: () => {} } as never);
  });
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 600 - window.innerHeight * 0.3 }));
  });
  act(() => {
    document.dispatchEvent(new MouseEvent('mouseup'));
  });

  const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { y: number };
  assert.ok(Math.abs(saved.y - 60) < 1e-6, `saved y = ${saved.y}`);
  assert.equal(result.current.handleStyle.top, `${saved.y}%`);
});
