import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Check } from 'lucide-react';

import { api } from '@/shared/api';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { Project } from '@/shared/types';
import {
  openCoShareDialog,
  setCoProjectNames,
  setCoSessionMembers,
  useCoPeople,
  useCoSession,
  useCoShareTarget,
} from '@/shared/coSessions';
import { isFlashProject } from '@/shared/flashTasks';
import { getUserPreferencesVersion, resolveSettingsProjectId, subscribeToUserPreferences } from '@/shared/userSettings';
import { PersonAvatar } from '@/modules/user-avatar';
import { isQueryProject, isRoutineProject, isWorkspaceProject } from '@/modules/sidebar/hooks/useSidebarController';

const isPersonProject = (project: Project): boolean => (
  isWorkspaceProject(project) && !isQueryProject(project) && !isRoutineProject(project) && !isFlashProject(project)
);

/**
 * DHC CLI co work (10/08 Co-workspace, renamed 10/12): pick who a session is shared with, with an optional note
 * that reaches them as an invitation. Opened from a session row's 「⋯」; one instance lives
 * in the sidebar because it is what knows the workspace projects, which are the people to choose from.
 */
export default function CoShareDialog({ projects, onRenamed }: {
  projects: Project[];
  /** Reloads the session lists after the dialog renamed the session. */
  onRenamed?: () => Promise<void> | void;
}) {
  const target = useCoShareTarget();
  const shared = useCoSession(target?.sessionId);
  const people = useCoPeople();
  const personProjects = useMemo(() => projects.filter(isPersonProject), [projects]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState('');
  // 10/12: the name the others will see, editable before sharing (the automatic first-sentence name is often unclear).
  const [title, setTitle] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  useSyncExternalStore(subscribeToUserPreferences, getUserPreferencesVersion);

  useEffect(() => setCoProjectNames(personProjects), [personProjects]);

  // Each opening starts from who the session is shared with now.
  const targetSessionId = target?.sessionId;
  useEffect(() => {
    setPicked(new Set(shared?.members ?? []));
    setMessage('');
    setTitle(target?.title ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed per opening, not when a save lands
  }, [targetSessionId]);

  if (!target) return null;

  const others = personProjects.filter((project) => project.projectId !== target.ownerProjectId);
  const close = () => openCoShareDialog(null);
  const toggle = (projectId: string) => setPicked((current) => {
    const next = new Set(current);
    if (!next.delete(projectId)) next.add(projectId);
    return next;
  });
  const save = async () => {
    const { sessionId, ...shareTarget } = target;
    const newTitle = title.trim();
    let session = shareTarget;
    if (newTitle && newTitle !== target.title) {
      setIsSaving(true);
      try {
        const response = await api.renameSession(sessionId, newTitle);
        if (!response.ok) throw new Error(`rename failed (${response.status})`);
        session = { ...shareTarget, title: newTitle };
        void onRenamed?.();
      } catch (error) {
        console.error('[CoShare] Failed to rename session:', error);
        alert('對話名稱沒有改成功，共享先不送出，請再試一次。');
        setIsSaving(false);
        return;
      }
      setIsSaving(false);
    }
    // The invitation comes from whoever this device is; a device without a profile shares as the owner.
    const from = resolveSettingsProjectId(projects) ?? target.ownerProjectId;
    void setCoSessionMembers(
      sessionId,
      session,
      others.map((project) => project.projectId).filter((id) => picked.has(id)),
      { from, message },
    );
    close();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[85vh] max-w-sm overflow-y-auto p-5">
        <DialogTitle>Co-Work</DialogTitle>
        <div className="mb-3">
          <div className="text-base font-semibold">Co-Work</div>
          <label className="mt-2 block">
            <span className="mb-1 block text-xs text-muted-foreground">對話名稱（對方看到的名字，可以先改好）</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              data-testid="co-share-title"
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none"
            />
          </label>
          <div className="mt-1 text-xs text-muted-foreground">勾選的人會在自己的專案看到這個對話，可以一起接著聊。</div>
        </div>
        <div className="space-y-1">
          {others.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">沒有其他人的專案可以共享。</p>}
          {others.map((project) => {
            const isPicked = picked.has(project.projectId);
            const person = people.get(project.projectId) ?? { name: project.displayName, avatarId: null };
            return (
              <button
                key={project.projectId}
                type="button"
                role="checkbox"
                aria-checked={isPicked}
                onClick={() => toggle(project.projectId)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                  isPicked ? 'border-primary/60 bg-primary/10' : 'border-border hover:bg-accent/50',
                )}
              >
                <PersonAvatar person={person} className="h-7 w-7 shrink-0 text-xs" />
                <span className="min-w-0 flex-1 truncate text-sm">{person.name}</span>
                {isPicked && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
        {picked.size > 0 && (
          <label className="mt-3 block">
            <span className="mb-1 block text-xs text-muted-foreground">附上一段訊息（選填，對方會在邀請裡看到）</span>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder="例如：幫我看一下第 3 點的算法"
              data-testid="co-share-message"
              className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2 border-t pt-3">
          <button type="button" onClick={close} className="rounded-md px-3 py-1.5 text-sm hover:bg-accent">取消</button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={isSaving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {picked.size === 0 && shared ? '停止共享' : '儲存'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
