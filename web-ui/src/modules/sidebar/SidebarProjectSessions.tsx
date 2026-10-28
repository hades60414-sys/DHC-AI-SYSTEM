import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { PackagePlus, Plus } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import { useBackgroundWorkMap } from '@/shared/backgroundWork';
import { pickWaiting, useWaitingMap } from '@/shared/waitingOnYou';
import { isFlashProject } from '@/shared/flashTasks';
import { useSessionsSharedWith } from '@/shared/coSessions';
import type { ProjectBoxes } from '@/shared/sessionBoxes';
import {
  addSessionBox,
  countUnloadedBoxMembers,
  endSessionDrag,
  groupSessionsByBox,
  moveSessionToBox,
  readDraggedSession,
  readProjectBoxes,
  removeSessionBox,
  renameSessionBox,
  setNewSessionBox,
  toggleBoxOpen,
  useDraggedSession,
  useOpenBoxIds,
  useProjectBoxes,
} from '@/shared/sessionBoxes';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import SidebarSessionBox, { BoxNameInput } from '@/modules/sidebar/SidebarSessionBox';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';
import { isQueryProject } from '@/modules/sidebar/hooks/useSidebarController';
import { orderPinnedFirst, usePinnedSessions } from '@/modules/sidebar/utils/pinnedSessions';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  runningOnly?: boolean;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  t: TFunction;
};

/** The flash zone and the query tab keep a flat list. */
const NO_BOXES: ProjectBoxes = { boxes: [], assign: {} };

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

