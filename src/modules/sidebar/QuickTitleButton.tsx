import { useState, type MouseEvent } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

import { api } from '@/shared/api';
import { cn } from '@/shared/utils';

/**
 * DHC CLI 10/13 「快速取名」: asks the server for a short name of what the session is doing now (Haiku reads the
 * latest user messages, ~10 s) and puts it in the rename box. Nothing is saved until the user confirms the rename.
 */
export default function QuickTitleButton({ sessionId, onTitle, variant = 'compact' }: {
  sessionId: string;
  onTitle: (title: string) => void;
  /** compact = an icon in the desktop rename strip; wide = a labelled button in the phone sheet. */
  variant?: 'compact' | 'wide';
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [hint, setHint] = useState('');

  const run = async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (state === 'busy') return;
    setState('busy');
    setHint('');
    try {
      const response = await api.suggestSessionTitle(sessionId);
      const payload = (await response.json().catch(() => null)) as { data?: { title?: string }; error?: { message?: string } } | null;
      const title = payload?.data?.title;
      if (!response.ok || !title) {
        setState('failed');
        setHint(response.status === 404 ? '這個功能要等系統重啟後才能用' : '這次沒取到名字，再按一次試試');
        return;
      }
      onTitle(title);
      setState('idle');
    } catch {
      setState('failed');
      setHint('連不上伺服器，再按一次試試');
    }
  };

  const label = state === 'busy' ? 'AI 正在看這個對話…' : state === 'failed' ? hint : '快速取名：讓 AI 看最近的對話，填一個名字（存檔前可以再改）';
  const Icon = state === 'busy' ? Loader2 : Sparkles;

  if (variant === 'wide') {
    return (
      <button
        type="button"
        onClick={run}
        disabled={state === 'busy'}
        data-testid="quick-title"
        className={cn(
          'flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition-colors active:bg-muted',
          state === 'failed' ? 'border-red-500/40 text-red-600 dark:text-red-400' : 'border-primary/40 text-primary',
        )}
      >
        <Icon className={cn('h-4 w-4', state === 'busy' && 'animate-spin')} />
        {state === 'busy' ? 'AI 正在看…' : state === 'failed' ? hint : '快速取名'}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={run}
      onMouseDown={(event) => event.stopPropagation()}
      disabled={state === 'busy'}
      title={label}
      aria-label={label}
      data-testid="quick-title"
      className={cn(
        'flex h-6 shrink-0 items-center gap-0.5 rounded px-1.5 text-[11px] font-medium transition-colors',
        state === 'failed'
          ? 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400'
          : 'bg-primary/10 text-primary hover:bg-primary/20',
      )}
    >
      <Icon className={cn('h-3 w-3', state === 'busy' && 'animate-spin')} />
      快速取名
    </button>
  );
}
