import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { clampCanvasWidth } from '@/modules/canvas/CanvasPanel';
import { canvasDocs, setCanvasCurrent, useCanvasFeed, useCanvasState } from '@/modules/canvas/canvasStore';
import type { ChatMessage } from '@/shared/types';

/** 11/01: a file seen through an Edit has its content read once; a later Edit/Write must not be shown on top of that old read. */

const at = 1_700_000_000_000;
const FILE = 'D:\\p\\canvas\\a.html';
const edit = (id: string, old_string: string, new_string: string): ChatMessage => ({
  type: 'assistant', isToolUse: true, toolName: 'Edit', toolId: id, toolInput: { file_path: FILE, old_string, new_string }, timestamp: at,
  toolResult: { content: 'ok', isError: false } as never,
});

describe('canvas current content', () => {
  it('is read again after a later Edit to the same file arrives', () => {
    const first = [edit('e1', 'a', 'b')];
    const { rerender, result } = renderHook(({ messages }) => {
      useCanvasFeed({ sessionId: 's1', projectId: 'p1', messages, submitText: null });
      return useCanvasState();
    }, { initialProps: { messages: first } });
    expect(canvasDocs()[0].needsCurrent).toBe(true);

    // The panel read the file after e1: <b>b</b> (versions: only one, which is the file now).
    act(() => setCanvasCurrent(FILE, '<b>b</b>'));
    expect(canvasDocs()[0].versions[0].content).toBe('<b>b</b>');
    expect(result.current.currents.has(FILE)).toBe(true);

    // e2 arrives: the old read no longer describes "the file now", so it is dropped and the panel reads again.
    rerender({ messages: [...first, edit('e2', 'b', 'c')] });
    expect(result.current.currents.has(FILE)).toBe(false);
    expect(canvasDocs()[0].needsCurrent).toBe(true);

    act(() => setCanvasCurrent(FILE, '<b>c</b>'));
    expect(canvasDocs()[0].versions.map((version) => version.content)).toEqual(['<b>b</b>', '<b>c</b>']);
  });
});

describe('clampCanvasWidth', () => {
  it('keeps a restored width inside 3/4 of the window and never under the minimum', () => {
    expect(clampCanvasWidth(900, 1000)).toBe(750);
    expect(clampCanvasWidth(560, 1440)).toBe(560);
    expect(clampCanvasWidth(100, 1440)).toBe(360);
    expect(clampCanvasWidth(560, 390)).toBe(360);
  });
});
