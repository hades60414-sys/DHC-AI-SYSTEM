import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

/** 10/18 審查 #1: the five slots are never saved before the server's copy has loaded, and a refused save is reported. */

const api = vi.hoisted(() => ({
  preferences: vi.fn(),
  savePreferences: vi.fn(),
}));
vi.mock('@/shared/api', () => ({ api: { user: api } }));

const { usePicks } = await import('@/shared/customTools');
const reply = (ok: boolean, body: unknown = {}) => ({ ok, status: ok ? 200 : 500, json: async () => body });

afterEach(() => {
  api.preferences.mockReset();
  api.savePreferences.mockReset();
});

test('a change before the slots loaded is refused and nothing is sent', () => {
  api.preferences.mockReturnValue(new Promise(() => {}));
  const { result } = renderHook(() => usePicks('p1'));
  act(() => result.current[1](['plan-board', null, null, null, null]));
  assert.equal(api.savePreferences.mock.calls.length, 0);
  assert.deepEqual(result.current[0], [null, null, null, null, null]);
  assert.match(result.current[2], /沒有儲存/);
});

test('a failed load keeps refusing changes instead of overwriting the saved slots', async () => {
  api.preferences.mockResolvedValue(reply(false));
  const { result } = renderHook(() => usePicks('p1'));
  await act(async () => { await Promise.resolve(); });
  act(() => result.current[1](['plan-board', null, null, null, null]));
  assert.equal(api.savePreferences.mock.calls.length, 0);
});

test('after loading, a change is saved with the server slots as the base; a refused save is reported', async () => {
  api.preferences.mockResolvedValue(reply(true, { preferences: { 'dhc.picks:p:p1': ['a', 'b'] } }));
  api.savePreferences.mockResolvedValue(reply(false));
  const { result } = renderHook(() => usePicks('p1'));
  await waitFor(() => assert.deepEqual(result.current[0], ['a', 'b', null, null, null]));
  act(() => result.current[1](['a', 'b', 'c', null, null]));
  assert.deepEqual(api.savePreferences.mock.calls[0][0], { 'dhc.picks:p:p1': ['a', 'b', 'c', null, null] });
  await waitFor(() => assert.match(result.current[2], /沒存到/));
});
