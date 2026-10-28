import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { removeOptimisticUserEchoes } from '@/modules/chat/utils/sessionMessageReconciliation';
import { observeServerTime, serverNow, toServerTime } from '@/shared/serverClock';
import type { NormalizedMessage } from '@/shared/types';

/**
 * 9/16 17:00: the host clock ran ~36s behind the browsers using it. The transcript stamped a sent message
 * 17:00:36 while its optimistic echo carried the browser's 17:01:11, too far apart for the echo to be
 * retired, so the message showed twice — the copy below the reply. These pin the reproduction and the fix.
 */

const HOST_RECEIVED = Date.parse('2026-09-16T09:00:35.300Z');
const BROWSER_SKEW_MS = 36_000;
const TEXT = '所以我可以把剛剛那些檔案全刪了對吧，之後怎麼叫出來';

const userRow = (id: string, timestamp: number): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp: new Date(timestamp).toISOString(),
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: TEXT,
} as NormalizedMessage);

// What the transcript returns: stamped by the host 1.5s after it received the send.
const persisted = [userRow('persisted', HOST_RECEIVED + 1_500)];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(HOST_RECEIVED + BROWSER_SKEW_MS); // the browser's clock at the moment of sending
});

afterEach(() => {
  vi.useRealTimers();
});

test("an echo stamped with a browser clock 36s ahead of the host is never retired (the 9/16 duplicate)", () => {
  const echo = userRow('local_1', Date.now());
  assert.deepEqual(removeOptimisticUserEchoes(persisted, [echo]).map((row) => row.id), ['local_1']);
});

test('once the host clock is learned, the echo lands on it and its persisted copy retires it', () => {
  observeServerTime(new Date(HOST_RECEIVED).toISOString());
  const echo = userRow('local_1', toServerTime(Date.now()));

  assert.equal(serverNow(), HOST_RECEIVED);
  assert.deepEqual(removeOptimisticUserEchoes(persisted, [echo]), []);
});

test('a missing or unreadable server timestamp leaves the learned offset alone', () => {
  observeServerTime(new Date(HOST_RECEIVED).toISOString());
  observeServerTime(undefined);
  observeServerTime('not a date');
  assert.equal(serverNow(), HOST_RECEIVED);
});
