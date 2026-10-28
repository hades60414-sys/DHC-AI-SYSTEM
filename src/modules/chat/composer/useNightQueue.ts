import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { noteNightQueueState } from '@/shared/nightQueueMarks';
import type { NightQueueItem, NightQueueSettings, NightQueueState } from '@/shared/types';

/**
 * How often the list is re-read so it follows the queue: quickly while something of this chat runs or is
 * about to ("run now"), slowly while it only waits for its start time — every read is a Worker request.
 */
const REFRESH_WHILE_ACTIVE_MS = 20_000;
const REFRESH_WHILE_WAITING_MS = 60_000;

async function readState(response: Response): Promise<NightQueueState | null> {
  if (!response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  const data = payload?.data;
  return data && typeof data.sessionId === 'string' && Array.isArray(data.items)
    ? data as NightQueueState
    : null;
}

/** The server's own words for a refused request (they are written for the user), if it sent any. */
async function readErrorMessage(response: Response): Promise<string | null> {
  const payload = await response.json().catch(() => null);
  const message = payload?.error?.message;
  return typeof message === 'string' && message.trim() ? message : null;
}

export type NightQueueControls = {
  enabled: boolean;
  /** The settings prompts are stored under while it is on (the start stays the 02:00 window), and bypass. */
  mode: NightQueueSettings | null;
  items: NightQueueItem[];
  pendingCount: number;
  /** The moon was pressed while off in a chat that is not in bypass mode: ask whether to run with bypass. */
  isAskingBypass: boolean;
  /** The moon was pressed while prompts are waiting: ask "run now / cancel all / back". */
  isConfirming: boolean;
  /** A server refusal from the last change, in the user's words. */
  notice: string | null;
  onToggle: () => void;
  onAnswerBypass: (useBypass: boolean) => void;
  onCancelBypass: () => void;
  onRunNow: () => void;
  onCancelAll: () => void;
  onCloseConfirm: () => void;
  onCancelItem: (id: string) => void;
};

export type NightQueueStoreResult = { ok: true } | { ok: false; message: string | null };

const NIGHT_WINDOW = { startAt: null } as const;

/**
 * DHC CLI night mode for one chat. While it is on, the composer stores prompts on the server instead of
 * sending them, and the server runs them one at a time from 02:00 — or, for a prompt that starts with
 * "@12:05", from that time.
 *
 * Nobody is there at night to approve tools, so turning it on in a chat that is not in bypass mode asks
 * once whether its prompts may run with bypass.
 *
 * A new chat has no session until its first prompt, so its switch and settings live here until then; the
 * prompt that creates the session also carries them over to it.
 */
export function useNightQueue(sessionId: string | null, newChatScope: string | null, permissionMode: string) {
  const [state, setState] = useState<NightQueueState | null>(null);
  const [newChat, setNewChat] = useState<{ scope: string; settings: NightQueueSettings } | null>(null);
  // The session a night prompt is being stored for, with the settings it is stored under. It counts as in
  // night mode until the server says so itself — otherwise a store that failed would let the retry go out
  // as a normal send.
  const [carried, setCarried] = useState<{ sessionId: string; settings: NightQueueSettings } | null>(null);
  const [askingFor, setAskingFor] = useState<string | null>(null);
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openSessionRef = useRef(sessionId);
  // Bumped when a change starts and when it lands. A read that overlapped one may carry the state from
  // before it (the server can take the read first and its answer can still arrive last), so it is dropped:
  // the change's own response is newer.
  const changeEpochRef = useRef(0);

  // Adjusted during render, like useScheduledMessages: the new chat's switch belongs to that unsent chat
  // only, so it ends once a session is open — after its first prompt created one, or when the user moved
  // to another chat. Not in the store itself, so the button does not blink off while the new session id
  // is still on its way here.
  const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
  if (renderedSessionId !== sessionId) {
    setRenderedSessionId(sessionId);
    setNotice(null);
    if (sessionId) {
      setNewChat(null);
    }
  }

  const scopeKey = sessionId ?? newChatScope;
  // A response for a session the user has since left must not show here, nor a question about it.
  const current = state && state.sessionId === sessionId ? state : null;
  const mode: NightQueueSettings | null = sessionId
    ? current?.mode ?? (carried?.sessionId === sessionId ? carried.settings : null)
    : newChat && newChat.scope === newChatScope ? newChat.settings : null;
  const enabled = mode !== null;
  const isAskingBypass = askingFor !== null && askingFor === scopeKey;
  const isConfirming = confirmingFor !== null && confirmingFor === sessionId;
  const items = current?.items ?? [];
  const pendingCount = items.filter((item) => item.status === 'pending').length;

  const refresh = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    const epoch = changeEpochRef.current;
    try {
      const next = await readState(await api.nightQueue.get(sessionId));
      if (next && openSessionRef.current === next.sessionId && epoch === changeEpochRef.current) {
        setState(next);
      }
    } catch (error) {
      console.error('Failed to load the night queue:', error);
    }
  }, [sessionId]);

  useEffect(() => {
    openSessionRef.current = sessionId;
    void refresh();
  }, [refresh, sessionId]);

  // DHC CLI: the sidebar's moon for this session follows every fresh state, without waiting for the minute's list.
  useEffect(() => {
    if (!current) return;
    const queued = current.items.filter((item) => item.status === 'pending' || item.status === 'running').length;
    noteNightQueueState(current.sessionId, current.mode !== null, queued);
  }, [current]);

  // The switch can be flipped from another tab or device (the phone, then the desk): re-read on return.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [refresh]);

  const isActive = items.some((item) => item.status === 'running' || (item.status === 'pending' && item.runNow));
  const isWaiting = items.some((item) => item.status === 'pending');
  useEffect(() => {
    if (!isActive && !isWaiting) {
      return undefined;
    }
    const timer = setInterval(() => void refresh(), isActive ? REFRESH_WHILE_ACTIVE_MS : REFRESH_WHILE_WAITING_MS);
    return () => clearInterval(timer);
  }, [isActive, isWaiting, refresh]);

  /** Sends one change and returns its response, marking the change for any read that overlaps it. */
  const change = useCallback(async (request: () => Promise<Response>): Promise<Response> => {
    changeEpochRef.current += 1;
    try {
      return await request();
    } finally {
      changeEpochRef.current += 1;
    }
  }, []);

  const update = useCallback(async (request: () => Promise<Response>) => {
    try {
      const response = await change(request);
      const next = await readState(response.clone());
      if (next) {
        setState(next);
        setNotice(null);
      } else {
        setNotice(await readErrorMessage(response));
        await refresh();
      }
    } catch (error) {
      console.error('Night queue request failed:', error);
    }
  }, [change, refresh]);

  const turnOff = useCallback(async () => {
    setCarried(null);
    if (!sessionId) {
      setNewChat(null);
      return;
    }
    try {
      const response = await change(() => api.nightQueue.setEnabled(sessionId, false));
      if (response.status === 409) {
        // Prompts were stored meanwhile (another tab or device): ask, the way the moon does when it knows.
        await refresh();
        setConfirmingFor(sessionId);
        return;
      }
      const updated = await readState(response);
      if (updated) {
        setState(updated);
      } else {
        await refresh();
      }
    } catch (error) {
      console.error('Night queue request failed:', error);
    }
  }, [change, refresh, sessionId]);

  const turnOn = useCallback((useBypass: boolean) => {
    const settings: NightQueueSettings = { ...NIGHT_WINDOW, useBypass };
    if (!sessionId) {
      if (newChatScope) {
        setNewChat({ scope: newChatScope, settings });
      }
      return;
    }
    void update(() => api.nightQueue.setEnabled(sessionId, true, settings));
  }, [newChatScope, sessionId, update]);

  const onToggle = useCallback(() => {
    setNotice(null);
    if (!enabled) {
      // A chat already in bypass mode has nothing to ask about.
      if (permissionMode === 'bypassPermissions') {
        turnOn(true);
      } else {
        setAskingFor(scopeKey);
      }
    } else if (pendingCount > 0) {
      setConfirmingFor(sessionId);
    } else {
      void turnOff();
    }
  }, [enabled, pendingCount, permissionMode, scopeKey, sessionId, turnOff, turnOn]);

  const onAnswerBypass = useCallback((useBypass: boolean) => {
    setAskingFor(null);
    turnOn(useBypass);
  }, [turnOn]);

  const onCancelBypass = useCallback(() => setAskingFor(null), []);

  const onRunNow = useCallback(() => {
    setConfirmingFor(null);
    setCarried(null);
    if (sessionId) {
      void update(() => api.nightQueue.runNow(sessionId));
    }
  }, [sessionId, update]);

  const onCancelAll = useCallback(() => {
    setConfirmingFor(null);
    setCarried(null);
    if (sessionId) {
      void update(() => api.nightQueue.cancelAll(sessionId));
    }
  }, [sessionId, update]);

  const onCloseConfirm = useCallback(() => setConfirmingFor(null), []);

  const onCancelItem = useCallback((id: string) => {
    void update(() => api.nightQueue.cancel(id));
  }, [update]);

  /**
   * Stores one prompt in `targetSessionId`'s queue under the settings on screen (they only matter for a new
   * chat, whose session has none yet), at `startAt` when the prompt named its own time; says why when the
   * server refused it.
   */
  const enqueue = useCallback(async (
    targetSessionId: string,
    content: string,
    options: Record<string, unknown>,
    startAt: string | null = null,
  ): Promise<NightQueueStoreResult> => {
    // The composer calls the instance from the render it submitted in, so this is what the user saw — for a
    // new chat, the settings chosen before its session existed.
    const settings = mode ?? { ...NIGHT_WINDOW, useBypass: false };
    setCarried({ sessionId: targetSessionId, settings });
    try {
      const response = await change(() => api.nightQueue.enqueue(targetSessionId, {
        content,
        options,
        mode: settings,
        startAt,
      }));
      if (!response.ok) {
        return { ok: false, message: await readErrorMessage(response) };
      }
      const next = await readState(response);
      if (!next) {
        return { ok: false, message: null };
      }
      setState(next);
      setCarried(null);
      return { ok: true };
    } catch (error) {
      console.error('Failed to store the prompt in the night queue:', error);
      return { ok: false, message: null };
    }
  }, [change, mode]);

  const controls: NightQueueControls = {
    enabled,
    mode,
    items,
    pendingCount,
    isAskingBypass,
    isConfirming,
    notice,
    onToggle,
    onAnswerBypass,
    onCancelBypass,
    onRunNow,
    onCancelAll,
    onCloseConfirm,
    onCancelItem,
  };

  return { controls, enqueue };
}
