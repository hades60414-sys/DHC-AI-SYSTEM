import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { setCanvasMode, useCanvasFeed, useCanvasState } from '@/modules/canvas/canvasStore';
import type { ChatMessage } from '@/shared/types';

/** 11/02: the canvas never starts by itself; only a press of the 畫布 button in this conversation lets it open. */

const at = 1_700_000_000_000;
const user = (text: string): ChatMessage => ({ type: 'user', content: text, timestamp: at });
const write = (id: string, name: string): ChatMessage => ({
  type: 'assistant', isToolUse: true, toolName: 'Write', toolId: id, timestamp: at,
  toolInput: { file_path: `D:\\p\\canvas\\${name}.html`, content: `<h1>${name}</h1>` },
  toolResult: { content: 'ok', isError: false } as never,
});

const feed = (sessionId: string | null, messages: ChatMessage[]) => renderHook(({ sessionId: id, messages: list }) => {
  useCanvasFeed({ sessionId: id, projectId: 'p1', messages: list, submitText: null });
  return useCanvasState();
}, { initialProps: { sessionId, messages } });

describe('canvas opens only after the button is pressed', () => {
  it('stays closed when a page arrives without the button, even if the old 自動開啟 flag is on', () => {
    localStorage.setItem('dhc.canvasAuto', '1');
    localStorage.setItem('dhc.canvasMode:p1', '1');
    const { rerender, result } = feed('s1', [user('hi')]);
    rerender({ sessionId: 's1', messages: [user('hi'), write('w1', 'a')] });
    expect(result.current.mode).toBe(false);
    expect(result.current.open).toBe(false);
  });

  it('opens on the next page once pressed, and the press does not carry to another conversation', () => {
    const { rerender, result } = feed('s2', [user('hi')]);
    act(() => setCanvasMode(true));
    rerender({ sessionId: 's2', messages: [user('hi'), write('w2', 'b')] });
    expect(result.current.open).toBe(true);

    rerender({ sessionId: 's3', messages: [user('other')] });
    expect(result.current.mode).toBe(false);
    rerender({ sessionId: 's3', messages: [user('other'), write('w3', 'c')] });
    expect(result.current.open).toBe(false);
  });

  it('keeps a press made in a new conversation when it gets its id', () => {
    const { rerender, result } = feed(null, []);
    act(() => setCanvasMode(true));
    rerender({ sessionId: 's4', messages: [user('make a page')] });
    expect(result.current.mode).toBe(true);
    rerender({ sessionId: 's4', messages: [user('make a page'), write('w4', 'd')] });
    expect(result.current.open).toBe(true);
  });
});
