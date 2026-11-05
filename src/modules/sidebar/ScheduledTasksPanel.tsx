import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, Clock, Moon, X } from 'lucide-react';

import { api } from '@/shared/api';
import type { NightQueueItem, NightQueueState, Project, ScheduledMessage } from '@/shared/types';
import { formatStartAt } from '@/modules/chat/utils/nightQueueTime';

type ScheduledTask = {
  id: string;
  kind: 'clock' | 'night';
  sessionId: string;
  content: string;
  /** ISO instant, or null for the night window. */
  at: string | null;
  running: boolean;
  // Its time has come but an earlier turn in the same conversation is still running.
  queued?: boolean;
};

const REFRESH_MS = 30_000;

async function loadTasks(): Promise<ScheduledTask[]> {
  const [clockResponse, marksResponse] = await Promise.all([api.scheduledMessages.list(), api.nightQueue.list()]);
  const clock = ((await clockResponse.json())?.data ?? []) as ScheduledMessage[];
  const marks = ((await marksResponse.json())?.data?.sessions ?? []) as { sessionId: string; queued: number }[];
  const states = await Promise.all(
    marks
      .filter((mark) => mark.queued > 0)
      .map(async (mark) => ((await (await api.nightQueue.get(mark.sessionId)).json())?.data ?? null) as NightQueueState | null),
  );
  const night = states
    .flatMap((state) => state?.items ?? [])
    .filter((item: NightQueueItem) => item.status === 'pending' || item.status === 'running');
  return [
    ...clock
      .filter((message) => message.status === 'pending' || message.status === 'sending')
      .map((message) => ({
        id: message.id,
        kind: 'clock' as const,
        sessionId: message.sessionId,
        content: message.content,
        at: message.scheduledFor,
        running: false,
        queued: message.status === 'sending',
      })),
    ...night.map((item) => ({
      id: item.id,
      kind: 'night' as const,
      sessionId: item.sessionId,
      content: item.content,
      at: item.startAt,
      running: item.status === 'running',
    })),
  ].sort((a, b) => (a.at ?? '9').localeCompare(b.at ?? '9'));
}

/**
 * DHC CLI 11/01: the sidebar's 排程 tab — every message waiting on the composer's clock (排程送出) and every
 * prompt stored by 分流 for the night, across all conversations. Click a row to open its conversation.
 */
export default function ScheduledTasksPanel({ projects, searchFilter }: { projects: Project[]; searchFilter: string }) {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setTasks(await loadTasks());
      setError(false);
    } catch (caught) {
      console.error('Failed to load scheduled tasks:', caught);
      setError(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const sessionName = (sessionId: string) => {
    for (const project of projects) {
      const session = project.sessions?.find((candidate) => candidate.id === sessionId);
      if (session) {
        return String(session.summary || session.title || session.name || '') || null;
      }
    }
    return null;
  };

  const cancel = async (task: ScheduledTask) => {
    if (!window.confirm('取消這個排程？')) return;
    try {
      await (task.kind === 'clock' ? api.scheduledMessages.cancel(task.id) : api.nightQueue.cancel(task.id));
    } catch (caught) {
      console.error('Failed to cancel scheduled task:', caught);
    }
    await refresh();
  };

  const filter = searchFilter.trim().toLowerCase();
  const shown = (tasks ?? []).filter((task) => !filter
    || task.content.toLowerCase().includes(filter)
    || (sessionName(task.sessionId) ?? '').toLowerCase().includes(filter));

  if (error && tasks === null) {
    return <p className="px-4 py-8 text-center text-xs text-red-600 dark:text-red-400">讀不到排程，請稍後再試。</p>;
  }
  if (tasks === null) {
    return <p className="px-4 py-8 text-center text-xs text-muted-foreground">讀取中…</p>;
  }
  if (shown.length === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg border border-border/70 bg-muted/50">
          <CalendarClock className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-1 text-base font-medium text-foreground">{tasks.length ? '沒有符合的排程' : '目前沒有排程'}</h3>
        <p data-tutorial className="text-sm text-muted-foreground">在輸入框按時鐘排時間或額度重置，按月亮排到夜間。</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 px-2">
      {shown.map((task) => {
        const name = sessionName(task.sessionId);
        const when = task.running ? '執行中' : task.queued ? '排隊中' : task.at ? formatStartAt(task.at) : '夜間 01:00 起';
        return (
          <div key={`${task.kind}:${task.id}`} className="group flex items-start gap-1">
            <button
              type="button"
              onClick={() => navigate(`/session/${task.sessionId}`)}
              className="flex min-w-0 flex-1 items-start gap-2 rounded-lg border border-border/60 bg-card/50 px-3 py-2 text-left transition-colors hover:bg-accent/60"
            >
              {task.kind === 'clock'
                ? <Clock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                : <Moon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{task.content.trim() || '（只有附件）'}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {when}{name ? ` · ${name}` : ''}
                </span>
              </span>
            </button>
            {!task.running && (
              <button
                type="button"
                title="取消這個排程"
                aria-label="取消這個排程"
                onClick={() => void cancel(task)}
                className="mt-1.5 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
