import { FlaskConical, Moon, Zap } from 'lucide-react';

import { useIsDistillSession } from '@/shared/distillSessions';
import { useIsFlashSession } from '@/shared/flashTasks';
import { useNightQueueMark } from '@/shared/nightQueueMarks';

type SessionTypeBadgeProps = {
  sessionId: string;
  isFlash: boolean;
};

/**
 * DHC CLI: the small mark on a session row's provider logo (render it inside a `relative` box) — a moon while
 * the night queue holds the session (moon on, or prompts stored and not finished), a bolt for a 快閃任務
 * session (marked with the composer ⚡, or in the old 快閃任務區 folder), a flask for a 蒸餾模式 session. When several
 * apply the moon shows, since it means something is still going to run, then the bolt; the tooltip names the rest.
 */
export default function SessionTypeBadge({ sessionId, isFlash: inFlashFolder }: SessionTypeBadgeProps) {
  const night = useNightQueueMark(sessionId);
  const isFlash = useIsFlashSession(sessionId) || inFlashFolder;
  const isDistill = useIsDistillSession(sessionId);
  if (!night && !isFlash && !isDistill) return null;

  const distillSuffix = isDistill ? '（蒸餾模式）' : '';
  const label = night
    ? `${night.queued > 0 ? `夜間分流：已存 ${night.queued} 則，等排程開跑` : '夜間分流開著：新訊息會先存起來'}${isFlash ? '（快閃任務）' : ''}${distillSuffix}`
    : isFlash
      ? `快閃任務：做完按 ×，7 天後自動刪除${distillSuffix}`
      : '蒸餾模式：這個對話的判斷會記下來，結案時整理成技能';
  const Icon = night ? Moon : isFlash ? Zap : FlaskConical;

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="absolute -left-1.5 -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-border"
    >
      <Icon
        className={
          night
            ? 'h-2.5 w-2.5 fill-indigo-400 text-indigo-400'
            : isFlash ? 'h-2.5 w-2.5 fill-amber-400 text-amber-500' : 'h-2.5 w-2.5 text-emerald-500'
        }
      />
    </span>
  );
}
