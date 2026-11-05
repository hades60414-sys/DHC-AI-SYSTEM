import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import { StickyNoteBox } from '@/modules/chat-room/StickyNotes';
import type { StickyNote } from '@/shared/chatRoom';

/** 11/01: a sticky note's colour dots and 刪除 are hover-only; on a touch screen they show while the note is selected and are bigger. */

const note = {
  id: 'n1', target: { kind: 'session', id: 's1', title: '' }, by: 'amy', text: '提醒', refs: [], color: 'yellow', w: 220, h: 140, at: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z',
} as StickyNote;
const press = (el: Element) => fireEvent(el, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));

test('tools show on touch once the note is tapped, hide again when something else is tapped, and have large targets', () => {
  render(<div><StickyNoteBox note={note} left={0} top={0} context={null} onMove={vi.fn()} /><p>別處</p></div>);
  const tools = () => screen.getByRole('button', { name: '刪除便利貼' }).parentElement as HTMLElement;
  assert.ok(!tools().className.includes('pointer:coarse)]:opacity-100'), 'hidden before it is tapped');
  press(screen.getByTestId('sticky-note'));
  assert.ok(tools().className.includes('pointer:coarse)]:opacity-100'), 'visible while selected');
  assert.match(screen.getByRole('button', { name: '顏色 pink' }).className, /pointer:coarse\)\]:h-6/);
  assert.match(screen.getByRole('button', { name: '刪除便利貼' }).className, /pointer:coarse\)\]:p-2/);
  press(screen.getByText('別處'));
  assert.ok(!tools().className.includes('pointer:coarse)]:opacity-100'), 'hidden again after tapping elsewhere');
});
