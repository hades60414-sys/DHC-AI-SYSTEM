import { dateKey, daysBetween } from '@/shared/personTodos';
import type { TodoItem } from '@/shared/personTodos';
import { cn } from '@/shared/utils';

/** Due within this many days turns amber. */
const DUE_SOON_DAYS = 3;
/** A task with no due date that has sat open this long shows its age; at the second mark it turns amber. */
const AGE_SHOW_DAYS = 7;
const AGE_WARN_DAYS = 14;

type Tag = { label: string; title: string; tone: 'muted' | 'amber' | 'red' };

/**
 * 10/13: at most one small word after an open task's title. With a due date it counts down to it; without one,
 * a task that has sat long enough shows how many days old it is (`showAge`, only on cards and today's top rows).
 */
export function timeTag(item: TodoItem, showAge: boolean, now = new Date()): Tag | null {
  if (item.done) return null;
  const today = dateKey(now);
  if (item.due) {
    const left = daysBetween(today, item.due);
    const [, month, day] = item.due.split('-').map(Number);
    const title = `期限 ${item.due}`;
    if (left < 0) return { label: `過 ${-left} 天`, title, tone: 'red' };
    if (left === 0) return { label: '今天', title, tone: 'red' };
    if (left <= DUE_SOON_DAYS) return { label: `剩 ${left} 天`, title, tone: 'amber' };
    return { label: `${month}/${day}`, title, tone: 'muted' };
  }
  if (!showAge || !item.createdAt) return null;
  const age = daysBetween(dateKey(new Date(item.createdAt)), today);
  if (age < AGE_SHOW_DAYS) return null;
  return { label: `${age} 天`, title: `已經放了 ${age} 天`, tone: age >= AGE_WARN_DAYS ? 'amber' : 'muted' };
}

const TONES = { muted: 'text-muted-foreground', amber: 'text-amber-600 dark:text-amber-400', red: 'text-red-600 dark:text-red-400' };

export default function TimeTag({ item, showAge, className }: { item: TodoItem; showAge: boolean; className?: string }) {
  const tag = timeTag(item, showAge);
  if (!tag) return null;
  return (
    <span title={tag.title} className={cn('shrink-0 whitespace-nowrap text-[11px] tabular-nums', TONES[tag.tone], className)}>
      {tag.label}
    </span>
  );
}
