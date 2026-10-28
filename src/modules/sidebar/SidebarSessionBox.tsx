import { useState, type DragEvent, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Edit2, Loader2, MoreHorizontal, Package, Plus, Trash2, X } from 'lucide-react';

import { ActionMenu, Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { SessionBox } from '@/shared/sessionBoxes';
import { endSessionDrag, readDraggedSession, readProjectBoxes, useDraggedSession } from '@/shared/sessionBoxes';
import BackgroundWorkIndicator, { WaitingIndicator } from '@/modules/sidebar/BackgroundWorkIndicator';
import type { WaitingKind } from '@/shared/waitingOnYou';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';

/** DHC CLI 收納盒: the one name field, for creating a box and for renaming one. */
export function BoxNameInput({ initialName = '', onSubmit, onCancel }: {
  initialName?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const isCompact = useCompactSidebar();
  const [name, setName] = useState(initialName);
  const submit = () => {
    if (name.trim()) {
      onSubmit(name);
    } else {
      onCancel();
    }
  };

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-background px-2 py-1">
      <Package className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <input
        autoFocus
        value={name}
        maxLength={30}
        placeholder="收納盒名稱"
        aria-label="收納盒名稱"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            submit();
          } else if (event.key === 'Escape') {
            onCancel();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        // 16px keeps iOS Safari from zooming the viewport on focus.
        style={isCompact ? { fontSize: '16px' } : undefined}
      />
      <button
        type="button"
        title="確定"
        aria-label="確定"
        onClick={submit}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-green-600 hover:bg-green-500/10 dark:text-green-400"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title="取消"
        aria-label="取消"
        onClick={onCancel}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

type SidebarSessionBoxProps = {
  projectId: string;
  box: SessionBox;
  isOpen: boolean;
  memberCount: number;
  isLoadingMembers: boolean;
  runningCount: number;
  /** DHC CLI: a member stopped on a choice question / review. */
  waitingKind?: WaitingKind | null;
  backgroundCount: number;
  needsAttention: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onDropSession: (sessionId: string) => void;
  /** The box's session rows, rendered by SidebarProjectSessions while the box is open. */
  children: ReactNode;
};

/**
 * DHC CLI 收納盒: one box under a project. Click to open or close; drop a session row on it to move the
 * session in; the + starts a new conversation that lands in this box.
 */
export default function SidebarSessionBox({
  projectId,
  box,
  isOpen,
  memberCount,
  isLoadingMembers,
  runningCount,
  waitingKind,
  backgroundCount,
  needsAttention,
  onToggle,
  onNewSession,
  onRename,
  onDelete,
  onDropSession,
  children,
}: SidebarSessionBoxProps) {
  const isCompact = useCompactSidebar();
  const [isRenaming, setIsRenaming] = useState(false);
  // Keyed by the dragged session, so a highlight left over from a cancelled drag never shows on the next one.
  const [hoveredBy, setHoveredBy] = useState<string | null>(null);
  const draggedSession = useDraggedSession();
  const isDropTarget = draggedSession !== null && hoveredBy === draggedSession.sessionId;

  const acceptedSessionId = (): string | null => {
    const dragged = readDraggedSession();
    if (!dragged || dragged.projectId !== projectId) {
      return null;
    }
    return readProjectBoxes(projectId).assign[dragged.sessionId] === box.id ? null : dragged.sessionId;
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    const sessionId = acceptedSessionId();
    if (!sessionId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setHoveredBy(sessionId);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setHoveredBy(null);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const sessionId = acceptedSessionId();
    setHoveredBy(null);
    if (!sessionId) {
      return;
    }
    event.preventDefault();
    onDropSession(sessionId);
    endSessionDrag();
  };

  const confirmDelete = () => {
    if (memberCount > 0 && !window.confirm(`刪除收納盒「${box.name}」？裡面 ${memberCount} 則對話會回到外面，不會刪掉對話。`)) {
      return;
    }
    onDelete();
  };

  const runningNote = `${runningCount} 個對話執行中`;
  const activity = waitingKind ? (
    <WaitingIndicator kind={waitingKind} className="h-4 w-4 flex-shrink-0" position="right" />
  ) : runningCount > 0 ? (
    <Tooltip content={runningNote} position="right">
      <span role="status" aria-label={runningNote} className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    </Tooltip>
  ) : backgroundCount > 0 ? (
    <BackgroundWorkIndicator
      label={`${backgroundCount} 個對話的子代理或背景工作還在跑`}
      className="h-4 w-4 flex-shrink-0"
      position="right"
    />
  ) : needsAttention ? (
    <span role="status" aria-label="裡面有對話需要你" title="裡面有對話需要你" className="h-2 w-2 flex-shrink-0 rounded-full bg-amber-500" />
  ) : null;

  return (
    <div
      data-session-box={box.id}
      className={cn('rounded-md transition-colors', isDropTarget && 'bg-primary/10 ring-1 ring-primary/60')}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isRenaming ? (
        <BoxNameInput
          initialName={box.name}
          onSubmit={(name) => {
            onRename(name);
            setIsRenaming(false);
          }}
          onCancel={() => setIsRenaming(false)}
        />
      ) : (
        <div className="group/box flex items-center gap-0.5 rounded-md hover:bg-accent/50">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isOpen}
            title={isOpen ? '收起收納盒' : '打開收納盒'}
            className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-left', isCompact ? 'px-2 py-2.5' : 'px-1.5 py-1.5')}
          >
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            )}
            <Package className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm text-foreground" title={box.name}>{box.name}</span>
            <span className="flex-shrink-0 text-xs text-muted-foreground">{memberCount}</span>
            {activity}
          </button>
          <div
            className={cn(
              'flex flex-shrink-0 items-center',
              !isCompact && 'opacity-0 transition-opacity focus-within:opacity-100 group-hover/box:opacity-100',
            )}
          >
            <button
              type="button"
              title="在這個收納盒開新對話"
              aria-label={`在「${box.name}」開新對話`}
              onClick={onNewSession}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <ActionMenu
              label="收納盒選項"
              ariaLabel={`收納盒「${box.name}」的選項`}
              icon={MoreHorizontal}
              iconOnly
              portal
              variant="ghost"
              size="icon"
              triggerClassName="h-7 w-7 text-muted-foreground hover:bg-muted"
              menuClassName="w-[240px] rounded-xl p-1.5 shadow-xl"
              items={[
                { key: 'rename', label: '改名', icon: Edit2, onSelect: () => setIsRenaming(true) },
                {
                  key: 'delete',
                  label: '刪除收納盒',
                  description: '裡面的對話會回到外面，不會刪掉對話',
                  icon: Trash2,
                  isDanger: true,
                  showDividerBefore: true,
                  onSelect: confirmDelete,
                },
              ]}
            />
          </div>
        </div>
      )}

      {isOpen && (
        <div className="ml-2 mt-1 space-y-1 border-l border-dashed border-border pl-2">
          {children}
          {isLoadingMembers && <p className="px-2 py-1 text-xs text-muted-foreground">載入較舊的對話…</p>}
          {memberCount === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {isCompact ? '空的。用對話的「⋯」選單移進來。' : '空的。把對話拖進來，或用對話的「⋯」選單。'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
