import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { WebSocketProvider, useWebSocket } from '@/shared/context/WebSocketContext';
import { serverNow } from '@/shared/serverClock';
import type { ServerEvent } from '@/shared/types';

/**
 * The browser leg of the socket carries nothing while no run is streaming (the server's WebSocket
 * pings are answered at the Cloudflare edge and never reach the browser), so idle-timeout middleboxes
 * cut it every few minutes. These pin the application-level keepalive that keeps that leg busy and the
 * close diagnostics the next upgrade URL carries into server.log.
 */

// One stable auth object: a fresh `user` per render would re-run the provider's connect effect on every
// state change and silently replace the socket under test.
const auth = vi.hoisted(() => ({ isLoading: false, token: 'test-token', user: { id: 1, username: 'tester' } }));
vi.mock('@/modules/auth', () => ({
  useAuth: () => auth,
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
  onclose: ((event?: { code: number }) => void) | null = null;
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

  dropAbnormally() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }

  acceptConnection() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

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

const latestSocket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const pingsOn =(socket: FakeWebSocket) => socket.sent.filter((raw) => JSON.parse(raw).type === 'chat.ping').length;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('an open socket sends a keepalive frame on open and every 25s, and stops once closed', () => {
  renderProvider();
  const socket = latestSocket();
  act(() => {
    socket.acceptConnection();
  });
  assert.equal(pingsOn(socket), 1, 'the first one goes out on open to learn the host clock');
  act(() => {
    vi.advanceTimersByTime(76_000);
  });
  assert.equal(pingsOn(socket), 4);

  act(() => {
    socket.dropAbnormally();
  });
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  assert.equal(pingsOn(socket), 4, 'no keepalive may be sent on a dead socket');
});

test('the host clock is learned from the keepalive answer and from chat_subscribed', () => {
  const hostNow = Date.parse('2026-09-16T09:00:35.000Z');
  vi.setSystemTime(hostNow + 36_000); // browser clock 36s ahead of the host, as on 9/16
  const { events } = renderProvider();
  const socket = latestSocket();
  act(() => {
    socket.acceptConnection();
  });
  act(() => {
    socket.onmessage?.({ data: JSON.stringify({ kind: 'protocol_error', code: 'UNKNOWN_MESSAGE_TYPE', error: 'Unknown message type "chat.ping".', sessionId: null, timestamp: new Date(hostNow).toISOString() }) });
  });
  assert.equal(serverNow(), hostNow);

  act(() => {
    socket.onmessage?.({ data: JSON.stringify({ kind: 'chat_subscribed', sessionId: 'session-1', isProcessing: false, timestamp: new Date(hostNow - 2_000).toISOString() }) });
  });
  assert.equal(serverNow(), hostNow - 2_000);
  assert.deepEqual(events.map((event) => event.kind), ['chat_subscribed'], 'the ack still reaches the chat');
});

test("the old server's UNKNOWN_MESSAGE_TYPE reply to the keepalive is swallowed", () => {
  const { events } = renderProvider();
  const socket = latestSocket();
  act(() => {
    socket.acceptConnection();
  });
  act(() => {
    socket.onmessage?.({ data: JSON.stringify({ kind: 'protocol_error', code: 'UNKNOWN_MESSAGE_TYPE', error: 'Unknown message type "chat.ping".', sessionId: null }) });
    socket.onmessage?.({ data: JSON.stringify({ kind: 'protocol_error', code: 'UNKNOWN_MESSAGE_TYPE', error: 'Unknown message type "chat.other".', sessionId: null }) });
  });
  assert.deepEqual(events.map((event) => (event as { error?: string }).error), ['Unknown message type "chat.other".']);
});

test('the reconnect upgrade URL reports the previous close code and lifetime', () => {
  renderProvider();
  const first = latestSocket();
  assert.equal(first.url.includes('rc='), false, 'the first connection has nothing to report');
  act(() => {
    first.acceptConnection();
  });
  act(() => {
    vi.advanceTimersByTime(200_000);
  });
  act(() => {
    first.dropAbnormally();
  });
  act(() => {
    vi.advanceTimersByTime(3_100);
  });
  const second = latestSocket();
  assert.notEqual(second, first, 'a reconnect should follow the drop');
  assert.match(second.url, /[?&]rc=1006&life=200(&|$)/);
});
