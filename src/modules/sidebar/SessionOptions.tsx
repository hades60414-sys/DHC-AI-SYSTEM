import { useEffect, useRef } from 'react';
import { Bell, BellOff, Check, Edit2, GitBranch, LogOut, MoreHorizontal, Package, PackageOpen, Star, StarOff, Trash2, Users, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider } from '@/shared/types';
import type { SessionBox } from '@/shared/sessionBoxes';
import { useSessionForkingProviders } from '@/shared/hooks/useProviderCapabilities';
import { useProviderSessionIdCopy } from '@/modules/sidebar/hooks/useProviderSessionIdCopy';
import { PROVIDER_LABELS } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import QuickTitleButton from '@/modules/sidebar/QuickTitleButton';

type SessionOptionsProps = {
  sessionId: string;
  sessionName: string;
  provider: LLMProvider;
  /**
   * The project that owns the session. Null where the row does not know it, in
   * which case rename is withheld rather than guessed — it is keyed by project.
   */
  projectId: string | null;
  /** A running session cannot be deleted or forked, matching the Projects row. */
  isProcessing: boolean;
  isEditing: boolean;
  renameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectId: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Bound by the caller, which owns the session object the fork needs. */
  onFork?: () => void;
  /** Withheld where the row has nowhere to send a delete. */
  canDelete?: boolean;
  /** DHC CLI C1: pin state and toggle; omitted where the list does not support pinning. */
  isPinned?: boolean;
  onTogglePin?: () => void;
  /** DHC CLI 收納盒: the boxes this session can move to; omitted where the list has no boxes. */
  boxMenu?: { otherBoxes: SessionBox[]; isInBox: boolean; onMove: (boxId: string | null) => void };
  /** DHC CLI co work: opens the share dialog; omitted where the row cannot be shared. */
  onShare?: () => void;
  isShared?: boolean;
  /** DHC CLI co work: on someone else's session shared with this project, stops seeing it. */
  onLeaveShare?: () => void;
  /** DHC CLI 靜音模式: on a shared session, whether this person muted it and the switch. */
  isMuted?: boolean;
  onToggleMute?: () => void;
  className?: string;
  t: TFunction;
};

/**
 * A session row's controls: the options menu, and the inline rename that
 * replaces it while a rename is open.
 *
 * Shared by the Projects list and the Conversations list so the two rows cannot
 * drift — the first cut of the Conversations row copied this markup, which is
 * how two rows end up diverging one fix at a time. Callers keep only what is
 * genuinely theirs: where the controls sit, and whether deleting is offered.
 */
