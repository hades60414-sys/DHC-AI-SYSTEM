import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import {
  describeBackgroundWork,
  setBackgroundWork,
  useBackgroundWork,
  useBackgroundWorkMap,
} from '@/shared/backgroundWork';

/** DHC CLI 10/01: the sidebar's light for sessions whose subagents / background shells outlive the turn. */

// Shape of `background` in GET /api/providers/sessions/running.
const SERVER_LIST = [
  {
    sessionId: 'session-a',
    tasks: [
      { type: 'local_agent', description: '審查 diff' },
      { type: 'local_bash', description: 'npm test' },
      { type: 'local_agent', description: '' },
    ],
    followUp: false,
    since: 1_000,
  },
  { sessionId: 'session-b', tasks: [], followUp: true, since: 2_000 },
];

afterEach(() => {
  act(() => setBackgroundWork([]));
});

test('the server list becomes per-session counts by kind of work', () => {
  act(() => setBackgroundWork(SERVER_LIST));
  const { result } = renderHook(() => useBackgroundWork('session-a'));

  assert.deepEqual(result.current, {
    agents: 2,
    shells: 1,
    others: 0,
    followUp: false,
    descriptions: ['審查 diff', 'npm test'],
  });
  assert.equal(renderHook(() => useBackgroundWork('session-idle')).result.current, null);
});

test('a poll that reports the same work does not redraw the sidebar', () => {
  act(() => setBackgroundWork(SERVER_LIST));
  let renders = 0;
  const { result } = renderHook(() => {
    renders += 1;
    return useBackgroundWorkMap();
  });
  const first = result.current;

  act(() => setBackgroundWork(structuredClone(SERVER_LIST)));
  assert.equal(result.current, first);
  assert.equal(renders, 1);

  act(() => setBackgroundWork(SERVER_LIST.slice(1)));
  assert.notEqual(result.current, first);
  assert.deepEqual([...result.current.keys()], ['session-b']);
});

test('an older server without the field, or junk, means nothing is running in the background', () => {
  act(() => setBackgroundWork(SERVER_LIST));
  act(() => setBackgroundWork(undefined));
  assert.equal(renderHook(() => useBackgroundWorkMap()).result.current.size, 0);

  act(() => setBackgroundWork([null, 'x', { tasks: [] }, { sessionId: '' }]));
  assert.equal(renderHook(() => useBackgroundWorkMap()).result.current.size, 0);
});

test('the tooltip says what is still running and whether Claude is wrapping up', () => {
  const base = { agents: 0, shells: 0, others: 0, followUp: false, descriptions: [] };
  assert.equal(
    describeBackgroundWork({ ...base, agents: 2, shells: 1, descriptions: ['審查 diff', 'npm test'] }),
    '背景還在跑：2 個子代理、1 個指令（審查 diff、npm test）',
  );
  assert.equal(
    describeBackgroundWork({ ...base, agents: 4, descriptions: ['a', 'b', 'c', 'd'] }),
    '背景還在跑：4 個子代理（a、b、c…）',
  );
  assert.equal(describeBackgroundWork({ ...base, followUp: true }), '背景工作已回報，Claude 正在收尾');
  assert.equal(
    describeBackgroundWork({ ...base, agents: 1, followUp: true }),
    '背景還在跑：1 個子代理；Claude 正在處理已回報的結果',
  );
});
