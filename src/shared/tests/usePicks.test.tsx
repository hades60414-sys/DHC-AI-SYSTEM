import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { usePicks } from '@/shared/customTools';

const reply = (ok: boolean, body: unknown = {}) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;
afterEach(() => vi.restoreAllMocks());

test('10/18: slots are not saved before the server copy has loaded, and a refused save is reported', async () => {
  let release: (value: Response) => void = () => {};
  vi.spyOn(api.user, 'preferences').mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
  const save = vi.spyOn(api.user, 'savePreferences').mockResolvedValue(reply(false));
  const { result } = renderHook(() => usePicks('p1'));

  act(() => result.current[1](['a', null, null, null, null]));
  assert.equal(save.mock.calls.length, 0, 'nothing written over the unloaded server copy');
  assert.ok(result.current[2], 'the person is told');
  assert.deepEqual(result.current[0], [null, null, null, null, null]);

  await act(async () => { release(reply(true, { preferences: { 'dhc.picks:p:p1': ['x', 'y'] } })); });
  await waitFor(() => assert.deepEqual(result.current[0], ['x', 'y', null, null, null]));
  act(() => result.current[1](['x', 'y', 'z', null, null]));
  assert.equal(save.mock.calls.length, 1);
  await waitFor(() => assert.match(result.current[2], /沒存到/));
});

test('10/18: a failed load keeps changes refused', async () => {
  vi.spyOn(api.user, 'preferences').mockRejectedValue(new Error('down'));
  const save = vi.spyOn(api.user, 'savePreferences').mockResolvedValue(reply(true));
  const { result } = renderHook(() => usePicks('p1'));
  await act(async () => { await Promise.resolve(); });
  act(() => result.current[1](['a', null, null, null, null]));
  assert.equal(save.mock.calls.length, 0);
});
