import { useCallback, useSyncExternalStore } from 'react';

/**
 * DHC CLI C1: pinned sessions stay at the top of their project's list. Per browser (localStorage),
 * because "my 2–3 everyday sessions" is a personal thing on a shared machine.
 */
const STORAGE_KEY = 'dhc.pinnedSessions';

let pinned: ReadonlySet<string> = readPinned();
const listeners = new Set<() => void>();

function readPinned(): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writePinned(next: ReadonlySet<string>): void {
  pinned = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Storage blocked: the pin still works for this page load.
  }
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => pinned;

export function togglePinnedSession(sessionId: string): void {
  const next = new Set(pinned);
  if (next.has(sessionId)) next.delete(sessionId);
  else next.add(sessionId);
  writePinned(next);
}

export function usePinnedSessions(): { pinnedIds: ReadonlySet<string>; isPinned: (id: string) => boolean; togglePin: (id: string) => void } {
  const pinnedIds = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isPinned = useCallback((id: string) => pinnedIds.has(id), [pinnedIds]);
  return { pinnedIds, isPinned, togglePin: togglePinnedSession };
}

/** Pinned rows first (keeping their relative order), then everything else in the given order. */
export function orderPinnedFirst<T extends { id: string }>(sessions: readonly T[], pinnedIds: ReadonlySet<string>): T[] {
  if (pinnedIds.size === 0) return [...sessions];
  const top: T[] = [];
  const rest: T[] = [];
  for (const session of sessions) (pinnedIds.has(session.id) ? top : rest).push(session);
  return [...top, ...rest];
}
