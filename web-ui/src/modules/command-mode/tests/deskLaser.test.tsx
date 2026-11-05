import assert from 'node:assert/strict';

import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import DeskLaser from '@/modules/command-mode/DeskLaser';
import type { DeskMark } from '@/modules/command-mode/protocol';

// jsdom 沒有 PointerEvent；補一個帶 pointerType／pointerId 的版本，事件欄位才會帶進去。
if (typeof window.PointerEvent === 'undefined') {
  class FakePointerEvent extends MouseEvent {
    pointerType: string;
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? 'mouse';
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.assign(window, { PointerEvent: FakePointerEvent });
}

const setup = () => {
  const marks: DeskMark[] = [];
  let clicks = 0;
  render(
    <>
      <button type="button" onClick={() => { clicks += 1; }}>切到別頁</button>
      <DeskLaser onMark={(m) => marks.push(m)} />
    </>,
  );
  return { marks, clicks: () => clicks, page: screen.getByText('切到別頁') };
};

test('on the desktop page, holding the right button draws a mark and the context menu is suppressed', () => {
  const { marks, page } = setup();
  fireEvent.pointerDown(page, { pointerType: 'mouse', button: 2, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(page, { pointerType: 'mouse', buttons: 2, clientX: 400, clientY: 200 });
  fireEvent.pointerUp(page, { pointerType: 'mouse', button: 2, clientX: 800, clientY: 300 });
  assert.equal(marks.length, 1);
  assert.equal(marks[0].shape, 'line');
  const menu = createEvent.contextMenu(page);
  fireEvent(page, menu);
  assert.equal(menu.defaultPrevented, true);
});

test('the left button is untouched: page buttons and links still work', () => {
  const { marks, page, clicks } = setup();
  const down = createEvent.pointerDown(page, { pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 });
  fireEvent(page, down);
  fireEvent.click(page);
  assert.equal(down.defaultPrevented, false);
  assert.equal(clicks(), 1);
  assert.equal(marks.length, 0);
  assert.equal(getComputedStyle(screen.getByTestId('command-mode-desk-laser')).pointerEvents === 'none' || screen.getByTestId('command-mode-desk-laser').className.includes('pointer-events-none'), true, 'the trail canvas never takes pointer events');
});
