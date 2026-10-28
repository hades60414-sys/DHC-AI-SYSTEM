import { useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

/**
 * DHC CLI 收納盒: under each person (project) the sidebar can group sessions into named boxes.
 *
 * A box is only a label: the session keeps its folder and transcript, which is why any old session
 * can be dragged in. Boxes live on the server in user_preferences, one global key per project
 * (`dhc.boxes:<projectId>`, no settings-profile prefix), so every device shows the same boxes; an
 * open tab picks up other devices' changes when it comes back into view. Which boxes are open is a
 * per-browser choice in localStorage.
 */
export type SessionBox = { id: string; name: string };
/** `assign` maps a session id to its box; a session without an entry stays outside every box. */
export type ProjectBoxes = { boxes: SessionBox[]; assign: Record<string, string> };
export type DraggedSession = { sessionId: string; projectId: string };

const KEY_PREFIX = 'dhc.boxes:';
const OPEN_BOXES_STORAGE_KEY = 'dhc.boxesOpen';
const MAX_BOX_NAME_LENGTH = 30;
const RELOAD_ON_FOCUS_MIN_MS = 30_000;
const EMPTY: ProjectBoxes = { boxes: [], assign: {} };

export function parseProjectBoxes(value: unknown): ProjectBoxes {
  if (!value || typeof value !== 'object') {
    return EMPTY;
  }
  const raw = value as { boxes?: unknown; assign?: unknown };
  const boxes = Array.isArray(raw.boxes)
    ? raw.boxes.filter((box): box is SessionBox => (
      Boolean(box) && typeof (box as SessionBox).id === 'string' && typeof (box as SessionBox).name === 'string'
    ))
    : [];
  const boxIds = new Set(boxes.map((box) => box.id));
  const assign: Record<string, string> = {};
  if (raw.assign && typeof raw.assign === 'object') {
    for (const [sessionId, boxId] of Object.entries(raw.assign as Record<string, unknown>)) {
      if (typeof boxId === 'string' && boxIds.has(boxId)) {
        assign[sessionId] = boxId;
      }
    }
  }
  return { boxes, assign };
}

export const withBoxAdded = (state: ProjectBoxes, box: SessionBox): ProjectBoxes => (
  state.boxes.some((existing) => existing.id === box.id) ? state : { ...state, boxes: [...state.boxes, box] }
);

export const withBoxRenamed = (state: ProjectBoxes, boxId: string, name: string): ProjectBoxes => ({
  ...state,
  boxes: state.boxes.map((box) => (box.id === boxId ? { ...box, name } : box)),
});

/** The box goes; its sessions fall back outside. No session is deleted. */
export const withBoxRemoved = (state: ProjectBoxes, boxId: string): ProjectBoxes => ({
  boxes: state.boxes.filter((box) => box.id !== boxId),
  assign: Object.fromEntries(Object.entries(state.assign).filter(([, assigned]) => assigned !== boxId)),
});

/** `boxId` null, or a box that no longer exists, puts the session back outside. */
export function withSessionMoved(state: ProjectBoxes, sessionId: string, boxId: string | null): ProjectBoxes {
  const assign = { ...state.assign };
  if (boxId && state.boxes.some((box) => box.id === boxId)) {
    assign[sessionId] = boxId;
  } else {
    delete assign[sessionId];
  }
  return { ...state, assign };
}

/** Splits sessions into their boxes (keeping the given order) and the ones outside any box. */
export function groupSessionsByBox<T extends { id: string }>(
  sessions: readonly T[],
  state: ProjectBoxes,
): { inBox: Map<string, T[]>; outside: T[] } {
  const inBox = new Map<string, T[]>(state.boxes.map((box) => [box.id, []]));
  const outside: T[] = [];
  for (const session of sessions) {
    const bucket = inBox.get(state.assign[session.id] ?? '');
    if (bucket) {
      bucket.push(session);
    } else {
      outside.push(session);
    }
  }
  return { inBox, outside };
}

/** How many sessions the box holds that are not among `loadedIds` — older pages not fetched yet, or gone. */
export const countUnloadedBoxMembers = (state: ProjectBoxes, boxId: string, loadedIds: ReadonlySet<string>): number => (
  Object.entries(state.assign).filter(([sessionId, assigned]) => assigned === boxId && !loadedIds.has(sessionId)).length
);

let byProject: ReadonlyMap<string, ProjectBoxes> = new Map();
let openBoxIds: ReadonlySet<string> = readOpenBoxIds();
let newSessionBoxByProject: ReadonlyMap<string, string> = new Map();
let draggedSession: DraggedSession | null = null;
let writesInFlight = 0;
let writeChain: Promise<void> = Promise.resolve();
let lastLoadAt = 0;
let lastAlertAt = 0;
const listeners = new Set<() => void>();

const notify = () => {
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function readOpenBoxIds(): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(OPEN_BOXES_STORAGE_KEY) || '[]') as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeOpenBoxIds(next: ReadonlySet<string>): void {
  openBoxIds = next;
  try {
    localStorage.setItem(OPEN_BOXES_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Storage blocked: the box stays open for this page load.
  }
  notify();
}

function setProjectBoxes(projectId: string, next: ProjectBoxes): void {
  const map = new Map(byProject);
  map.set(projectId, next);
  byProject = map;
  notify();
}

async function fetchPreferenceRows(): Promise<Record<string, unknown>> {
  const response = await api.user.preferences();
  if (!response.ok) {
    throw new Error(`Failed to load preferences (${response.status})`);
  }
  const payload = (await response.json()) as { preferences?: unknown };
  return payload.preferences && typeof payload.preferences === 'object'
    ? payload.preferences as Record<string, unknown>
    : {};
}

export async function loadSessionBoxes(): Promise<void> {
  lastLoadAt = Date.now();
  try {
    const rows = await fetchPreferenceRows();
    if (writesInFlight > 0) {
      // A local change is on its way and its save re-reads the server anyway.
      return;
    }
    const next = new Map<string, ProjectBoxes>();
    for (const [key, value] of Object.entries(rows)) {
      if (key.startsWith(KEY_PREFIX)) {
        next.set(key.slice(KEY_PREFIX.length), parseProjectBoxes(value));
      }
    }
    byProject = next;
    notify();
  } catch (error) {
    console.error('[SessionBoxes] Failed to load boxes:', error);
  }
}

/** Loads the boxes now and again whenever the tab comes back into view; returns the cleanup. */
export function startSessionBoxesSync(): () => void {
  void loadSessionBoxes();
  const reloadWhenVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadAt > RELOAD_ON_FOCUS_MIN_MS) {
      void loadSessionBoxes();
    }
  };
  document.addEventListener('visibilitychange', reloadWhenVisible);
  return () => document.removeEventListener('visibilitychange', reloadWhenVisible);
}

