import assert from 'node:assert/strict';

import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import LaserSurface from '@/modules/command-mode/LaserSurface';
import type { Stroke } from '@/modules/command-mode/strokes';

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

const FRAME = { id: 'f1', capturedAt: 0, width: 400, height: 300, dataUrl: 'data:image/jpeg;base64,/9j/AAAA' };

const setup = () => {
  const strokes: Stroke[] = [];
  let clicks = 0;
  render(
    <LaserSurface frame={FRAME} strokes={[]} onStroke={(s) => strokes.push(s)}>
      <button type="button" onClick={() => { clicks += 1; }}>底下的連結</button>
    </LaserSurface>,
  );
  const surface = screen.getByTestId('command-mode-laser');
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
  return { strokes, surface, clicks: () => clicks };
};

test('mouse right button draws a laser stroke and the browser context menu is suppressed', () => {
  const { strokes, surface } = setup();
  fireEvent.pointerDown(surface, { pointerType: 'mouse', button: 2, clientX: 40, clientY: 30, pointerId: 1 });
  fireEvent.pointerMove(surface, { pointerType: 'mouse', buttons: 2, clientX: 200, clientY: 90, pointerId: 1 });
  fireEvent.pointerUp(surface, { pointerType: 'mouse', button: 2, clientX: 360, clientY: 150, pointerId: 1 });
  assert.equal(strokes.length, 1);
  assert.equal(strokes[0].shape, 'line');
  assert.deepEqual(strokes[0].points.map((p) => [p.x, p.y]), [[0.1, 0.1], [0.5, 0.3], [0.9, 0.5]]);

  const menu = createEvent.contextMenu(surface);
  fireEvent(surface, menu);
  assert.equal(menu.defaultPrevented, true);
});

test('mouse left button is not a laser: the click reaches the content underneath', () => {
  const { strokes, surface, clicks } = setup();
  const button = screen.getByText('底下的連結');
  fireEvent.pointerDown(button, { pointerType: 'mouse', button: 0, clientX: 10, clientY: 10, pointerId: 2 });
  fireEvent.pointerUp(button, { pointerType: 'mouse', button: 0, clientX: 10, clientY: 10, pointerId: 2 });
  fireEvent.click(button);
  assert.equal(clicks(), 1);
  assert.equal(strokes.length, 0);
  void surface;
});

test('a finger draws as before', () => {
  const { strokes, surface } = setup();
  fireEvent.pointerDown(surface, { pointerType: 'touch', button: 0, clientX: 200, clientY: 150, pointerId: 3 });
  fireEvent.pointerUp(surface, { pointerType: 'touch', button: 0, clientX: 201, clientY: 150, pointerId: 3 });
  assert.equal(strokes.length, 1);
  assert.equal(strokes[0].shape, 'dot');
});
