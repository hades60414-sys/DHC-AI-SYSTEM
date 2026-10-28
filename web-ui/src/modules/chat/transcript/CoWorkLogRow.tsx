import { LogOut, Users } from 'lucide-react';

import { useCoPeople, type CoLogEntry } from '@/shared/coSessions';
import { PersonAvatar } from '@/modules/user-avatar';

const clock = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/**
 * DHC CLI Co-Work log in the chat: 「同事A Co-Work 了此對話 → 同事B、同事C」 with the note underneath, or 「X 退出了
 * Co-Work」. Placed by time between the messages; it is shown to people only and never sent to Claude.
 */
export default function CoWorkLogRow({ entry, jumpAnchor }: { entry: CoLogEntry; jumpAnchor?: string }) {
  const people = useCoPeople();
  const nameOf = (projectId: string) => people.get(projectId)?.name ?? '有人';
  const sender = people.get(entry.from) ?? { name: '有人', avatarId: null };
  const time = clock(entry.at);

  return (
    <div className="my-3 flex justify-center px-3 sm:px-0" data-testid="co-work-log" data-kind={entry.kind} data-jump-anchor={jumpAnchor}>
      <div className="w-full max-w-md rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          {entry.kind === 'share' ? <Users className="h-3.5 w-3.5 shrink-0 text-primary" /> : <LogOut className="h-3.5 w-3.5 shrink-0" />}
          <PersonAvatar person={sender} className="h-5 w-5 shrink-0 text-[10px]" />
          <span className="min-w-0 flex-1">
            <span className="font-medium text-foreground">{sender.name}</span>
            {entry.kind === 'share' ? (
              <>
                {' '}Co-Work 了此對話
                {entry.to.length > 0 && (
                  <>
                    {' → '}
                    <span className="font-medium text-foreground">{entry.to.map(nameOf).join('、')}</span>
                  </>
                )}
              </>
            ) : ' 退出了 Co-Work'}
          </span>
          {time && <time className="shrink-0 tabular-nums text-[11px]" dateTime={entry.at}>{time}</time>}
        </div>
        {entry.message && (
          <p className="mt-1.5 whitespace-pre-wrap break-words rounded-md bg-background/70 px-2.5 py-1.5 text-[13px] leading-5 text-foreground">
            {entry.message}
          </p>
        )}
      </div>
    </div>
  );
}
