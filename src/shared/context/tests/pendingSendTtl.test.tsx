import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { WebSocketProvider, useWebSocket } from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

/**
 * A send issued while the socket is down is queued and flushed on reconnect.
 * Without an expiry that queue is how the same turn reached the server twice:
 * the flush could land a minute later, long after the user had given up on the
 * silent bubble and re-sent the message by hand. These tests pin both halves —
 * a short outage still delivers, a long one reports instead of replaying.
 */

vi.mock('@/modules/auth', () => ({
  useAuth: () => ({ isLoading: false, token: 'test-token', user: { id: 1, username: 'tester' } }),
}));

vi.mock('@/shared/authToken', () => ({
  isAuthTokenExpired: () => false,
  expireAuthSession: () => undefined,
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  acceptConnection() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

const CHAT_SEND = { type: 'chat.send', sessionId: 'session-1', content: 'hello' };

// Every socket also sends a keepalive on open; these tests are about what else reaches the server.
const sentWithoutKeepalive = (socket: FakeWebSocket) =>
  socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type !== 'chat.ping');

const renderProvider = () => {
  const events: ServerEvent[] = [];
  const rendered = renderHook(() => useWebSocket(), {
    wrapper: ({ children }) => <WebSocketProvider>{children}</WebSocketProvider>,
  });
  act(() => {
    rendered.result.current.subscribe((event) => events.push(event));
  });
  return { ...rendered, events };
};

/** Connects the first socket, then drops it so the next send has to queue. */
const openThenDrop = () => {
  act(() => {
    FakeWebSocket.instances[0].acceptConnection();
  });
  act(() => {
    FakeWebSocket.instances[0].close();
  });
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a send queued during a short outage is flushed on reconnect', () => {
  const { result, events } = renderProvider();
  openThenDrop();

  act(() => {
    result.current.sendMessage(CHAT_SEND);
  });
  act(() => {
    vi.advanceTimersByTime(2_000);
  });

  const reconnected = FakeWebSocket.instances[1];
  assert.ok(reconnected, 'the send should have triggered an immediate reconnect');
  act(() => {
    reconnected.acceptConnection();
  });

  assert.deepEqual(sentWithoutKeepalive(reconnected), [CHAT_SEND]);
  assert.equal(events.filter((event) => event.kind === 'protocol_error').length, 0);
});

test('a send still queued after the TTL is reported, not replayed later', () => {
  const { result, events } = renderProvider();
  openThenDrop();

  act(() => {
    result.current.sendMessage(CHAT_SEND);
  });
  act(() => {
    vi.advanceTimersByTime(11_000);
  });

  const failures = events.filter((event) => event.kind === 'protocol_error');
  assert.equal(failures.length, 1, 'the user should be told the turn never left the browser');
  assert.equal((failures[0] as { sessionId?: string }).sessionId, 'session-1');

  const reconnected = FakeWebSocket.instances[1];
  act(() => {
    reconnected.acceptConnection();
  });
  assert.deepEqual(sentWithoutKeepalive(reconnected), [], 'the expired turn must not reach the server after the fact');
});

test('a non-chat frame that expires is dropped without bothering the user', () => {
  const { result, events } = renderProvider();
  openThenDrop();

  act(() => {
    result.current.sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId: 'session-1' }] });
  });
  act(() => {
    vi.advanceTimersByTime(11_000);
  });

  assert.equal(events.filter((event) => event.kind === 'protocol_error').length, 0);
});
