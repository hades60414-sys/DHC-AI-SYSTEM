import { useState } from 'react';
import { ArrowRightCircle, EyeOff } from 'lucide-react';

import { handoffDraft } from '@/modules/project-workspace/utils/incognitoQuery';
import { isQueryProject, isWorkspaceProject } from '@/modules/sidebar/hooks/useSidebarController';
import { writeDraftText } from '@/shared/chatDrafts';
import { isFlashProject } from '@/shared/flashTasks';
import { resolveSettingsProjectId } from '@/shared/userSettings';
import type { ChatMessage, Project } from '@/shared/types';

const lastText = (messages: ChatMessage[], type: string): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type === type && typeof message.content === 'string' && message.content.trim() && !message.isToolUse) {
      return message.content;
    }
  }
  return '';
};

/**
 * DHC 無痕查詢 (10/31): shown above the composer in a 內部資料查詢 conversation. Says the conversation will not be
 * kept, and 「轉到專案開工」 carries the last question and answer into a new conversation in the user's own
 * project (the device profile's project, or one picked here). Leaving the query then deletes it as usual.
 */
export default function QueryHandoffBar({
  project,
  projects,
  messages,
  onStartInProject,
}: {
  project: Project;
  projects: ReadonlyArray<Project>;
  messages: ChatMessage[];
  onStartInProject: (target: Project) => void;
}) {
  const targets = projects.filter((p) => isWorkspaceProject(p) && !isQueryProject(p) && !isFlashProject(p));
  const boundId = resolveSettingsProjectId(targets);
  const [pickedId, setPickedId] = useState<string>(boundId ?? '');
  const target = targets.find((p) => p.projectId === (boundId ?? pickedId));
  const question = lastText(messages, 'user');
  const answer = lastText(messages, 'assistant');

  const handOff = () => {
    if (!target) return;
    const zone = project.displayName || project.name || '查詢';
    writeDraftText(`project:${target.projectId}`, handoffDraft(String(zone), question, answer));
    onStartInProject(target);
  };

  return (
    <div data-testid="query-handoff" className="mx-auto mb-2 flex w-full max-w-4xl flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
      <EyeOff className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="min-w-0 flex-1">無痕查詢：不留紀錄，離開這個對話就刪除。</span>
      {question && answer && (
        <span className="flex items-center gap-1.5">
          {!boundId && (
            <select
              aria-label="轉到哪個專案"
              value={pickedId}
              onChange={(event) => setPickedId(event.target.value)}
              className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
            >
              <option value="">選專案…</option>
              {targets.map((p) => (
                <option key={p.projectId} value={p.projectId}>{String(p.displayName || p.name)}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            disabled={!target}
            onClick={handOff}
            title={target ? `把這次的問答帶到「${target.displayName || target.name}」開新對話接著做` : '先選要轉到哪個專案'}
            className="flex h-7 items-center gap-1 rounded-md border border-primary/40 px-2 font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
          >
            <ArrowRightCircle className="h-3.5 w-3.5" />
            {target && boundId ? `轉到「${target.displayName || target.name}」開工` : '轉到專案開工'}
          </button>
        </span>
      )}
    </div>
  );
}
