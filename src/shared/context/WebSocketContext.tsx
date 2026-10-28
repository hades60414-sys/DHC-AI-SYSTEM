import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import { IS_PLATFORM } from '@/shared/utils';
import { expireAuthSession, isAuthTokenExpired } from '@/shared/authToken';
import { observeServerTime } from '@/shared/serverClock';
import type { ServerEvent } from '@/shared/types';


type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
};

// DHC CLI: a send queued while the socket is down is only worth delivering while the user is still
// waiting for it. Past this window the user has usually re-sent by hand, so a late flush replays the
// same turn a second time — the duplicate-message report this limit exists to close.
const PENDING_SEND_TTL_MS = 10_000;
// Only these frames carry the user's own turn. Everything else (subscribe, abort, permission answers)
// is re-issued by its own component after a reconnect and must not be reported to the user as lost.
const USER_TURN_FRAME_TYPES = new Set(['chat.send', 'chat.edit-send']);

type PendingSend = { message: unknown; queuedAt: number };

// DHC CLI: the server's WebSocket ping/pong never reaches the browser (Cloudflare answers pongs at the
// edge), so the browser<->edge leg carries no traffic while nothing streams and idle-timeout middleboxes
// drop it every few minutes. A small application frame keeps that leg busy. The server has no handler for
// it and answers UNKNOWN_MESSAGE_TYPE, which is filtered below so the user never sees it. That answer is
// stamped with the host's clock, which serverClock needs, so the server must keep not handling chat.ping.
const KEEPALIVE_MS = 25_000;
const KEEPALIVE_FRAME = { type: 'chat.ping' };
type CloseDiag = { code: number; lifeSec: number };

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null, lastClose: CloseDiag | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // DHC CLI: on a reconnect, tell the server why the previous socket died. The server logs the upgrade
  // URL as-is, so the server log gets the close code and lifetime without a server change.
  const diag = lastClose ? `rc=${lastClose.code}&life=${lastClose.lifeSec}` : '';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws${diag ? `?${diag}` : ''}`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}${diag ? `&${diag}` : ''}`; // OSS mode: Use same host:port that served the page
};

