import { useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import { getWorkspaceRootName } from '@/shared/dhcConfig';

/**
 * DHC CLI 快閃任務: one-off sessions get an × on the sidebar row and a 「結束任務」 button above the chat; both
 * move the session to the archive without the archive-or-delete dialog, and a page load 7 days later deletes
 * it for good (the trash below). Until 10/05 they lived in the workspace root's `快閃任務區` folder; that folder
 * is now hidden from the project list but still counts.
 */
const FLASH_FOLDER = '快閃任務區';

export const isFlashProject = (project: { fullPath?: string; path?: string } | null | undefined): boolean => {
  const parts = String(project?.fullPath || project?.path || '').split(/[\\/]+/).filter(Boolean);
  return parts.length >= 2 && parts[parts.length - 1] === FLASH_FOLDER && parts[parts.length - 2] === getWorkspaceRootName();
};

const listeners = new Set<(sessionId: string) => void>();

/** Project state and the recents list each drop the session here, whichever button deleted it. */
export function onFlashSessionEnded(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Archives the session (restorable from the 封存 tab) and puts it in the trash. A 404 means it is already
 * gone — a double click or another tab — same outcome.
 */
export async function endFlashSession(sessionId: string): Promise<void> {
  try {
    const response = await api.deleteSession(sessionId, false);
    if (!response.ok && response.status !== 404) {
      throw new Error(`archive failed: ${response.status}`);
    }
  } catch (error) {
    console.error('[FlashTasks] Failed to end session:', error);
    alert('結束失敗，請重新整理頁面後再試一次。');
    return;
  }
  listeners.forEach((listener) => listener(sessionId));
  void setSessionFlash(sessionId, false);
  void updateTrash((current) => ({ ...current, [sessionId]: new Date().toISOString() }));
}

/**
 * DHC CLI 10/05 快閃任務 is a per-session switch, like the night queue's moon: the ⚡ in the composer marks
 * any session in any project. Marks live on the server in one user_preferences key so every device sees the
 * same bolts; a save re-reads the server's list and applies the same change, so marks made elsewhere stay.
 * A session in the old 快閃任務區 folder still counts as flash.
 */
const PREF_KEY = 'dhc.flashSessions';
const RELOAD_ON_FOCUS_MIN_MS = 30_000;

let flashIds: ReadonlySet<string> = new Set();
/** Projects whose next new conversation starts as a flash task (the ⚡ was pressed before the first send). */
let pendingNewByProject: ReadonlySet<string> = new Set();
let writeChain: Promise<void> = Promise.resolve();
let writesInFlight = 0;
let lastLoadAt = 0;
const storeListeners = new Set<() => void>();

const notifyStore = () => storeListeners.forEach((listener) => listener());
const subscribeStore = (listener: () => void) => {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
};

export const parseFlashIds = (value: unknown): Set<string> =>
  new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []);

async function fetchServerPreference(key: string): Promise<unknown> {
  const response = await api.user.preferences();
  if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
  const payload = (await response.json()) as { preferences?: Record<string, unknown> };
  return payload.preferences?.[key];
}

async function fetchServerFlashIds(): Promise<Set<string>> {
  return parseFlashIds(await fetchServerPreference(PREF_KEY));
}

export async function loadFlashSessions(): Promise<void> {
  lastLoadAt = Date.now();
  try {
    const next = await fetchServerFlashIds();
    if (writesInFlight > 0) return;
    flashIds = next;
    notifyStore();
  } catch (error) {
    console.error('[FlashTasks] Failed to load flash marks:', error);
  }
}

/** Loads the marks now and whenever the tab comes back into view, and empties the expired trash; returns the cleanup. */
export function startFlashSessionsSync(): () => void {
  void loadFlashSessions();
  void purgeExpiredFlashTrash();
  const reloadWhenVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadAt > RELOAD_ON_FOCUS_MIN_MS) {
      void loadFlashSessions();
    }
  };
  document.addEventListener('visibilitychange', reloadWhenVisible);
  return () => document.removeEventListener('visibilitychange', reloadWhenVisible);
}

const withMark = (ids: ReadonlySet<string>, sessionId: string, on: boolean): Set<string> => {
  const next = new Set(ids);
  if (on) next.add(sessionId);
  else next.delete(sessionId);
  return next;
};

export function setSessionFlash(sessionId: string, on: boolean): Promise<void> {
  if (!sessionId || flashIds.has(sessionId) === on) return writeChain;
  flashIds = withMark(flashIds, sessionId, on);
  notifyStore();
  writesInFlight += 1;
  writeChain = writeChain.then(async () => {
    try {
      const next = withMark(await fetchServerFlashIds(), sessionId, on);
      const response = await api.user.savePreferences({ [PREF_KEY]: [...next] });
      if (!response.ok) throw new Error(`Failed to save flash marks (${response.status})`);
      if (writesInFlight === 1) {
        flashIds = next;
        notifyStore();
      }
    } catch (error) {
      console.error('[FlashTasks] Failed to save flash mark:', error);
    } finally {
      writesInFlight -= 1;
    }
  });
  return writeChain;
}

