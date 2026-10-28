import { memo, useState, type SyntheticEvent } from 'react';
import { Bell, BellOff, Check, Edit2, Loader2, LogOut, MoreHorizontal, Package, PackageOpen, Star, Trash2, Users, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Badge, Dialog, DialogContent, DialogTitle, LLMProviderLogo, Tooltip, buttonVariants } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import { describeBackgroundWork, useBackgroundWork } from '@/shared/backgroundWork';
import { endFlashSession, useIsFlashSession } from '@/shared/flashTasks';
import { leaveCoSession, openCoShareDialog, setCoMuted, useCoSession } from '@/shared/coSessions';
import { endSessionDrag, moveSessionToBox, startSessionDrag, useProjectBoxes } from '@/shared/sessionBoxes';
import { PROVIDER_LABELS, createSessionViewModel, formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';
import { isQueryProject, isRoutineProject, isWorkspaceProject } from '@/modules/sidebar/hooks/useSidebarController';
import { CoAvatarStack } from '@/modules/user-avatar';
import { useIsTeamMode } from '@/shared/dhcConfig';
import { useProviderSessionIdCopy } from '@/modules/sidebar/hooks/useProviderSessionIdCopy';
import BackgroundWorkIndicator, { RunningHeartbeat, WaitingIndicator } from '@/modules/sidebar/BackgroundWorkIndicator';
import { useWaitingKind } from '@/shared/waitingOnYou';
import SessionOptions from '@/modules/sidebar/SessionOptions';
import QuickTitleButton from '@/modules/sidebar/QuickTitleButton';
import SessionTypeBadge from '@/modules/sidebar/SessionTypeBadge';
import { usePinnedSessions } from '@/modules/sidebar/utils/pinnedSessions';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  isProcessing: boolean;
  needsAttention: boolean;
  currentTime: Date;
  /** Resolved for this row, so a keystroke elsewhere does not invalidate it. */
  isEditing: boolean;
  renameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Branches this session into an independent one; absent when its provider cannot. */
  onForkSession?: (session: SessionWithProvider) => void;
  /**
   * DHC CLI Co-workspace: set when this row is someone else's session shared with `project`. The session still
   * belongs to that owner's project, so opening and renaming go there and it cannot be boxed or deleted from here.
   */
  sharedFromProjectId?: string;
  t: TFunction;
};

