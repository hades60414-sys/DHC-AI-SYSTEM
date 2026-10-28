import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Users, X } from 'lucide-react';

import type { Project, ProjectSession } from '@/shared/types';
import { dismissCoInvite, isCoMuted, leaveCoSession, setCoMuted, useCoInvites, useCoPeople } from '@/shared/coSessions';
import { getUserPreferencesVersion, resolveSettingsProjectId, subscribeToUserPreferences } from '@/shared/userSettings';
import { PersonAvatar } from '@/modules/user-avatar';

/**
 * DHC CLI co work: the invitation someone sent this device's person. It stays (on every device of theirs) until
 * they open the session — from here or from the sidebar row — or leave it. 「靜音」 (or ×) mutes the session for them:
 * the card closes on every device and the session stays quietly in their project until they open it or unmute.
 * Portaled to the body: on a phone the sidebar is a hidden, transformed drawer that would hide and move it.
 */
export default function CoInviteCard({ projects, selectedSession }: {
  projects: Project[];
  selectedSession: ProjectSession | null;
}) {
  const navigate = useNavigate();
  useSyncExternalStore(subscribeToUserPreferences, getUserPreferencesVersion);
  const me = resolveSettingsProjectId(projects);
  const invites = useCoInvites(me);
  const people = useCoPeople();

  // Opening the session any way counts as opening the invitation.
  const openSessionId = selectedSession?.id;
  useEffect(() => {
    if (me && openSessionId && invites.some((entry) => entry.sessionId === openSessionId)) {
      dismissCoInvite(openSessionId, me);
    }
  }, [invites, me, openSessionId]);

  const visible = invites.filter((entry) => !isCoMuted(entry.sessionId, me) && entry.sessionId !== openSessionId);
  if (!me || visible.length === 0) return null;
  const { sessionId, session, invite } = visible[0];
  const sender = people.get(invite.from) ?? { name: '有人', avatarId: null };

  return createPortal(
    <div
      role="dialog"
      aria-label="Co-Work 邀請"
      data-testid="co-invite-card"
      className="fixed bottom-4 left-4 z-50 w-[19rem] max-w-[calc(100vw-2rem)] rounded-xl border border-primary/40 bg-card p-3 shadow-xl"
    >
      <div className="flex items-start gap-2.5">
        <PersonAvatar person={sender} className="h-8 w-8 shrink-0 text-xs" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            <span className="truncate"><span className="font-medium text-foreground">{sender.name}</span> 邀你 Co-Work</span>
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold" title={session.title}>{session.title || '（未命名對話）'}</div>
          {invite.message && (
            <p className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 px-2 py-1.5 text-xs text-foreground">
              {invite.message}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="關閉（靜音）"
          title="靜音：留在你的專案、不再跳出來；想看時點開，或在「⋯」取消靜音"
          onClick={() => setCoMuted(sessionId, me, true)}
          className="-mr-1 -mt-1 rounded-md p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-2.5 flex items-center justify-end gap-2">
        {visible.length > 1 && <span className="mr-auto text-[11px] text-muted-foreground">還有 {visible.length - 1} 個邀請</span>}
        <button
          type="button"
          onClick={() => void leaveCoSession(sessionId, me)}
          className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          退出 Co-Work
        </button>
        <button
          type="button"
          title="留在你的專案、不再跳出來；別人在用這個對話也不會一直提醒你"
          onClick={() => setCoMuted(sessionId, me, true)}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-accent"
        >
          靜音
        </button>
        <button
          type="button"
          onClick={() => {
            dismissCoInvite(sessionId, me);
            navigate(`/session/${sessionId}`);
          }}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          打開
        </button>
      </div>
    </div>,
    document.body,
  );
}
