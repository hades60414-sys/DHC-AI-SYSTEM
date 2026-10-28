import { useCallback, useSyncExternalStore } from 'react';

/**
 * DHC CLI: sessions stopped on a prompt only a person can answer — a multiple-choice question (AskUserQuestion)
 * or something to review (a plan to approve, a tool to allow). Sidebar rows show a reminder icon for them until
 * the prompt is answered, whichever device answers it.
 *
 * Two sources feed it: the live `permission_request` / `permission_resolved` / `permission_cancelled` events this
 * tab receives, and the `waiting` list of the 5-second GET /sessions/running poll, which also covers prompts raised
 * before this tab opened or on another device. A poll replaces the whole picture; servers before 2026-10-12 omit
 * the list, and then only live events count.
 */
export type WaitingKind = 'question' | 'review';

/** sessionId → requestId → kind */
let byId: ReadonlyMap<string, ReadonlyMap<string, WaitingKind>> = new Map();
let kindById: ReadonlyMap<string, WaitingKind> = new Map();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** A choice question outranks a review: it is the one the user cannot answer by just pressing allow. */
const summarize = (requests: ReadonlyMap<string, WaitingKind>): WaitingKind | null => {
  let kind: WaitingKind | null = null;
  for (const value of requests.values()) {
    if (value === 'question') return 'question';
    kind = value;
  }
  return kind;
};

const publish = (next: Map<string, Map<string, WaitingKind>>) => {
  for (const [sessionId, requests] of next) {
    if (requests.size === 0) next.delete(sessionId);
  }
  const nextKinds = new Map<string, WaitingKind>();
  for (const [sessionId, requests] of next) {
    const kind = summarize(requests);
    if (kind) nextKinds.set(sessionId, kind);
  }
  const sameKinds = nextKinds.size === kindById.size
    && [...nextKinds].every(([sessionId, kind]) => kindById.get(sessionId) === kind);
  byId = next;
  if (sameKinds) return;
  kindById = nextKinds;
  listeners.forEach((listener) => listener());
};

const copy = () => new Map([...byId].map(([sessionId, requests]) => [sessionId, new Map(requests)]));

export const waitingKindForTool = (toolName: unknown): WaitingKind =>
  (toolName === 'AskUserQuestion' ? 'question' : 'review');

/** A live `permission_request` for a session. */
export function markWaiting(sessionId: string, requestId: string, toolName: unknown): void {
  if (!sessionId || !requestId) return;
  const next = copy();
  const requests = next.get(sessionId) ?? new Map<string, WaitingKind>();
  requests.set(requestId, waitingKindForTool(toolName));
  next.set(sessionId, requests);
  publish(next);
}

/** A live `permission_resolved` / `permission_cancelled`. Without a session id every session is searched. */
export function clearWaitingRequest(requestId: string, sessionId?: string | null): void {
  if (!requestId) return;
  const next = copy();
  for (const [id, requests] of next) {
    if (sessionId && id !== sessionId) continue;
    requests.delete(requestId);
  }
  publish(next);
}

/** The run ended (completed, failed or stopped): nothing of it can still be waiting. */
export function clearWaitingSession(sessionId: string): void {
  if (!byId.has(sessionId)) return;
  const next = copy();
  next.delete(sessionId);
  publish(next);
}

/** Replaces the whole picture with the server's `waiting` list; `undefined` (older server) leaves it alone. */
export function setWaitingFromServer(items: unknown): void {
  if (!Array.isArray(items)) return;
  const next = new Map<string, Map<string, WaitingKind>>();
  for (const item of items) {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    if (typeof record.sessionId !== 'string' || !record.sessionId) continue;
    if (typeof record.requestId !== 'string' || !record.requestId) continue;
    const requests = next.get(record.sessionId) ?? new Map<string, WaitingKind>();
    requests.set(record.requestId, waitingKindForTool(record.toolName));
    next.set(record.sessionId, requests);
  }
  publish(next);
}

/** What this session waits on, or null. */
export function useWaitingKind(sessionId: string | null | undefined): WaitingKind | null {
  const getSnapshot = useCallback(() => (sessionId ? kindById.get(sessionId) ?? null : null), [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Every waiting session by id; the same Map until something changes. */
export function useWaitingMap(): ReadonlyMap<string, WaitingKind> {
  return useSyncExternalStore(subscribe, () => kindById, () => kindById);
}

export const WAITING_LABELS: Record<WaitingKind, string> = {
  question: '等你回答選擇題',
  review: '等你覆核',
};

/** Test hook: back to empty. */
export function resetWaitingForTests(): void {
  byId = new Map();
  kindById = new Map();
  listeners.forEach((listener) => listener());
}

/** The most pressing wait among these sessions (a question outranks a review), or null — for project and box rows. */
export function pickWaiting(sessionIds: Iterable<string>, waiting: ReadonlyMap<string, WaitingKind>): WaitingKind | null {
  let kind: WaitingKind | null = null;
  for (const sessionId of sessionIds) {
    const value = waiting.get(sessionId);
    if (value === 'question') return 'question';
    if (value) kind = value;
  }
  return kind;
}
