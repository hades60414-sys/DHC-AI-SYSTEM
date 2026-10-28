import { ClipboardCheck, Loader2, MessageCircleQuestion } from 'lucide-react';

import { Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { WAITING_LABELS, type WaitingKind } from '@/shared/waitingOnYou';

type BackgroundWorkIndicatorProps = {
  label: string;
  className?: string;
  /** 'right' where the light sits near the sidebar's left edge, so the tooltip is not cut off. */
  position?: 'top' | 'right';
};

/**
 * DHC CLI: the violet spinner a sidebar row shows when a session's turn is over but its subagents or
 * background shells are still running, or Claude is answering what they reported. Same shape as the gray
 * "processing" spinner so it reads as still running, a different color so it reads as in the background.
 */
export default function BackgroundWorkIndicator({ label, className, position = 'top' }: BackgroundWorkIndicatorProps) {
  return (
    <Tooltip content={label} position={position}>
      <span
        role="status"
        aria-label={label}
        className={cn('flex h-5 w-5 items-center justify-center rounded-md text-violet-500 dark:text-violet-400', className)}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    </Tooltip>
  );
}

/**
 * DHC CLI: the green heartbeat on a sidebar row's left edge — the session is running, either answering or
 * with subagents / background shells still going. Replaces the old "touched in the last 10 minutes" green dot,
 * which looked the same but meant nothing was running.
 */
export function RunningHeartbeat({ label }: { label: string }) {
  return (
    <Tooltip content={label} position="right">
      <span role="status" aria-label={label} data-testid="running-heartbeat" className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
      </span>
    </Tooltip>
  );
}

/**
 * DHC CLI: the reminder on a row whose session stopped on a prompt only a person can answer — a question mark
 * for a multiple-choice question, a clipboard check for something to review (plan, tool permission). Amber like
 * the attention dot, but an icon, so it reads as "your turn" rather than "something happened".
 */
export function WaitingIndicator({ kind, className, position = 'top' }: {
  kind: WaitingKind;
  className?: string;
  position?: 'top' | 'right';
}) {
  const Icon = kind === 'question' ? MessageCircleQuestion : ClipboardCheck;
  const label = WAITING_LABELS[kind];
  return (
    <Tooltip content={label} position={position}>
      <span
        role="status"
        aria-label={label}
        data-testid="waiting-indicator"
        data-kind={kind}
        className={cn('flex h-5 w-5 items-center justify-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400', className)}
      >
        <Icon className="h-3.5 w-3.5 animate-pulse" />
      </span>
    </Tooltip>
  );
}