/** Rendered by SidebarProjectSessions for one session row, including its rename, copy and delete controls. */
function SidebarSessionItem({
  project,
  session,
  selectedSession,
  isProcessing,
  needsAttention,
  currentTime,
  isEditing,
  renameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  sharedFromProjectId,
  t,
}: SidebarSessionItemProps) {
  const isCompact = useCompactSidebar();
  // DHC CLI Co-Work: a shared session goes by the name in its share record, which a rename from any side updates,
  // so the owner and every member see the same name without reloading the owner's session list.
  const sharedName = useCoSession(session.id)?.title;
  const baseView = createSessionViewModel(session, currentTime, t);
  const sessionView = sharedName ? { ...baseView, sessionName: sharedName } : baseView;
  const isSelected = selectedSession?.id === session.id;
  const compactSessionAge = formatCompactAge(sessionView.sessionTime, currentTime);
  const [isMobileOptionsOpen, setIsMobileOptionsOpen] = useState(false);
  const { isPinned: isSessionPinned, togglePin } = usePinnedSessions();
  const isPinned = isSessionPinned(session.id);
  // DHC：收藏從專案移到 session。星號點了就收藏／取消（收藏的排在專案最上面，只記在這台瀏覽器）。
  const renderStar = (alwaysFaint: boolean) => (
    <span
      role="button"
      tabIndex={0}
      title={isPinned ? '取消收藏' : '加入收藏（排到最上面）'}
      aria-label={isPinned ? '取消收藏' : '加入收藏'}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePin(session.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          togglePin(session.id);
        }
      }}
      className={cn(
        'flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded transition-opacity',
        isPinned ? '' : alwaysFaint ? 'opacity-40' : 'opacity-60 hover:!opacity-100',
      )}
    >
      <Star className={cn('h-3 w-3', isPinned ? 'fill-current text-yellow-500' : 'text-muted-foreground')} />
    </span>
  );
  // DHC CLI 靜音模式: this row's person (its project) muted the shared session — no amber lights, no waiting icon.
  const coSessionForMute = useCoSession(session.id);
  const isMuted = Boolean(coSessionForMute?.muted?.includes(project.projectId));
  const showAttentionIndicator = needsAttention && !isSelected && !isMuted;
  const providerLabel = PROVIDER_LABELS[session.__provider];
  // DHC CLI: the turn is over but subagents / background shells are still running — keep a (violet) light on.
  const backgroundWork = useBackgroundWork(session.id);
  const backgroundWorkLabel = !isProcessing && backgroundWork ? describeBackgroundWork(backgroundWork) : null;
  // DHC CLI: green heartbeat while anything of this session runs, subagents included.
  const isRunning = isProcessing || Boolean(backgroundWorkLabel);
  // DHC CLI: stopped on a choice question / review — a reminder icon takes the spinner's place.
  const waitingKindRaw = useWaitingKind(session.id);
  const waitingKind = isMuted ? null : waitingKindRaw;
  const runningLabel = isProcessing ? '執行中' : backgroundWorkLabel;
  // DHC CLI 快閃任務: an × right on the row deletes the session for good, no dialog. Not while anything still runs.
  // On desktop it takes the age's slot inside the link, so it is a span like the star (no button inside <a>).
  const isFlash = useIsFlashSession(session.id, project);
  const showFlashEnd = isFlash && !isProcessing && !backgroundWork && !isEditing;
  const endThisFlashSession = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void endFlashSession(session.id);
  };
  const renderFlashEnd = (sizeClassName: string) => (
    <span
      role="button"
      tabIndex={0}
      title="結束：移到封存，7 天內可以還原，之後自動刪除"
      aria-label={`結束 ${sessionView.sessionName}`}
      onClick={endThisFlashSession}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') endThisFlashSession(event);
      }}
      className={cn(
        'flex flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400',
        sizeClassName,
      )}
    >
      <X className="h-4 w-4" />
    </span>
  );

  // DHC CLI 收納盒: on desktop the row drags onto a box; both layouts offer 「移到…」 in the options.
  // The flash zone and the query tab never get boxes, so they never get these either.
  const { boxes, assign } = useProjectBoxes(project.projectId);
  const currentBoxId = assign[session.id] ?? null;
  const otherBoxes = boxes.filter((box) => box.id !== currentBoxId);
  const moveToBox = (boxId: string | null) => moveSessionToBox(project.projectId, session.id, boxId);
  const canMoveToBox = boxes.length > 0 && !isEditing && !sharedFromProjectId;

  // DHC CLI Co-workspace: a shared session shows its people where the model logo is, in every project listing it.
  // Personal mode (dhc.config.json) hides Co-Work: no share, no invites, the model logo instead of faces.
  const isTeam = useIsTeamMode();
  const sharedCoSession = useCoSession(session.id);
  const coSession = isTeam ? sharedCoSession : null;
  const ownerProjectId = sharedFromProjectId ?? project.projectId;
  const canShare = isTeam && (Boolean(sharedFromProjectId)
    || (isWorkspaceProject(project) && !isQueryProject(project) && !isRoutineProject(project) && !isFlash));
  const openShareDialog = () => openCoShareDialog({
    sessionId: session.id,
    ownerProjectId: coSession?.ownerProjectId ?? ownerProjectId,
    title: sessionView.sessionName,
    provider: session.__provider,
  });
  // co work: the member's own row of a shared session can leave it, and shows the unopened invitation.
  const leaveShare = isTeam && sharedFromProjectId
    ? () => {
      if (window.confirm(`退出 Co-Work「${sessionView.sessionName}」？之後要回來請對方再邀一次。`)) {
        void leaveCoSession(session.id, project.projectId);
      }
    }
    : undefined;
  const hasInvite = Boolean(sharedFromProjectId && coSession?.invites?.[project.projectId]) && !isMuted;
  const toggleMute = coSession ? () => setCoMuted(session.id, project.projectId, !isMuted) : undefined;
  // The bell is the switch: 🔕 stays while muted; 🔔 shows on hover (always, faintly, on a phone) when not.
  // A span with a button role, because the desktop row is an <a>; it never opens the session.
  const renderMuteBell = (alwaysVisible: boolean) => {
    if (!toggleMute) return null;
    const label = isMuted ? '靜音中：按一下恢復提醒' : '按一下靜音：別人在用也不提醒你';
    const press = (event: SyntheticEvent) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMute();
    };
    return (
      <span
        role="button"
        tabIndex={0}
        aria-pressed={isMuted}
        aria-label={label}
        title={label}
        data-testid={isMuted ? 'co-muted' : 'co-unmuted'}
        onClick={press}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') press(event);
        }}
        className={cn(
          'flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded transition-opacity hover:bg-accent',
          isMuted
            ? 'text-muted-foreground'
            : alwaysVisible
              ? 'text-muted-foreground opacity-40'
              : 'text-muted-foreground opacity-60 hover:!opacity-100',
        )}
      >
        {isMuted ? <BellOff className="h-3 w-3" /> : <Bell className="h-3 w-3" />}
      </span>
    );
  };
  const renderSessionIcon = () => (
    <div
      className={cn(
        'relative flex h-5 flex-shrink-0 items-center justify-center rounded-md',
        coSession ? 'px-0.5' : 'w-5',
        isSelected ? 'bg-primary/30' : 'bg-muted/50',
      )}
    >
      {coSession
        ? <CoAvatarStack session={coSession} />
        : <LLMProviderLogo provider={session.__provider} className="h-3 w-3" />}
      <SessionTypeBadge sessionId={session.id} isFlash={isFlash} />
    </div>
  );

  // The desktop controls live in SessionOptions, which owns the rename panel and
  // its outside-click dismissal. The mobile rename sits inside the bottom sheet,
  // which owns its own.
  const { copyState, copyLabel, setOptionsOpen, handleCopyAction, isCopyPending, CopyStateIcon } =
    useProviderSessionIdCopy(session.id, providerLabel);

  // Sessions are owned by a project identified by `projectId` (DB primary key)
  // after the projectName → projectId migration.
  const selectMobileSession = () => {
    // A session shared from someone else opens under its owner's project, which the session route resolves.
    if (!sharedFromProjectId) onProjectSelect(project);
    onSessionSelect(session, ownerProjectId);
  };

  const saveEditedSession = () => {
    onSaveEditingSession(ownerProjectId, session.id, renameDraft, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(session.id, sessionView.sessionName);
  };

  const setMobileOptionsOpen = (open: boolean) => {
    setIsMobileOptionsOpen(open);
    setOptionsOpen(open);
    if (!open && isEditing) {
      onCancelEditingSession();
    }
  };

  const startMobileRename = () => {
    onStartEditingSession(ownerProjectId, session.id, sessionView.sessionName);
  };

  const saveMobileRename = () => {
    saveEditedSession();
    setMobileOptionsOpen(false);
  };

  return (
    <div className="group relative">
      {hasInvite && !isSelected ? (
        <div className="absolute left-0 top-1/2 z-20 -translate-x-1 -translate-y-1/2 transform">
          <Tooltip content="Co-Work 邀請未讀" position="right">
            <div role="status" aria-label="Co-Work 邀請未讀" data-testid="co-invite-unread" className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          </Tooltip>
        </div>
      ) : showAttentionIndicator ? (
        <div className="absolute left-0 top-1/2 z-20 -translate-x-1 -translate-y-1/2 transform">
          <Tooltip
            content={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })}
            position="right"
          >
            <div
              role="status"
              aria-label={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })}
              className="h-2 w-2 animate-pulse rounded-full bg-amber-500"
            />
          </Tooltip>
        </div>
      ) : runningLabel && (
        <div className="absolute left-0 top-1/2 z-20 -translate-x-1 -translate-y-1/2 transform">
          <RunningHeartbeat label={runningLabel} />
        </div>
      )}

      {isCompact && (
      <div>
        <div
          className={cn(
            'p-2 mx-3 my-0.5 rounded-md bg-card border active:scale-[0.98] transition-all duration-150 relative',
            // DHC CLI: the open conversation stands out at a glance — tinted, outlined, a bar down its left edge.
            isSelected
              ? 'border-primary/60 bg-primary/20 shadow-[inset_3px_0_0_0_hsl(var(--primary))]'
              : isRunning
                ? 'border-green-500/30 bg-green-50/5 dark:bg-green-900/5'
                : 'border-border/30',
          )}
          onClick={selectMobileSession}
        >
          <div className="flex items-center gap-2">
            {renderSessionIcon()}

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {renderStar(true)}
                <div
                  className={cn('min-w-0 flex-1 truncate text-sm text-foreground', isSelected ? 'font-semibold' : 'font-normal')}
                  title={sessionView.sessionName}
                >
                  {sessionView.sessionName}
                </div>
                {renderMuteBell(true)}
                {hasInvite && (
                  <span data-testid="co-invite-badge" title="Co-Work 邀請，打開就會消失" className="flex-shrink-0 rounded bg-primary/15 px-1 text-[10px] font-medium text-primary">邀請</span>
                )}
                {waitingKind ? (
                  <span className="ml-auto flex-shrink-0">
                    <WaitingIndicator kind={waitingKind} />
                  </span>
                ) : isProcessing ? (
                  <span className="ml-auto flex-shrink-0">
                    <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
                      <span className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </span>
                    </Tooltip>
                  </span>
                ) : backgroundWorkLabel ? (
                  <span className="ml-auto flex-shrink-0">
                    <BackgroundWorkIndicator label={backgroundWorkLabel} />
                  </span>
                ) : compactSessionAge && (
                  <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">{compactSessionAge}</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center">
                {sessionView.messageCount > 0 && (
                  <Badge variant="secondary" className="px-1 py-0 text-xs">
                    {sessionView.messageCount}
                  </Badge>
                )}
              </div>
            </div>

            {showFlashEnd && renderFlashEnd('h-8 w-8')}
            <button
              type="button"
              aria-label={`Session options for ${sessionView.sessionName}`}
              aria-haspopup="dialog"
              aria-expanded={isMobileOptionsOpen}
              className="ml-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted active:scale-95"
              onClick={(event) => {
                event.stopPropagation();
                setMobileOptionsOpen(true);
              }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>

        <Dialog open={isMobileOptionsOpen} onOpenChange={setMobileOptionsOpen}>
          <DialogContent
            aria-describedby="mobile-session-options-description"
            animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
            className="bottom-0 left-0 top-auto max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl border-x-0 border-b-0 px-4 pb-safe-area-inset-bottom pt-3"
          >
            <DialogTitle>Session options</DialogTitle>
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

            <div className="mb-4 flex items-center gap-3 px-1">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <LLMProviderLogo provider={session.__provider} className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground" title={sessionView.sessionName}>
                  {sessionView.sessionName}
                </p>
                <p id="mobile-session-options-description" className="text-xs text-muted-foreground">
                  {providerLabel} session
                </p>
              </div>
            </div>

            {isEditing ? (
              <div className="mb-3 space-y-2">
                <label htmlFor={`mobile-session-rename-${session.id}`} className="block px-1 text-xs font-medium text-muted-foreground">
                  Session name
                </label>
                <input
                  id={`mobile-session-rename-${session.id}`}
                  type="text"
                  value={renameDraft}
                  onChange={(event) => onRenameDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveMobileRename();
                    }
                  }}
                  className="w-full rounded-xl border-2 border-primary/40 bg-background px-3 py-3 text-foreground shadow-sm focus:border-primary focus:outline-none"
                  autoFocus
                  autoComplete="off"
                  // 16px keeps iOS Safari from zooming the viewport on focus.
                  style={{ fontSize: '16px' }}
                />
                <QuickTitleButton sessionId={session.id} onTitle={onRenameDraftChange} variant="wide" />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveMobileRename}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-transform active:scale-95"
                  >
                    <Check className="h-5 w-5 flex-shrink-0" />
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={onCancelEditingSession}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-muted/35 px-4 py-3 text-sm font-medium text-foreground transition-colors active:bg-muted"
                  >
                    <X className="h-5 w-5 flex-shrink-0" />
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={startMobileRename}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                >
                  <Edit2 className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm font-medium">Rename session</span>
                </button>

                <button
                  type="button"
                  onClick={handleCopyAction}
                  disabled={isCopyPending}
                  className={cn(
                    'flex min-h-12 w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
                    copyState === 'copied'
                      ? 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'
                      : copyState === 'error'
                        ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                        : 'border-border bg-muted/35 text-foreground active:bg-muted',
                  )}
                >
                  {isCopyPending ? (
                    <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <CopyStateIcon className="h-5 w-5 flex-shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{copyLabel}</span>
                    {copyState === 'error' && (
                      <span className="mt-0.5 block text-xs">Tap to try again.</span>
                    )}
                  </span>
                </button>

                {canShare && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOptionsOpen(false);
                      openShareDialog();
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                  >
                    <Users className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">Co-Work</span>
                  </button>
                )}

                {toggleMute && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOptionsOpen(false);
                      toggleMute();
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                  >
                    {isMuted ? <Bell className="h-5 w-5 flex-shrink-0" /> : <BellOff className="h-5 w-5 flex-shrink-0" />}
                    <span className="text-sm font-medium">{isMuted ? '取消靜音' : '靜音模式'}</span>
                  </button>
                )}

                {leaveShare && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOptionsOpen(false);
                      leaveShare();
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                  >
                    <LogOut className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">退出 Co-Work</span>
                  </button>
                )}

                {canMoveToBox && otherBoxes.map((box) => (
                  <button
                    key={box.id}
                    type="button"
                    onClick={() => {
                      moveToBox(box.id);
                      setMobileOptionsOpen(false);
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                  >
                    <Package className="h-5 w-5 flex-shrink-0" />
                    <span className="min-w-0 truncate text-sm font-medium">移到「{box.name}」</span>
                  </button>
                ))}

                {canMoveToBox && currentBoxId && (
                  <button
                    type="button"
                    onClick={() => {
                      moveToBox(null);
                      setMobileOptionsOpen(false);
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                  >
                    <PackageOpen className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">移出收納盒</span>
                  </button>
                )}

                {!isProcessing && !sharedFromProjectId && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOptionsOpen(false);
                      requestDeleteSession();
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-red-600 transition-colors active:bg-red-500/10 dark:text-red-400"
                  >
                    <Trash2 className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">Archive or delete session</span>
                  </button>
                )}
              </div>
            )}

            {!isEditing && (
              <button
                type="button"
                onClick={() => setMobileOptionsOpen(false)}
                className="mb-3 mt-2 min-h-11 w-full rounded-xl text-sm font-medium text-muted-foreground transition-colors active:bg-muted"
              >
                Cancel
              </button>
            )}
          </DialogContent>
        </Dialog>
      </div>
      )}

      {!isCompact && (
      // DHC CLI 10/13: at rest a row is its icon and title; on hover it grows out of its slot on every side (the
      // negative margins keep the neighbours still) and the room opens from the middle: star and bell before the
      // title, the age after it, then 「⋯」. The spinner steps aside on hover (the green light already says it).
      <div
        className={cn(
          // DHC CLI 10/13: the hover opens fast and lands slowly (ease-out-expo); the return is quick and plain.
          `relative transition-[margin] duration-200 ease-out group-hover:duration-[400ms] group-hover:ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none`,
          // The right edge of the list is the scroll box's edge, so a row keeps 8px there to grow into.
          !isEditing && 'mr-2 group-hover:z-10 group-hover:-my-0.5 group-hover:-ml-2.5 group-hover:mr-0',
        )}
      >
        <a
          href={`/session/${session.id}`}
          className={cn(
            buttonVariants({ variant: 'ghost' }),
            `h-auto w-full justify-start rounded-md border bg-card p-2 text-left font-normal transition-all duration-200 ease-out group-hover:duration-[400ms] group-hover:ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none`,
            isEditing ? 'pr-11' : 'pr-2 group-hover:py-2.5 group-hover:pr-10 group-hover:shadow-lg',
            // DHC CLI: the open conversation stands out at a glance — tinted, outlined, a bar down its left edge.
            isSelected
              ? 'border-primary/60 bg-primary/20 shadow-[inset_3px_0_0_0_hsl(var(--primary))] hover:bg-primary/25'
              : isRunning
                ? 'border-green-500/30 bg-green-50/5 hover:bg-green-50/10 dark:bg-green-900/5 dark:hover:bg-green-900/10'
                : 'border-border/30 hover:bg-accent/50',
          )}
          // Left-click keeps in-app navigation; Ctrl/Cmd/middle-click and the
          // native right-click menu use the href to open a new tab/window.
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onSessionSelect(session, ownerProjectId);
          }}
          onDragStart={canMoveToBox ? (event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-dhc-session', session.id);
            startSessionDrag({ sessionId: session.id, projectId: project.projectId });
          } : undefined}
          onDragEnd={canMoveToBox ? endSessionDrag : undefined}
        >
          <div className="flex w-full min-w-0 items-center gap-2">
            {renderSessionIcon()}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {isPinned && renderStar(false)}
                {isMuted && renderMuteBell(false)}
                {!isEditing && (!isPinned || (toggleMute && !isMuted)) && (
                  // Zero-wide at rest (the negative margin cancels the row gap), grows in on hover.
                  <span
                    data-testid="row-hover-lead"
                    className="-mr-2 flex max-w-0 flex-shrink-0 items-center gap-1 overflow-hidden opacity-0 transition-all duration-200 ease-out group-hover:mr-0 group-hover:max-w-[3rem] group-hover:opacity-100 group-hover:duration-[400ms] group-hover:ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none group-hover:delay-[60ms]"
                  >
                    {!isPinned && renderStar(false)}
                    {!isMuted && renderMuteBell(false)}
                  </span>
                )}
                <div
                  className={cn('min-w-0 flex-1 truncate text-sm text-foreground', isSelected ? 'font-semibold' : 'font-normal')}
                  title={sessionView.sessionName}
                  data-testid="session-title"
                  onDoubleClick={(event) => {
                    // DHC CLI 10/13: double-click the name to rename it (the rename strip has 「快速取名」).
                    event.preventDefault();
                    event.stopPropagation();
                    if (!isEditing) onStartEditingSession(ownerProjectId, session.id, sessionView.sessionName);
                  }}
                >
                  {sessionView.sessionName}
                </div>
                {hasInvite && (
                  <span data-testid="co-invite-badge" title="Co-Work 邀請，打開就會消失" className="flex-shrink-0 rounded bg-primary/15 px-1 text-[10px] font-medium text-primary">邀請</span>
                )}
                {waitingKind ? (
                  <span className={cn('flex-shrink-0', isEditing && 'opacity-0')}>
                    <WaitingIndicator kind={waitingKind} />
                  </span>
                ) : isProcessing ? (
                  <span className={cn('flex-shrink-0 overflow-hidden transition-all duration-150 group-hover:-ml-2 group-hover:w-0 group-hover:opacity-0', isEditing && 'opacity-0')}>
                    <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
                      <span className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </span>
                    </Tooltip>
                  </span>
                ) : backgroundWorkLabel ? (
                  <span className={cn('flex-shrink-0 overflow-hidden transition-all duration-150 group-hover:-ml-2 group-hover:w-0 group-hover:opacity-0', isEditing && 'opacity-0')}>
                    <BackgroundWorkIndicator label={backgroundWorkLabel} />
                  </span>
                ) : showFlashEnd ? (
                  <span className="flex-shrink-0">{renderFlashEnd('h-5 w-5')}</span>
                ) : null}
                {!isEditing && compactSessionAge && (
                  <span
                    data-testid="row-hover-age"
                    className="-ml-2 max-w-0 flex-shrink-0 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground opacity-0 transition-all duration-200 ease-out group-hover:ml-0 group-hover:max-w-[4rem] group-hover:opacity-100 group-hover:duration-[400ms] group-hover:ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none group-hover:delay-[60ms]"
                  >
                    {compactSessionAge}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center">
                {sessionView.messageCount > 0 && <Badge variant="secondary" className="px-1 py-0 text-xs">{sessionView.messageCount}</Badge>}
              </div>
            </div>
          </div>
        </a>

        <SessionOptions
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 transform transition-all duration-200',
            // Renaming: the strip spans the row (over the title) so the box and 「快速取名」 have room.
            isEditing && 'left-1 right-1 z-20 rounded-md bg-card px-1 py-1 shadow-sm ring-1 ring-primary/40',
            !isEditing && 'opacity-0 focus-within:opacity-100 group-hover:z-20 group-hover:opacity-100',
          )}
          sessionId={session.id}
          sessionName={sessionView.sessionName}
          provider={session.__provider}
          projectId={ownerProjectId}
          isProcessing={isProcessing}
          canDelete={!sharedFromProjectId}
          onShare={canShare ? openShareDialog : undefined}
          isShared={coSession !== null}
          onLeaveShare={leaveShare}
          isMuted={isMuted}
          onToggleMute={toggleMute}
          isPinned={isPinned}
          onTogglePin={() => togglePin(session.id)}
          isEditing={isEditing}
          renameDraft={renameDraft}
          onRenameDraftChange={onRenameDraftChange}
          onStartEditingSession={onStartEditingSession}
          onCancelEditingSession={onCancelEditingSession}
          onSaveEditingSession={onSaveEditingSession}
          onDeleteSession={onDeleteSession}
          onFork={onForkSession ? () => onForkSession(session) : undefined}
          boxMenu={canMoveToBox ? { otherBoxes, isInBox: currentBoxId !== null, onMove: moveToBox } : undefined}
          t={t}
        />
      </div>
      )}
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * SidebarProjectSessions hands every row but the one being renamed a constant
 * draft, and the session objects come from a per-project cache, so the compare
 * succeeds for the rest. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarSessionItem);
