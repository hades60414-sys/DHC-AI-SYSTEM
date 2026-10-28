import { quadrantMeta } from '@/modules/todo-dock/quadrants';
import type { Quadrant } from '@/shared/personTodos';
import { cn } from '@/shared/utils';

/**
 * In front of a task: a diamond in its quadrant's colour for a main task, a small dot for a subtask.
 * Hollow while the task has no quadrant yet (未分類).
 */
export default function TaskMarker({ quadrant, main, className }: { quadrant: Quadrant | undefined; main: boolean; className?: string }) {
  const meta = quadrantMeta(quadrant);
  return (
    <span
      aria-hidden
      title={meta ? `${meta.title}（${meta.hint}）` : '未分類'}
      className={cn(
        'shrink-0',
        main ? 'h-2.5 w-2.5 rotate-45 rounded-[2px]' : 'h-1.5 w-1.5 rounded-full',
        meta ? meta.dot : 'border border-muted-foreground/60',
        className,
      )}
    />
  );
}
