/**
 * DHC CLI 2026-09-26: one place for how the transcript shows time.
 * Bubbles show a short clock (HH:mm), the full stamp lives in the tooltip, and the
 * message list draws a day divider whenever the calendar day changes.
 */
type Stamp = string | number | Date | null | undefined;

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function toDate(stamp: Stamp): Date | null {
  if (stamp === null || stamp === undefined || stamp === '') return null;
  const d = stamp instanceof Date ? stamp : new Date(stamp);
  return Number.isFinite(d.getTime()) ? d : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "15:04" — what sits on the bubble. */
export function formatClock(stamp: Stamp): string {
  const d = toDate(stamp);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}

/** "2026/09/26 15:04:07" — the tooltip. */
export function formatFullStamp(stamp: Stamp): string {
  const d = toDate(stamp);
  if (!d) return '';
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "42秒" / "2分13秒" / "1小時5分" for the time a reply took (from the prompt to the reply); '' when unknown. */
export function formatElapsed(from: Stamp, to: Stamp): string {
  const a = toDate(from), b = toDate(to);
  if (!a || !b) return '';
  const secs = Math.round((b.getTime() - a.getTime()) / 1000);
  if (secs < 1) return '';
  if (secs < 60) return `${secs}秒`;
  const mins = Math.floor(secs / 60), rest = secs % 60;
  if (mins < 60) return rest ? `${mins}分${rest}秒` : `${mins}分`;
  const hours = Math.floor(mins / 60), m = mins % 60;
  return m ? `${hours}小時${m}分` : `${hours}小時`;
}

export function isSameDay(a: Stamp, b: Stamp): boolean {
  const da = toDate(a), db = toDate(b);
  if (!da || !db) return false;
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/** "今天" / "昨天" / "9月24日（週三）" / "2025年12月31日（週三）" for the day divider. */
export function formatDayLabel(stamp: Stamp, now: Date = new Date()): string {
  const d = toDate(stamp);
  if (!d) return '';
  if (isSameDay(d, now)) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return '昨天';
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日（週${WEEKDAYS[d.getDay()]}）`;
}
