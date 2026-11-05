import assert from 'node:assert/strict';

import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/** Archiving a conversation keeps its 收納盒 and Co-Work members (so a restore finds them); only a hard delete forgets. */
vi.mock('@/shared/api', () => ({
  api: {
    projects: () => Promise.resolve({ ok: true, json: async () => [] }),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));
const forgetBoxes = vi.fn();
const forgetCo = vi.fn();
vi.mock('@/shared/sessionBoxes', async (original) => ({
  ...(await original<typeof import('@/shared/sessionBoxes')>()),
  forgetSessionInBoxes: (id: string) => forgetBoxes(id),
}));
vi.mock('@/shared/coSessions', async (original) => ({
  ...(await original<typeof import('@/shared/coSessions')>()),
  forgetCoSession: (id: string) => forgetCo(id),
}));

const render = async () => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  const hook = renderHook(() => useProjectsState({
    sessionId: undefined,
    navigate: vi.fn(),
    subscribe: () => () => undefined,
    isMobile: false,
    isSessionProcessing: () => false,
  }));
  await waitFor(() => assert.equal(hook.result.current.isLoadingProjects, false));
  return hook;
};

beforeEach(() => {
  localStorage.clear();
  forgetBoxes.mockReset();
  forgetCo.mockReset();
});
afterEach(() => vi.resetModules());

test('archive (hardDelete=false) does not forget box or Co-Work membership', async () => {
  const { result } = await render();
  act(() => result.current.handleSessionDelete('s1', false));
  assert.equal(forgetBoxes.mock.calls.length, 0);
  assert.equal(forgetCo.mock.calls.length, 0);
});

test('a hard delete (and the default, e.g. flash tasks) forgets both', async () => {
  const { result } = await render();
  act(() => result.current.handleSessionDelete('s1', true));
  act(() => result.current.handleSessionDelete('s2'));
  assert.deepEqual(forgetBoxes.mock.calls, [['s1'], ['s2']]);
  assert.deepEqual(forgetCo.mock.calls, [['s1'], ['s2']]);
});
