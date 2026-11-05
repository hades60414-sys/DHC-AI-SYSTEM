import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

/**
 * DHC CLI 10/28: conversations an AI opened on its own (a launcher script run by another
 * session or a scheduled task) show 團隊小助理's face instead of the provider logo, so nobody mistakes them for
 * their own. The launcher appends the session id to one user_preferences key; the UI only reads it.
 */
const PREF_KEY = 'dhc.botSessions';
const RELOAD_ON_FOCUS_MIN_MS = 30_000;

let botIds: ReadonlySet<string> = new Set();
let lastLoadAt = 0;
let firstLoadDone = false;
let recheckTimers: ReturnType<typeof setTimeout>[] | null = null;
const storeListeners = new Set<() => void>();

const subscribeStore = (listener: () => void) => {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
};

export const parseBotIds = (value: unknown): Set<string> =>
  new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []);

async function loadBotSessions(): Promise<void> {
  lastLoadAt = Date.now();
  try {
    const response = await api.user.preferences();
    if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
    const payload = (await response.json()) as { preferences?: Record<string, unknown> };
    botIds = parseBotIds(payload.preferences?.[PREF_KEY]);
    storeListeners.forEach((listener) => listener());
  } catch (error) {
    console.error('[BotSessions] Failed to load marks:', error);
  } finally {
    firstLoadDone = true;
  }
}

/**
 * A row that shows up after the first load is a conversation opened since, and the launcher writes its mark a moment
 * after creating it — so re-read twice shortly after. Many rows mounting at once share one pair of reloads.
 */
function recheckSoon(): void {
  if (recheckTimers) return;
  recheckTimers = [
    setTimeout(() => void loadBotSessions(), 1500),
    setTimeout(() => {
      recheckTimers = null;
      void loadBotSessions();
    }, 6000),
  ];
}

/** Loads the marks now and whenever the tab comes back into view; returns the cleanup. */
export function startBotSessionsSync(): () => void {
  void loadBotSessions();
  const reloadWhenVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadAt > RELOAD_ON_FOCUS_MIN_MS) {
      void loadBotSessions();
    }
  };
  document.addEventListener('visibilitychange', reloadWhenVisible);
  return () => document.removeEventListener('visibilitychange', reloadWhenVisible);
}

export function useIsBotSession(sessionId: string): boolean {
  useEffect(() => {
    if (firstLoadDone && !botIds.has(sessionId)) recheckSoon();
  }, [sessionId]);
  return useSyncExternalStore(subscribeStore, () => botIds.has(sessionId), () => false);
}
