/** DHC CLI night queue: the clock arithmetic behind the start-time picker and the queue labels. */
import { authenticatedFetch } from '@/shared/api';

/** "12:05", or with the date when it is not today: "9/25 12:05". */
export function formatStartAt(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/** The next time the clock shows `hhmm` ("12:05") at least a minute from now: today, else tomorrow. */
export function nextOccurrence(hhmm: string, now: Date = new Date()): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) {
    return null;
  }
  const at = new Date(now);
  at.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (at.getTime() <= now.getTime() + 60_000) {
    at.setDate(at.getDate() + 1);
  }
  return at;
}

export type StartAnnotation =
  | { kind: 'none' }
  /** "@夜間 …": the server's night window (01:00), spelled out; same as no annotation while 分流 is on. */
  | { kind: 'night'; rest: string };

/**
 * DHC CLI 11/01: 分流 only queues for the night. A prompt's own time ("@12:05") and the quota reset moved to the
 * composer's clock (排程送出), so "@夜間" (full-width ＠ too, an IME types it) is the one marker left.
 */
export function parseStartAnnotation(text: string): StartAnnotation {
  const night = /^\s*[@＠]\s*夜間\s*/.exec(text);
  return night ? { kind: 'night', rest: text.slice(night[0].length) } : { kind: 'none' };
}

/**
 * When the 5-hour quota next resets — from the usage cache the sidebar meter reads. 'fresh' when the
 * reset time is already past (nothing to wait for); 'unknown' when it could not be read at all, which is not the same.
 */
export async function readQuotaReset(): Promise<Date | 'fresh' | 'unknown'> {
  try {
    const response = await authenticatedFetch('/api/dhc/usage', { cache: 'no-store' });
    if (!response.ok) {
      return 'unknown';
    }
    const usage = await response.json();
    const resetsAt = usage?.session?.resets_at;
    const date = typeof resetsAt === 'string' ? new Date(resetsAt) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return 'unknown';
    }
    return date.getTime() > Date.now() ? date : 'fresh';
  } catch {
    return 'unknown';
  }
}
