import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import { StickyNoteBox } from '@/modules/chat-room/StickyNotes';
import type { StickyNote } from '@/shared/chatRoom';

/** 10/19: whiteboard notes scale with the zoom so they stay pinned to the drawing; session notes stay unscaled. */

const note = {
  id: 'n1', target: { kind: 'board', id: 'b1', title: '' }, by: 'amy', text: '提醒', refs: [], color: 'yellow', w: 220, h: 140, at: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z',
} as StickyNote;
const box = (scale?: number) => render(<StickyNoteBox note={note} left={0} top={0} context={null} onMove={vi.fn()} scale={scale} />)
  .container.querySelector('[data-testid="sticky-note"]') as HTMLElement;

test('zoomed board note is drawn at the zoom, keeping its stored size', () => {
  const el = box(0.5);
  assert.equal(el.style.transform, 'scale(0.5)');
  assert.equal(el.style.width, '220px');
});

test('unzoomed note has no transform', () => {
  assert.equal(box().style.transform, '');
});
