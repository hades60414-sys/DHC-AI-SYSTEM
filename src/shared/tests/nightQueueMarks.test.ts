import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

/** DHC CLI 10/02: which sessions the sidebar marks with a moon. */

const list = vi.fn();
vi.mock('@/shared/api', () => ({ api: { nightQueue: { list: () => list() } } }));

const { noteNightQueueState, refreshNightQueueMarks, setNightQueueMarks, useNightQueueMark } = await import('@/shared/nightQueueMarks');

const reply = (contentType: string, body: unknown) => ({
  ok: true,
  headers: { get: () => contentType },
  json: async () => body,
});

afterEach(() => {
  act(() => setNightQueueMarks([]));
  list.mockReset();
});

test('the server list becomes per-session moons; a session with nothing on or waiting gets none', () => {
  act(() => setNightQueueMarks([
    { sessionId: 'a', enabled: true, queued: 0 },
    { sessionId: 'b', enabled: false, queued: 2 },
    { sessionId: 'c', enabled: false, queued: 0 },
    { enabled: true },
  ]));
  assert.deepEqual(renderHook(() => useNightQueueMark('a')).result.current, { enabled: true, queued: 0 });
  assert.deepEqual(renderHook(() => useNightQueueMark('b')).result.current, { enabled: false, queued: 2 });
  assert.equal(renderHook(() => useNightQueueMark('c')).result.current, null);
});

test('the open composer moves its own session at once, on and off', () => {
  const { result } = renderHook(() => useNightQueueMark('s'));
  act(() => noteNightQueueState('s', true, 1));
  assert.deepEqual(result.current, { enabled: true, queued: 1 });
  act(() => noteNightQueueState('s', false, 0));
  assert.equal(result.current, null);
});

test("a server without the list route answers with the app's HTML: not supported, and the moons stay as they were", async () => {
  act(() => setNightQueueMarks([{ sessionId: 'a', enabled: true, queued: 0 }]));
  const a = renderHook(() => useNightQueueMark('a'));
  const b = renderHook(() => useNightQueueMark('b'));

  list.mockResolvedValueOnce(reply('text/html; charset=UTF-8', null));
  let supported: boolean | undefined;
  await act(async () => { supported = await refreshNightQueueMarks(); });
  assert.equal(supported, false);
  assert.deepEqual(a.result.current, { enabled: true, queued: 0 });

  list.mockResolvedValueOnce(reply('application/json; charset=utf-8', { data: { sessions: [{ sessionId: 'b', enabled: true, queued: 3 }] } }));
  await act(async () => { supported = await refreshNightQueueMarks(); });
  assert.equal(supported, true);
  assert.equal(a.result.current, null);
  assert.deepEqual(b.result.current, { enabled: true, queued: 3 });
});
