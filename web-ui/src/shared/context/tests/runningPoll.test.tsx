import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { SessionProtectionProvider } from '@/shared/context/SessionProtectionContext';

/**
 * Every running-sessions poll is one Cloudflare Worker request against the team's 100k/day. Pins the 2026-10-22
 * schedule: hidden tabs never poll, a tab that comes back polls at once, and an idle answer slows polling to 15s.
 */

const running = vi.hoisted(() => ({ calls: 0, busy: false }));
vi.mock('@/shared/api', () => ({
  api: {
    runningSessions: async () => {
      running.calls += 1;
      const sessions = running.busy ? [{ sessionId: 's1' }] : [];
      return { ok: true, json: async () => ({ data: { sessions, background: [], waiting: [] } }) };
    },
  },
}));
vi.mock('@/shared/nightQueueMarks', () => ({ refreshNightQueueMarks: async () => true }));

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  running.calls = 0;
  running.busy = false;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  vi.useRealTimers();
});

const mount = async () => {
  const view = render(<SessionProtectionProvider><div /></SessionProtectionProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return view;
};
const advance = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

test('a hidden tab makes no running-sessions calls and polls once as soon as it is visible again', async () => {
  const view = await mount();
  const afterMount = running.calls;
  act(() => setVisibility('hidden'));
  await advance(60_000);
  assert.equal(running.calls, afterMount);
  act(() => setVisibility('visible'));
  await advance(0);
  assert.equal(running.calls, afterMount + 1);
  view.unmount();
});

test('polls every 5s while something runs and every 15s when nothing does', async () => {
  running.busy = true;
  const view = await mount();
  await advance(5_000);
  const busyStart = running.calls;
  await advance(30_000);
  assert.equal(running.calls - busyStart, 6);
  running.busy = false;
  await advance(5_000);
  const idleStart = running.calls;
  await advance(30_000);
  assert.equal(running.calls - idleStart, 2);
  view.unmount();
});