const isKeepaliveEcho = (event: ServerEvent) => {
  const frame = event as { kind?: unknown; code?: unknown; error?: unknown };
  return frame.kind === 'protocol_error' && frame.code === 'UNKNOWN_MESSAGE_TYPE'
    && typeof frame.error === 'string' && frame.error.includes(KEEPALIVE_FRAME.type);
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef<number>(0); // DHC CLI: backoff counter, reset on successful open
  // DHC CLI: messages sent while the socket is down wait here and flush on open (they used to be dropped
  // with only a console warning, leaving a 'sent' bubble that never reached the server).
  const pendingSendsRef = useRef<PendingSend[]>([]);
  const connectRef = useRef<() => void>(() => undefined);
  const keepaliveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastCloseRef = useRef<CloseDiag | null>(null);
  const sweepPendingSendsRef = useRef<(socket: WebSocket | null) => void>(() => undefined);
  const { isLoading: isAuthLoading, token, user } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  // DHC CLI: a user turn that never reached the server is reported in the conversation instead of
  // being left as a bubble that looks sent. Reuses the protocol_error frame the chat already renders.
  const reportSendFailure = useCallback((message: unknown) => {
    const frame = message as { type?: unknown; sessionId?: unknown } | null;
    if (!frame || !USER_TURN_FRAME_TYPES.has(String(frame.type))) return;
    dispatch({
      kind: 'protocol_error',
      code: 'SEND_NOT_DELIVERED',
      error: '這則訊息沒有送出（連線中斷），請重新送出。',
      ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
    } as unknown as ServerEvent);
  }, [dispatch]);

  // Retires queued sends. Given a socket it flushes the ones still inside the window; given null (the
  // TTL timer) it only expires. Either way an expired user turn is reported, so a queued message can no
  // longer sit silently and then land minutes later next to the copy the user already re-sent.
  const sweepPendingSends = useCallback((socket: WebSocket | null) => {
    const now = Date.now();
    const pending = pendingSendsRef.current.splice(0);
    const kept: PendingSend[] = [];
    for (const entry of pending) {
      if (now - entry.queuedAt > PENDING_SEND_TTL_MS) {
        reportSendFailure(entry.message);
        continue;
      }
      if (!socket) {
        kept.push(entry);
        continue;
      }
      try {
        socket.send(JSON.stringify(entry.message));
      } catch (e) {
        console.error('WebSocket flush failed:', e);
        reportSendFailure(entry.message);
      }
    }
    pendingSendsRef.current = kept;
  }, [reportSendFailure]);
  sweepPendingSendsRef.current = sweepPendingSends;

  // Named function expression so the reconnect timer below can call itself
  // without reading the `connect` binding while it is still initializing.
  const connect = useCallback(function connect() {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token, lastCloseRef.current);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;
      let openedAt = 0;
      const stopKeepalive = () => {
        if (keepaliveTimerRef.current) { clearInterval(keepaliveTimerRef.current); keepaliveTimerRef.current = null; }
      };

      websocket.onopen = () => {
        reconnectAttemptRef.current = 0;
        openedAt = Date.now();
        stopKeepalive();
        keepaliveTimerRef.current = setInterval(() => {
          if (websocket.readyState !== WebSocket.OPEN) { stopKeepalive(); return; }
          try { websocket.send(JSON.stringify(KEEPALIVE_FRAME)); } catch { /* onclose follows */ }
        }, KEEPALIVE_MS);
        // DHC CLI: one right away, so its answer puts serverClock on the host's clock before the first send.
        try { websocket.send(JSON.stringify(KEEPALIVE_FRAME)); } catch { /* onclose follows */ }
        setIsConnected(true);
        sweepPendingSendsRef.current(websocket);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          // DHC CLI: both are stamped by the host as it answers, never replayed, so they carry its clock.
          if (data.kind === 'chat_subscribed' || isKeepaliveEcho(data)) observeServerTime(data.timestamp);
          if (isKeepaliveEcho(data)) return;
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = (event) => {
        stopKeepalive();
        if (wsRef.current !== websocket) {
          return;
        }
        lastCloseRef.current = {
          code: typeof event?.code === 'number' ? event.code : 0,
          lifeSec: openedAt ? Math.round((Date.now() - openedAt) / 1000) : -1,
        };
        setIsConnected(false);
        wsRef.current = null;

        // DHC CLI: exponential backoff (3s -> 60s) instead of a fixed 3s. A tab left open while the host is
        // down used to hit the Cloudflare Worker every 3s (~29k requests/day per tab) against a 100k/day quota.
        const attempt = (reconnectAttemptRef.current = (reconnectAttemptRef.current ?? 0) + 1);
        const delay = Math.min(60000, 3000 * Math.pow(2, Math.max(0, attempt - 1)));
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, delay);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch, isAuthLoading, token, user]); // reconnect with current authentication state
  connectRef.current = connect;

  // Declared after `connect` so the effect body does not reference it before
  // initialization. `connect` is memoized on [dispatch, isAuthLoading, token,
  // user] and `dispatch` is stable, so depending on it reconnects on exactly
  // the same transitions as the previous [isAuthLoading, token, user] list.
  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (keepaliveTimerRef.current) { clearInterval(keepaliveTimerRef.current); keepaliveTimerRef.current = null; }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
    };
  }, [connect, isAuthLoading, user]); // reconnect after authentication or token refresh

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected - queuing message and reconnecting now');
      pendingSendsRef.current.push({ message, queuedAt: Date.now() });
      if (pendingSendsRef.current.length > 50) pendingSendsRef.current.shift();
      // Nothing else wakes the queue when the socket never comes back, so the TTL needs its own timer.
      setTimeout(() => sweepPendingSendsRef.current(null), PENDING_SEND_TTL_MS + 100);
      // The user just acted: do not wait for the backoff timer.
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
        reconnectAttemptRef.current = 0;
        connectRef.current();
      }
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected
  }), [sendMessage, subscribe, isConnected]);

  return value;
};

/** Mounted once by App; owns the single chat websocket that the chat, project-workspace and task-master modules subscribe to. */
export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
