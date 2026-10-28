import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { beforeEach, test } from 'vitest';

import {
  clearWaitingRequest,
  clearWaitingSession,
  markWaiting,
  pickWaiting,
  resetWaitingForTests,
  setWaitingFromServer,
  useWaitingMap,
} from '@/shared/waitingOnYou';

/**
 * DHC CLI: the reminder icon for a session waiting on a choice question or a review. Live events add and remove
 * prompts; the server's poll replaces the picture when it carries the list and is ignored when it does not.
 */

const currentMap = () => {
  const { result, unmount } = renderHook(() => useWaitingMap());
  unmount();
  return result.current;
};
const kinds = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, pickWaiting([id], currentMap())]));

beforeEach(() => resetWaitingForTests());

test('a question outranks a review, and answering clears only that prompt', () => {
  markWaiting('s1', 'r1', 'Bash');
  markWaiting('s1', 'r2', 'AskUserQuestion');
  markWaiting('s2', 'r3', 'ExitPlanMode');
  setWaitingFromServer(undefined);
  assert.deepEqual(kinds('s1', 's2'), { s1: 'question', s2: 'review' }, 'an older server without the list changes nothing');

  clearWaitingRequest('r2');
  assert.deepEqual(kinds('s1', 's2'), { s1: 'review', s2: 'review' });

  clearWaitingSession('s1');
  clearWaitingRequest('r3', 's2');
  assert.deepEqual(kinds('s1', 's2'), { s1: null, s2: null });
});

test('the poll replaces the whole picture', () => {
  markWaiting('s1', 'r1', 'Bash');
  setWaitingFromServer([{ sessionId: 's9', requestId: 'q', toolName: 'AskUserQuestion' }, { sessionId: '', requestId: 'x' }]);
  assert.equal(pickWaiting(['s1'], currentMap()), null);
  assert.equal(pickWaiting(['s1', 's9'], currentMap()), 'question');
});