/**
 * Shows the change at once, then re-applies it to the server's latest copy and saves that, so a box
 * made on another device in the meantime is kept. Saves run one at a time.
 */
function updateProjectBoxes(projectId: string, change: (current: ProjectBoxes) => ProjectBoxes): Promise<void> {
  setProjectBoxes(projectId, change(readProjectBoxes(projectId)));
  writesInFlight += 1;
  writeChain = writeChain.then(async () => {
    try {
      const latest = parseProjectBoxes((await fetchPreferenceRows())[KEY_PREFIX + projectId]);
      const next = change(latest);
      const response = await api.user.savePreferences({ [KEY_PREFIX + projectId]: next });
      if (!response.ok) {
        throw new Error(`Failed to save boxes (${response.status})`);
      }
      if (writesInFlight === 1) {
        // The last queued save carries every earlier one, plus whatever other devices added.
        setProjectBoxes(projectId, next);
      }
    } catch (error) {
      console.error('[SessionBoxes] Failed to save boxes:', error);
      if (Date.now() - lastAlertAt > 10_000) {
        lastAlertAt = Date.now();
        alert('收納盒沒有存到伺服器，請重新整理頁面後再試一次。');
      }
    } finally {
      writesInFlight -= 1;
    }
  });
  return writeChain;
}