export default function SessionOptions({
  sessionId,
  sessionName,
  provider,
  projectId,
  isProcessing,
  isEditing,
  renameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onDeleteSession,
  onFork,
  canDelete = true,
  isPinned = false,
  onTogglePin,
  boxMenu,
  onShare,
  isShared = false,
  onLeaveShare,
  isMuted = false,
  onToggleMute,
  className,
  t,
}: SessionOptionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const providerLabel = PROVIDER_LABELS[provider];
  const { copyState, copyLabel, setOptionsOpen, handleCopyAction, isCopyPending, CopyStateIcon } =
    useProviderSessionIdCopy(sessionId, providerLabel);

  // Read from the backend capability matrix rather than branching on the
  // provider id here; the request is cached module-side, so every row shares one.
  const forkableProviders = useSessionForkingProviders();
  const canFork = Boolean(onFork) && forkableProviders.has(provider) && !isProcessing;

  // While editing, dismiss only when the click lands outside the rename panel,
  // matching Escape and the cancel button.
  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const container = containerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onCancelEditingSession();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isEditing, onCancelEditingSession]);

  const saveRename = () => {
    if (projectId === null) {
      onCancelEditingSession();
      return;
    }
    onSaveEditingSession(projectId, sessionId, renameDraft, provider);
  };

  return (
    <div ref={containerRef} className={cn('flex items-center gap-1', className)}>
      {isEditing ? (
        <>
          <input
            type="text"
            value={renameDraft}
            onChange={(event) => onRenameDraftChange(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                saveRename();
              } else if (event.key === 'Escape') {
                onCancelEditingSession();
              }
            }}
            onClick={(event) => event.stopPropagation()}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
          <QuickTitleButton sessionId={sessionId} onTitle={onRenameDraftChange} />
          <button
            className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
            onClick={(event) => {
              event.stopPropagation();
              saveRename();
            }}
            title={t('tooltips.save')}
          >
            <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
            onClick={(event) => {
              event.stopPropagation();
              onCancelEditingSession();
            }}
            title={t('tooltips.cancel')}
          >
            <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
          </button>
        </>
      ) : (
        <ActionMenu
          label="Session options"
          ariaLabel={`Session options for ${sessionName}`}
          icon={MoreHorizontal}
          iconOnly
          portal
          variant="ghost"
          size="icon"
          onOpenChange={setOptionsOpen}
          triggerClassName="h-7 w-7 text-muted-foreground opacity-70 hover:bg-muted hover:opacity-100"
          menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
          header={(
            <div className="mb-1 border-b border-border px-3 py-2">
              <p className="truncate text-xs font-medium text-foreground" title={sessionName}>
                {sessionName}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{providerLabel} session</p>
            </div>
          )}
          items={[
            ...(onTogglePin ? [{
              key: 'pin',
              label: isPinned ? '取消收藏' : '加入收藏',
              description: isPinned ? undefined : '收藏的 session 排在這個專案最上方（只在這台瀏覽器）',
              icon: isPinned ? StarOff : Star,
              onSelect: onTogglePin,
            }] : []),
            ...(projectId !== null ? [{
              key: 'rename',
              label: 'Rename session',
              icon: Edit2,
              onSelect: () => onStartEditingSession(projectId, sessionId, sessionName),
            }] : []),
            {
              key: 'copy',
              label: copyLabel,
              description: copyState === 'error' ? 'Click to try again.' : undefined,
              icon: CopyStateIcon,
              loading: isCopyPending,
              closeOnSelect: false,
              onSelect: handleCopyAction,
            },
            ...(canFork && onFork ? [{
              key: 'fork',
              label: 'Fork session',
              description: 'Continue from a copy, leaving this one untouched.',
              icon: GitBranch,
              onSelect: onFork,
            }] : []),
            ...(onShare ? [{
              key: 'co-workspace',
              label: 'Co-Work',
              description: isShared ? '已共享，點這裡調整或停止' : '選擇跟誰共享這個 session',
              icon: Users,
              onSelect: onShare,
            }] : []),
            ...(onToggleMute ? [{
              key: 'co-work-mute',
              label: isMuted ? '取消靜音' : '靜音模式',
              description: isMuted ? '別人在用這個對話時，再提醒我' : '先放著：別人在用也不亮燈、不跳通知',
              icon: isMuted ? Bell : BellOff,
              onSelect: onToggleMute,
            }] : []),
            ...(onLeaveShare ? [{
              key: 'co-work-leave',
              label: '退出 Co-Work',
              description: '不再看到這個對話；之後要回來請對方再邀一次',
              icon: LogOut,
              onSelect: onLeaveShare,
            }] : []),
            ...(boxMenu ? [
              ...boxMenu.otherBoxes.map((box, index) => ({
                key: `box:${box.id}`,
                label: `移到「${box.name}」`,
                icon: Package,
                showDividerBefore: index === 0,
                onSelect: () => boxMenu.onMove(box.id),
              })),
              ...(boxMenu.isInBox ? [{
                key: 'box:out',
                label: '移出收納盒',
                icon: PackageOpen,
                showDividerBefore: boxMenu.otherBoxes.length === 0,
                onSelect: () => boxMenu.onMove(null),
              }] : []),
            ] : []),
            ...(canDelete && !isProcessing ? [{
              key: 'delete',
              label: 'Archive or delete session',
              icon: Trash2,
              isDanger: true,
              showDividerBefore: true,
              onSelect: () => onDeleteSession(sessionId, sessionName),
            }] : []),
          ]}
        />
      )}
    </div>
  );
}
