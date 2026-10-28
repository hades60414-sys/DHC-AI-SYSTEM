import { useCallback, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

/**
 * DHC CLI: which sessions carry the night queue's moon — night mode on, or prompts stored and not yet finished.
 * One request lists them all (GET /api/night-queue/sessions, polled by SessionProtectionContext); the composer
 * also writes its own session here as soon as its state changes, so a sidebar badge follows the moon at once.
 */
export type NightQueueMark = {
  enabled: boolean;
  /** Prompts waiting or running. */
  queued: number;
};

let byId: ReadonlyMap<string, NightQueueMark> = new Map();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const sameMark = (a: NightQueueMark | undefined, b: NightQueueMark | undefined) =>
  a?.enabled === b?.enabled && a?.queued === b?.queued;

const publish = (next: ReadonlyMap<string, NightQueueMark>) => {
  byId = next;
  listeners.forEach((listener) => listener());
};

/** Replaces the whole picture with the server's list; readers hear about it only when something changed. */
export function setNightQueueMarks(items: unknown): void {
  const next = new Map<string, NightQueueMark>();
  for (const item of Array.isArray(items) ? items : []) {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    if (typeof record.sessionId !== 'string' || !record.sessionId) continue;
    const queued = Number(record.queued) > 0 ? Number(record.queued) : 0;
    if (record.enabled === true || queued > 0) next.set(record.sessionId, { enabled: record.enabled === true, queued });
  }
  if (next.size === byId.size && [...next].every(([id, mark]) => sameMark(mark, byId.get(id)))) return;
  publish(next);
}

/** One session's fresh state, from the composer that has it open. */
export function noteNightQueueState(sessionId: string, enabled: boolean, queued: number): void {
  const mark = enabled || queued > 0 ? { enabled, queued } : undefined;
  if (sameMark(mark, byId.get(sessionId))) return;
  const next = new Map(byId);
  if (mark) next.set(sessionId, mark);
  else next.delete(sessionId);
  publish(next);
}

export function useNightQueueMark(sessionId: string): NightQueueMark | null {
  const getSnapshot = useCallback(() => byId.get(sessionId) ?? null, [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Reads the list once. False when the server cannot give it — before 2026-10-02 it has no such route and
 * answers with the app's HTML page — so the caller can ask much less often.
 */
export async function refreshNightQueueMarks(): Promise<boolean> {
  try {
    const response = await api.nightQueue.list();
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) return false;
    const payload = (await response.json()) as { data?: { sessions?: unknown } };
    setNightQueueMarks(payload.data?.sessions);
    return true;
  } catch {
    return false;
  }
}
