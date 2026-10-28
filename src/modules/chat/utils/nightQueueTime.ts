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
  | { kind: 'time'; startAt: Date; rest: string }
  | { kind: 'reset'; rest: string }
  /** "@夜間 …": the server's night window (02:00), spelled out; same as no annotation while 分流 is on. */
  | { kind: 'night'; rest: string }
  | { kind: 'invalid'; message: string };

/**
 * A night-queue prompt may begin with its own start time: "@12:05 …" (the next time the clock shows it) or
 * "@重置 …" (when the 5-hour quota resets). Full-width ＠ and ： count too — an IME types them. Anything else
 * after "@" (a file mention such as "@README.md") is not a time and is left alone.
 */
export function parseStartAnnotation(text: string, now: Date = new Date()): StartAnnotation {
  const reset = /^\s*[@＠]\s*重置\s*/.exec(text);
  if (reset) {
    return { kind: 'reset', rest: text.slice(reset[0].length) };
  }
  const night = /^\s*[@＠]\s*夜間\s*/.exec(text);
  if (night) {
    return { kind: 'night', rest: text.slice(night[0].length) };
  }

  const time = /^\s*[@＠]\s*(\d{1,2})\s*[:：]\s*(\d+)\s*/.exec(text);
  if (!time) {
    return { kind: 'none' };
  }
  const hours = Number(time[1]);
  const minutes = Number(time[2]);
  if (time[2].length !== 2 || hours > 23 || minutes > 59) {
    return { kind: 'invalid', message: `看不懂「${time[0].trim()}」這個時間，請寫成 @12:05 這樣（24 小時制）。` };
  }
  const startAt = nextOccurrence(`${hours}:${time[2]}`, now);
  return startAt ? { kind: 'time', startAt, rest: text.slice(time[0].length) } : { kind: 'invalid', message: '看不懂這個時間。' };
}

/**
 * When the 5-hour quota next resets — from the usage cache the sidebar meter reads. Null when it
 * is unknown or already past (then the quota is fresh and there is nothing to wait for).
 */
export async function readQuotaReset(): Promise<Date | null> {
  try {
    const response = await authenticatedFetch('/api/dhc/usage', { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const usage = await response.json();
    const resetsAt = usage?.session?.resets_at;
    const date = typeof resetsAt === 'string' ? new Date(resetsAt) : null;
    return date && !Number.isNaN(date.getTime()) && date.getTime() > Date.now() ? date : null;
  } catch {
    return null;
  }
}
