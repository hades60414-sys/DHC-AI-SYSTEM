import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * A send the server refuses because the session is still running used to show its raw text,
 * `Session "942728f2-…" already has a run in progress.` — English, a UUID, no next step. The user reads
 * the conversation in Chinese, so the notice says what happened and what to do instead.
 */

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const appended: NormalizedMessage[] = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: { appendRealtime: (_sid: string, message: NormalizedMessage) => { appended.push(message); } } as unknown as SessionStore,
  }));

  return { dispatch: (event: ServerEvent) => listener?.(event), appended };
};

test('a send refused as RUN_IN_PROGRESS is explained in Chinese, without the session id', () => {
  const { dispatch, appended } = renderHandlers();
  dispatch({
    kind: 'protocol_error',
    code: 'RUN_IN_PROGRESS',
    error: 'Session "viewed-session" already has a run in progress.',
    sessionId: 'viewed-session',
  } as unknown as ServerEvent);

  assert.equal(appended.length, 1);
  assert.equal(appended[0].kind, 'error');
  assert.equal(appended[0].content, '上一則還在處理中，這則沒有送出。等回覆完成後再送一次。');
});

test('other protocol errors keep their own text', () => {
  const { dispatch, appended } = renderHandlers();
  dispatch({
    kind: 'protocol_error',
    code: 'SEND_NOT_DELIVERED',
    error: '這則訊息沒有送出（連線中斷），請重新送出。',
    sessionId: 'viewed-session',
  } as unknown as ServerEvent);

  assert.equal(appended[0].content, '這則訊息沒有送出（連線中斷），請重新送出。');
});
