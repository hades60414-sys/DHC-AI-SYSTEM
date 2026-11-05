import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import { StickyNoteBox } from '@/modules/chat-room/StickyNotes';
import type { StickyNote } from '@/shared/chatRoom';

/** 10/18 審查 #8: a cancelled or abandoned note drag commits nothing and leaves no window listeners behind. */

const note = {
  id: 'n1', target: { kind: 'session', id: 's1', title: '' }, by: 'amy', text: '提醒', refs: [], color: 'yellow', w: 220, h: 140, at: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z',
} as StickyNote;

const setup = () => {
  const onMove = vi.fn();
  const view = render(<StickyNoteBox note={note} left={10} top={10} context={null} onMove={onMove} />);
  const strip = view.container.querySelector('.cursor-grab') as HTMLElement;
  return { onMove, view, strip };
};
const pointer = (type: string, x: number, y: number) => window.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: y }));
// jsdom has no PointerEvent, so fireEvent.pointerDown drops button/clientX; a MouseEvent named pointerdown keeps them.
const press = (el: HTMLElement) => fireEvent(el, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }));

test('release commits the move', () => {
  const { onMove, strip } = setup();
  press(strip);
  pointer('pointermove', 30, 20);
  pointer('pointerup', 30, 20);
  assert.deepEqual(onMove.mock.calls.map((c) => [c[1], c[2]]), [[30, 20]]);
});

test('pointercancel drops the drag: no move is committed and a later pointerup does nothing', () => {
  const { onMove, strip } = setup();
  press(strip);
  pointer('pointermove', 30, 20);
  pointer('pointercancel', 30, 20);
  pointer('pointerup', 99, 99);
  assert.equal(onMove.mock.calls.length, 0);
});

test('unmounting mid-drag removes the listeners, so a later pointerup commits nothing', () => {
  const { onMove, view, strip } = setup();
  press(strip);
  pointer('pointermove', 30, 20);
  view.unmount();
  pointer('pointerup', 30, 20);
  assert.equal(onMove.mock.calls.length, 0);
});