/** Rendered by SidebarProjectItem to show an expanded project's sessions, delegating each row to SidebarSessionItem. */
export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  attentionSessionIds,
  runningOnly = false,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  onNewSession,
  t,
}: SidebarProjectSessionsProps) {
  const isCompact = useCompactSidebar();
  // DHC CLI C1: pinned sessions float to the top of the project's list.
  // Hooks must run before the early return, otherwise expanding a project crashes (React #310).
  const { pinnedIds } = usePinnedSessions();
  const orderedSessions = useMemo(() => orderPinnedFirst(sessions, pinnedIds), [sessions, pinnedIds]);

  // DHC CLI 收納盒: boxes first, each holding the sessions moved into it; everything else stays outside.
  const boxesEnabled = !isFlashProject(project) && !isQueryProject(project);
  const storedBoxes = useProjectBoxes(project.projectId);
  const boxState = boxesEnabled ? storedBoxes : NO_BOXES;
  const openBoxIds = useOpenBoxIds();
  const draggedSession = useDraggedSession();
  const backgroundWorkById = useBackgroundWorkMap();
  const waitingById = useWaitingMap();
  const [isCreatingBox, setIsCreatingBox] = useState(false);
  const [outsideHoveredBy, setOutsideHoveredBy] = useState<string | null>(null);
  const { inBox, outside } = useMemo(() => groupSessionsByBox(orderedSessions, boxState), [orderedSessions, boxState]);
  const loadedIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);

  // DHC CLI Co-workspace: sessions other people shared with this project are listed here too. The share record
  // carries enough to draw the row, so the owner's session pages need not be loaded.
  const sharedWithProject = useSessionsSharedWith(project.projectId);
  const sharedIn = useMemo(() => sharedWithProject
    .filter(([sessionId]) => !loadedIds.has(sessionId))
    .map(([sessionId, record]) => ({
      ownerProjectId: record.ownerProjectId,
      session: { id: sessionId, summary: record.title, lastActivity: record.sharedAt, __provider: record.provider } as SessionWithProvider,
    })), [sharedWithProject, loadedIds]);
  const visibleSharedIn = runningOnly ? sharedIn.filter(({ session }) => activeSessions.has(session.id)) : sharedIn;

  // An open box can hold sessions older than the pages loaded so far: keep loading pages until they are in.
  // A page that brings nothing new ends it, so a failing load cannot loop.
  const needsOlderPages = isExpanded && initialSessionsLoaded && hasMoreSessions
    && boxState.boxes.some((box) => openBoxIds.has(box.id) && countUnloadedBoxMembers(boxState, box.id, loadedIds) > 0);
  const autoLoadedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!needsOlderPages || isLoadingMoreSessions || autoLoadedAtRef.current === sessions.length) {
      return;
    }
    autoLoadedAtRef.current = sessions.length;
    onLoadMoreSessions(project.projectId);
  }, [needsOlderPages, isLoadingMoreSessions, sessions.length, onLoadMoreSessions, project.projectId]);

  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0 || visibleSharedIn.length > 0;
  const isDraggingBoxedSessionHere = draggedSession !== null
    && draggedSession.projectId === project.projectId
    && Boolean(boxState.assign[draggedSession.sessionId]);
  const isOutsideDropTarget = isDraggingBoxedSessionHere && outsideHoveredBy === draggedSession?.sessionId;

  const startNewSession = (boxId: string | null) => {
    setNewSessionBox(project.projectId, boxId);
    if (isCompact) {
      onProjectSelect(project);
    }
    onNewSession(project);
  };

  const boxedDraggedSessionId = (): string | null => {
    const dragged = readDraggedSession();
    return dragged && dragged.projectId === project.projectId && readProjectBoxes(project.projectId).assign[dragged.sessionId]
      ? dragged.sessionId
      : null;
  };

  const handleOutsideDragOver = (event: DragEvent<HTMLDivElement>) => {
    const sessionId = boxedDraggedSessionId();
    if (!sessionId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setOutsideHoveredBy(sessionId);
  };

  const handleOutsideDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOutsideHoveredBy(null);
    }
  };

  const handleOutsideDrop = (event: DragEvent<HTMLDivElement>) => {
    const sessionId = boxedDraggedSessionId();
    setOutsideHoveredBy(null);
    if (!sessionId) {
      return;
    }
    event.preventDefault();
    moveSessionToBox(project.projectId, sessionId, null);
    endSessionDrag();
  };

  const renderSession = (session: SessionWithProvider, sharedFromProjectId?: string) => (
    <SidebarSessionItem
      key={session.id}
      project={project}
      session={session}
      sharedFromProjectId={sharedFromProjectId}
      selectedSession={selectedSession}
      isProcessing={activeSessions.has(session.id)}
      needsAttention={attentionSessionIds.has(session.id)}
      currentTime={currentTime}
      onRenameDraftChange={onRenameDraftChange}
      isEditing={session.id === sessionRenameId}
      renameDraft={session.id === sessionRenameId ? sessionRenameDraft : ''}
      onStartEditingSession={onStartEditingSession}
      onCancelEditingSession={onCancelEditingSession}
      onSaveEditingSession={onSaveEditingSession}
      onProjectSelect={onProjectSelect}
      onSessionSelect={onSessionSelect}
      onDeleteSession={onDeleteSession}
      onForkSession={onForkSession}
      t={t}
    />
  );

  const newBoxButton = boxesEnabled && (
    <button
      type="button"
      title="新增收納盒"
      aria-label="新增收納盒"
      onClick={() => setIsCreatingBox(true)}
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <PackagePlus className="h-4 w-4" />
    </button>
  );

  return (
    <div className="ml-3 space-y-1 border-l border-border pl-3">
      {isCompact ? (
        <div className="flex items-center gap-2 px-3 pb-1 pt-1">
          <button
            className="flex h-8 flex-1 items-center justify-center gap-2 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
            onClick={() => startNewSession(null)}
          >
            <Plus className="h-3 w-3" />
            {t('sessions.newSession')}
          </button>
          {newBoxButton}
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button
            variant="default"
            size="sm"
            className="flex h-8 flex-1 justify-start gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            onClick={() => startNewSession(null)}
          >
            <Plus className="h-3 w-3" />
            {t('sessions.newSession')}
          </Button>
          {newBoxButton}
        </div>
      )}

      {isCreatingBox && (
        <BoxNameInput
          onSubmit={(name) => {
            addSessionBox(project.projectId, name);
            setIsCreatingBox(false);
          }}
          onCancel={() => setIsCreatingBox(false)}
        />
      )}

      {boxState.boxes.map((box) => {
        const members = inBox.get(box.id) ?? [];
        // The running tab only lists running sessions, so a box with none of them is just noise there.
        if (runningOnly && members.length === 0) return null;
        const unloadedCount = countUnloadedBoxMembers(boxState, box.id, loadedIds);
        const isOpen = openBoxIds.has(box.id);
        let runningCount = 0;
        let backgroundCount = 0;
        let needsAttention = false;
        const waitingKind = pickWaiting(members.map((member) => member.id), waitingById);
        for (const member of members) {
          if (activeSessions.has(member.id)) runningCount += 1;
          else if (backgroundWorkById.has(member.id)) backgroundCount += 1;
          if (attentionSessionIds.has(member.id)) needsAttention = true;
        }
        return (
          <SidebarSessionBox
            key={box.id}
            projectId={project.projectId}
            box={box}
            isOpen={isOpen}
            // Once every page is loaded, an id that is still missing belongs to a deleted session: not counted.
            memberCount={members.length + (hasMoreSessions ? unloadedCount : 0)}
            isLoadingMembers={isOpen && unloadedCount > 0 && isLoadingMoreSessions}
            runningCount={runningCount}
            backgroundCount={backgroundCount}
            needsAttention={needsAttention}
            waitingKind={waitingKind}
            onToggle={() => toggleBoxOpen(box.id)}
            onNewSession={() => startNewSession(box.id)}
            onRename={(name) => renameSessionBox(project.projectId, box.id, name)}
            onDelete={() => removeSessionBox(project.projectId, box.id)}
            onDropSession={(sessionId) => moveSessionToBox(project.projectId, sessionId, box.id)}
          >
            {isOpen && members.map((session) => renderSession(session))}
          </SidebarSessionBox>
        );
      })}

      {visibleSharedIn.map(({ session, ownerProjectId }) => renderSession(session, ownerProjectId))}

      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          <div
            className={cn('space-y-1 rounded-md transition-colors', isOutsideDropTarget && 'bg-primary/10 ring-1 ring-primary/60')}
            onDragOver={handleOutsideDragOver}
            onDragLeave={handleOutsideDragLeave}
            onDrop={handleOutsideDrop}
          >
            {isDraggingBoxedSessionHere && (
              <div className="rounded-md border border-dashed border-primary/50 px-3 py-2 text-xs text-muted-foreground">
                拖到這裡移出收納盒
              </div>
            )}
            {outside.map((session) => renderSession(session))}
          </div>

          {hasMoreSessions && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onLoadMoreSessions(project.projectId)}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : 'Load more sessions'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