export const isFlashSessionId = (sessionId: string | null | undefined): boolean => Boolean(sessionId && flashIds.has(sessionId));

export function useIsFlashSession(sessionId: string | null | undefined, project?: { fullPath?: string; path?: string } | null): boolean {
  const marked = useSyncExternalStore(subscribeStore, () => isFlashSessionId(sessionId), () => false);
  return marked || isFlashProject(project);
}

export function setNewSessionFlash(projectId: string, on: boolean): void {
  if (pendingNewByProject.has(projectId) === on) return;
  pendingNewByProject = withMark(pendingNewByProject, projectId, on);
  notifyStore();
}

export function useNewSessionFlash(projectId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribeStore, () => Boolean(projectId && pendingNewByProject.has(projectId)), () => false);
}

/** Called when a new conversation gets its id: it becomes a flash task if the ⚡ was on before the first send. */
export function fileNewSessionFlash(projectId: string, sessionId: string): void {
  if (!pendingNewByProject.has(projectId)) return;
  setNewSessionFlash(projectId, false);
  void setSessionFlash(sessionId, true);
}

/**
 * DHC CLI 10/05 回收桶: ended flash tasks wait here for 7 days under one user_preferences key that every device
 * shares (`{ [sessionId]: endedAt }`). The first page load after that deletes them for good — only if they are
 * still archived, so a restored conversation is never touched.
 */
const TRASH_KEY = 'dhc.flashTrash';
export const FLASH_TRASH_DAYS = 7;
const DAY_MS = 86_400_000;

let trash: Readonly<Record<string, string>> = {};
let trashChain: Promise<void> = Promise.resolve();

export const parseFlashTrash = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([id, endedAt]) => id && typeof endedAt === 'string' && !Number.isNaN(Date.parse(endedAt))),
  ) as Record<string, string>;
};

/**
 * Days until a trashed session is deleted, 1–7 while it waits, or null when it is not in the trash. Capped at 7
 * because the sidebar's clock ticks once a minute and can trail a session ended a moment ago.
 */
export const flashTrashDaysLeft = (endedAt: string | undefined, now: number): number | null =>
  endedAt
    ? Math.min(FLASH_TRASH_DAYS, Math.max(1, Math.ceil((Date.parse(endedAt) + FLASH_TRASH_DAYS * DAY_MS - now) / DAY_MS)))
    : null;

/** Re-reads the server's trash and applies `change` (null = nothing to save), so other devices' entries survive. */
function updateTrash(change: (current: Record<string, string>) => Record<string, string> | null): Promise<void> {
  trashChain = trashChain.then(async () => {
    try {
      const next = change(parseFlashTrash(await fetchServerPreference(TRASH_KEY)));
      if (!next) return;
      const response = await api.user.savePreferences({ [TRASH_KEY]: next });
      if (!response.ok) throw new Error(`Failed to save the flash trash (${response.status})`);
      trash = next;
      notifyStore();
    } catch (error) {
      console.error('[FlashTasks] Failed to update the flash trash:', error);
    }
  });
  return trashChain;
}

/** A restored conversation leaves the trash, so archiving it again later is never purged by the old entry. */
export function forgetFlashTrash(sessionId: string): Promise<void> {
  return updateTrash((current) => (
    sessionId in current ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== sessionId)) : null
  ));
}

/**
 * Deletes trashed sessions whose 7 days are up and that are still archived; entries for sessions that were
 * restored or are already gone are dropped. Runs once per page load; a 404 means another tab got there first.
 */
export async function purgeExpiredFlashTrash(now = Date.now()): Promise<void> {
  try {
    const current = parseFlashTrash(await fetchServerPreference(TRASH_KEY));
    trash = current;
    notifyStore();
    const expired = Object.keys(current).filter((id) => now - Date.parse(current[id]) >= FLASH_TRASH_DAYS * DAY_MS);
    if (expired.length === 0) return;

    const response = await api.getArchivedSessions();
    if (!response.ok) throw new Error(`Failed to load archived sessions (${response.status})`);
    const payload = (await response.json()) as { data?: { sessions?: { sessionId?: string }[] } };
    const archived = new Set((payload.data?.sessions ?? []).map((session) => session.sessionId));

    const settled: string[] = [];
    for (const sessionId of expired) {
      if (archived.has(sessionId)) {
        const deleted = await api.deleteSession(sessionId, true);
        if (!deleted.ok && deleted.status !== 404) continue;
      }
      settled.push(sessionId);
    }
    if (settled.length > 0) {
      await updateTrash((latest) => Object.fromEntries(Object.entries(latest).filter(([id]) => !settled.includes(id))));
    }
  } catch (error) {
    console.error('[FlashTasks] Failed to purge the flash trash:', error);
  }
}

export function useFlashTrash(): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribeStore, () => trash, () => trash);
}