export function readProjectBoxes(projectId: string): ProjectBoxes {
  return byProject.get(projectId) ?? EMPTY;
}

export function useProjectBoxes(projectId: string): ProjectBoxes {
  return useSyncExternalStore(subscribe, () => readProjectBoxes(projectId), () => EMPTY);
}

const cleanBoxName = (name: string) => name.trim().slice(0, MAX_BOX_NAME_LENGTH);

/** Returns the new box's id, or null for a blank name. */
export function addSessionBox(projectId: string, name: string): string | null {
  const trimmed = cleanBoxName(name);
  if (!trimmed) {
    return null;
  }
  const box = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: trimmed };
  void updateProjectBoxes(projectId, (state) => withBoxAdded(state, box));
  return box.id;
}

export function renameSessionBox(projectId: string, boxId: string, name: string): void {
  const trimmed = cleanBoxName(name);
  if (trimmed) {
    void updateProjectBoxes(projectId, (state) => withBoxRenamed(state, boxId, trimmed));
  }
}

export function removeSessionBox(projectId: string, boxId: string): void {
  void updateProjectBoxes(projectId, (state) => withBoxRemoved(state, boxId));
}

export function moveSessionToBox(projectId: string, sessionId: string, boxId: string | null): void {
  if ((readProjectBoxes(projectId).assign[sessionId] ?? null) === boxId) {
    return;
  }
  void updateProjectBoxes(projectId, (state) => withSessionMoved(state, sessionId, boxId));
}

/** A deleted session leaves its box, so the box count stays right. */
export function forgetSessionInBoxes(sessionId: string): void {
  for (const [projectId, state] of byProject) {
    if (state.assign[sessionId]) {
      void updateProjectBoxes(projectId, (current) => withSessionMoved(current, sessionId, null));
    }
  }
}

export function useOpenBoxIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => openBoxIds, () => openBoxIds);
}

export function toggleBoxOpen(boxId: string): void {
  const next = new Set(openBoxIds);
  if (next.has(boxId)) {
    next.delete(boxId);
  } else {
    next.add(boxId);
  }
  writeOpenBoxIds(next);
}

export function openBox(boxId: string): void {
  if (!openBoxIds.has(boxId)) {
    writeOpenBoxIds(new Set([...openBoxIds, boxId]));
  }
}

/** The box a new conversation in this project will be filed into once it gets its id. */
export function setNewSessionBox(projectId: string, boxId: string | null): void {
  if ((newSessionBoxByProject.get(projectId) ?? null) === boxId) {
    return;
  }
  const next = new Map(newSessionBoxByProject);
  if (boxId) {
    next.set(projectId, boxId);
  } else {
    next.delete(projectId);
  }
  newSessionBoxByProject = next;
  notify();
}

export function useNewSessionBox(projectId: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => newSessionBoxByProject.get(projectId) ?? null,
    () => null,
  );
}

/** Called when a new conversation gets its id: files it into the box picked for it, if any. */
export function fileNewSessionIntoBox(projectId: string, sessionId: string): void {
  const boxId = newSessionBoxByProject.get(projectId);
  if (!boxId) {
    return;
  }
  setNewSessionBox(projectId, null);
  if (!readProjectBoxes(projectId).boxes.some((box) => box.id === boxId)) {
    return;
  }
  openBox(boxId);
  moveSessionToBox(projectId, sessionId, boxId);
}

export function startSessionDrag(session: DraggedSession): void {
  draggedSession = session;
  notify();
}

export function endSessionDrag(): void {
  if (draggedSession) {
    draggedSession = null;
    notify();
  }
}

export function readDraggedSession(): DraggedSession | null {
  return draggedSession;
}

export function useDraggedSession(): DraggedSession | null {
  return useSyncExternalStore(subscribe, () => draggedSession, () => null);
}
