import { useTranslation } from 'react-i18next';
import { Fragment, memo, useCallback, useMemo, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { ChatMessage,
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition } from '@/shared/types';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { groupConsecutiveTools, isToolGroupItem } from '@/modules/chat/utils/toolGrouping';
import { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
import LazyMessageRow from '@/modules/chat/transcript/LazyMessageRow';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { formatDayLabel, isSameDay } from '@/modules/chat/utils/messageTime';
import { useTranscriptQuiet } from '@/modules/chat/utils/transcriptViewMode';
import { usePermission } from '@/modules/chat/context/PermissionContext';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import LoadAllMessagesOverlay from '@/modules/chat/transcript/LoadAllMessagesOverlay';
import ChatExportMenu from '@/modules/chat/transcript/ChatExportMenu';
import ConversationJumpRail from '@/modules/chat/transcript/ConversationJumpRail';
import type { JumpPrompt } from '@/modules/chat/transcript/ConversationJumpRail';
import { useCoLog, useCoPeople, useCoSession, type CoLogEntry } from '@/shared/coSessions';
import CoWorkLogRow from '@/modules/chat/transcript/CoWorkLogRow';

/**
 * How many of the newest rows mount with real content on the first commit,
 * before the lazy-row observer has had a chance to report what is actually
 * near the viewport. Covers a bit more than one screen of typical rows.
 */
const INITIAL_MOUNTED_TAIL_ROWS = 30;

/** One key for a Co-Work card and its jump-rail dot. */
const coLogKey = (entry: CoLogEntry, index: number) => `colog-${index}-${entry.at}`;

const isPlanToolName = (toolName?: string) => toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode';

type ChatMessagesPaneProps = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  providerModels: Record<LLMProvider, string>;
  setProviderModel: (provider: LLMProvider, model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  loadOlderMessagesNow: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  /** Loads an already-sent message back into the composer; absent when the provider cannot re-run from a point. */
  onEditMessage?: (message: ChatMessage) => void;
  /** Branches the conversation into a new session ending at a message. */
  onForkFromMessage?: (message: ChatMessage) => void;
  /** DHC CLI G2: quote an excerpt of a reply into the composer. */
  onQuoteMessage?: (text: string) => void;
  /** Fetches the whole transcript for an export, which otherwise only sees the loaded page. */
  onLoadFullTranscript?: () => Promise<ChatMessage[]>;
};

/**
 * Rendered by chat's ChatInterface as the scrolling transcript: the message
 * list and tool groups, the export menu, the provider empty state and the
 * load-all-history overlay.
 */
function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  hasActivityIndicator = false,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  providerModels,
  setProviderModel,
  providerModelCatalog,
  providerModelActions,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadAllMessages,
  loadOlderMessagesNow,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onEditMessage,
  onForkFromMessage,
  onQuoteMessage,
  onLoadFullTranscript,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const lazyRows = useLazyRowObserver(scrollContainerRef);
  const coSession = useCoSession(selectedSession?.id ?? currentSessionId);
  // DHC CLI Co-Work log: who shared with whom (and the note), who left — placed by time between the messages.
  const coLog = useCoLog(selectedSession?.id ?? currentSessionId);
  const coPeople = useCoPeople();
  const groupedVisibleMessages = useMemo(
    () => groupConsecutiveTools(visibleMessages, Boolean(showThinking)),
    [visibleMessages, showThinking],
  );

  // DHC CLI A3: quiet view folds each turn's middle (tool calls, progress notes) behind one row;
  // `expandedTurns` holds the prompts whose middle the user opened, keyed by the prompt's message key.
  const quiet = useTranscriptQuiet();
  // A plan waiting for Build/Revise is answered on its own card (PlanDisplay), so quiet view must not fold it.
  const planAwaitingApproval = Boolean(usePermission()?.pendingPermissionRequests.some(
    (request) => isPlanToolName(request.toolName),
  ));
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set());
  const toggleTurn = useCallback((key: string) => {
    setExpandedTurns((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // A server refresh can replace source records with equivalent new objects, so
  // object identity is not a durable React key across pagination or hydration.
  // Deriving keys from this render's ordered messages (intrinsic key,
  // disambiguated by occurrence index on collision) preserves existing DOM
  // nodes and component state when older history is prepended.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isToolGroupItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  // DHC CLI 對話跳轉: the prompts the right-edge rail offers as jump targets.
  const jumpPrompts = useMemo<JumpPrompt[]>(
    () => {
      const prompts: JumpPrompt[] = groupedVisibleMessages.flatMap((item) => {
        if (isToolGroupItem(item) || item.type !== 'user' || item.isTaskNotification || item.isCompactSummary) return [];
        const text = String(item.displayText || item.content || '').replace(/\s+/g, ' ').trim();
        return [{ key: getMessageKey(item), text, timestamp: item.timestamp }];
      });
      if (coLog.length === 0) return prompts;
      // Co-Work cards get dots too, merged in by time like the cards themselves.
      const nameOf = (projectId: string) => coPeople.get(projectId)?.name ?? '有人';
      const cards: JumpPrompt[] = coLog.map((entry, index) => ({
        key: coLogKey(entry, index),
        kind: 'cowork',
        timestamp: entry.at,
        text: entry.kind === 'leave'
          ? `${nameOf(entry.from)} 退出了 Co-Work`
          : `${nameOf(entry.from)} → ${entry.to.map(nameOf).join('、')}${entry.message ? `：${entry.message.replace(/\s+/g, ' ')}` : ''}`,
      }));
      const time = (prompt: JumpPrompt) => (prompt.timestamp ? new Date(prompt.timestamp).getTime() : 0);
      return [...prompts, ...cards].sort((a, b) => time(a) - time(b) || Number(a.kind === 'cowork') - Number(b.kind === 'cowork'));
    },
    [groupedVisibleMessages, getMessageKey, coLog, coPeople],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${
        hasActivityIndicator ? 'pb-12 sm:pb-14' : 'pb-3 sm:pb-4'
      }`}
    >
      {chatMessages.length > 0 && (
        <div className="pointer-events-none sticky right-4 top-3 z-10 mb-2 flex justify-end sm:px-4">
          <div className="pointer-events-auto">
            <ChatExportMenu
              messages={chatMessages}
              sessionTitle={selectedSession?.summary || selectedSession?.title}
              provider={provider}
              selectedProject={selectedProject}
              createDiff={createDiff}
              onLoadFullTranscript={onLoadFullTranscript}
            />
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-[54.25rem] space-y-2 px-4 sm:space-y-3">
      {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          providerModels={providerModels}
          setProviderModel={setProviderModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          projectId={selectedProject?.projectId}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active) */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div className="py-3 text-center text-gray-500 dark:text-gray-400">
              <div className="flex items-center justify-center space-x-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                <p className="text-sm">{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}

          {/* Indicator showing there are more messages to load (hide when all loaded) */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
            // DHC：整行可點，捲不動時也載得到舊訊息
            <button
              type="button"
              onClick={loadOlderMessagesNow}
              className="w-full border-b border-gray-200 py-2 text-center text-sm text-gray-500 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              {totalMessages > 0 && (
                <span>
                  {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                  <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
            </button>
          )}

          <LoadAllMessagesOverlay
            showLoadAllOverlay={showLoadAllOverlay}
            isLoadingAllMessages={isLoadingAllMessages}
            loadAllJustFinished={loadAllJustFinished}
            totalMessages={totalMessages}
            onLoadAllMessages={loadAllMessages}
          />

          {/* Legacy message count indicator (for non-paginated view) */}
          {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="ml-1 text-blue-600 underline hover:text-blue-700" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                onClick={loadAllMessages}
              >
                {t('session.messages.loadAll')}
              </button>
            </div>
          )}

          {(() => {
            let prevMessage: ChatMessage | null = null;
            // DHC CLI: the prompt that started the current turn, so each reply can show elapsed time; the
            // last text reply before the next prompt (or the end) carries the whole turn's total (共).
            let turnStartedAt: ChatMessage['timestamp'] | null = null;
            const rowCount = groupedVisibleMessages.length;
            const isTextReply = (m: ChatMessage) => m.type === 'assistant' && !m.isToolUse && !m.isThinking && !m.isTaskNotification;
            const turnEndIndexes = new Set<number>();
            {
              let seenReplyAfter = false;
              for (let i = rowCount - 1; i >= 0; i -= 1) {
                const row = groupedVisibleMessages[i];
                if (isToolGroupItem(row)) continue;
                if (row.type === 'user') { seenReplyAfter = false; continue; }
                if (isTextReply(row)) {
                  if (!seenReplyAfter) turnEndIndexes.add(i);
                  seenReplyAfter = true;
                }
              }
            }
            // DHC CLI: a day divider (今天 / 昨天 / 9月24日（週三）) whenever the calendar day changes
            // between rows — long sessions span days and the bubble clock alone cannot say which.
            const today = new Date();
            const dayDividerBefore = (stamp: ChatMessage['timestamp'] | undefined, previous: ChatMessage | null) => {
              if (!stamp || (previous && isSameDay(previous.timestamp, stamp))) return null;
              const label = formatDayLabel(stamp, today);
              if (!label) return null;
              return (
                <div className="my-3 flex items-center gap-3 px-3 sm:px-0" aria-label={label}>
                  <div className="h-px flex-1 bg-border/60" />
                  <span className="rounded-full border border-border/60 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">{label}</span>
                  <div className="h-px flex-1 bg-border/60" />
                </div>
              );
            };

            // DHC CLI A3: which turn each row belongs to (index of its prompt), what quiet view folds,
            // and the per-turn counts for the placeholder row.
            const turnStartOf: number[] = [];
            let currentTurnStart = -1;
            groupedVisibleMessages.forEach((row, i) => {
              if (!isToolGroupItem(row) && row.type === 'user') currentTurnStart = i;
              turnStartOf[i] = currentTurnStart;
            });
            // Rows loaded before the first visible prompt (a long last turn, or paged history) form a
            // partial turn keyed 'turn:partial-head'; its fold row sits at the top.
            const turnKeyAt = (start: number): string => (
              start >= 0 ? getMessageKey(groupedVisibleMessages[start] as ChatMessage) : 'turn:partial-head'
            );
            const turnKeyOf = (i: number): string => turnKeyAt(turnStartOf[i]);
            let pendingPlanIndex = -1;
            if (planAwaitingApproval) {
              groupedVisibleMessages.forEach((row, i) => {
                if (isPlanToolName(row.toolName)) pendingPlanIndex = i;
              });
            }
            const isFoldable = (row: (typeof groupedVisibleMessages)[number], i: number): boolean => {
              if (i === pendingPlanIndex) return false;
              if (isToolGroupItem(row)) return true;
              if (row.isToolUse || row.isThinking) return true;
              return isTextReply(row) && !turnEndIndexes.has(i) && !row.isCompactSummary;
            };
            const foldedByTurn = new Map<number, { tools: number; notes: number }>();
            if (quiet) {
              groupedVisibleMessages.forEach((row, i) => {
                const start = turnStartOf[i];
                if (!isFoldable(row, i)) return;
                const entry = foldedByTurn.get(start) ?? { tools: 0, notes: 0 };
                if (isToolGroupItem(row)) entry.tools += row.messages.length;
                else if (row.isToolUse) entry.tools += 1;
                else entry.notes += 1;
                foldedByTurn.set(start, entry);
              });
            }
            const isHidden = (i: number): boolean => {
              if (!quiet) return false;
              const start = turnStartOf[i];
              if (!foldedByTurn.has(start)) return false;
              if (expandedTurns.has(turnKeyOf(i))) return false;
              return isFoldable(groupedVisibleMessages[i], i);
            };

            const renderFoldRow = (turnStart: number) => {
              const folded = foldedByTurn.get(turnStart);
              if (!quiet || !folded || (!folded.tools && !folded.notes)) return null;
              const key = turnKeyAt(turnStart);
              const expanded = expandedTurns.has(key);
              const parts = [folded.tools ? `${folded.tools} 個工具` : '', folded.notes ? `${folded.notes} 段進度` : ''].filter(Boolean).join('、');
              return (
                <button
                  key={`fold-${key}`}
                  type="button"
                  onClick={() => toggleTurn(key)}
                  className="mx-3 my-1 flex items-center gap-2 rounded-md border border-dashed border-border/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground sm:mx-0"
                  aria-expanded={expanded}
                >
                  <span aria-hidden>{expanded ? '▾' : '▸'}</span>
                  <span>{expanded ? '收起中間過程' : `中間跑了 ${parts}（點開看）`}</span>
                </button>
              );
            };

            const coLogTimes = coLog.map((entry) => Date.parse(entry.at));
            let coLogCursor = 0;
            const coLogRowsUpTo = (stamp: number) => {
              const rows = [];
              while (coLogCursor < coLog.length && !(coLogTimes[coLogCursor] > stamp)) {
                rows.push(<CoWorkLogRow key={coLogKey(coLog[coLogCursor], coLogCursor)} jumpAnchor={coLogKey(coLog[coLogCursor], coLogCursor)} entry={coLog[coLogCursor]} />);
                coLogCursor += 1;
              }
              return rows;
            };
            const toTime = (stamp: ChatMessage['timestamp'] | undefined) => (stamp ? new Date(stamp).getTime() : Number.NaN);

            return [renderFoldRow(-1), ...groupedVisibleMessages.map((item, index) => {
              const itemTime = toTime(item.timestamp);
              const coLogRows = Number.isNaN(itemTime) ? [] : coLogRowsUpTo(itemTime - 1);
              if (isHidden(index)) {
                return coLogRows.length > 0 ? <Fragment key={`colog-before-${index}`}>{coLogRows}</Fragment> : null;
              }
              // Rows near the tail mount their content on first commit so the
              // initial scroll-to-bottom measures real heights; older rows
              // start as placeholders and mount when scrolled toward.
              const initiallyNearViewport = index >= rowCount - INITIAL_MOUNTED_TAIL_ROWS;

              if (isToolGroupItem(item)) {
                const groupPrevMessage = prevMessage;
                const groupDivider = dayDividerBefore(item.timestamp, groupPrevMessage);
                prevMessage = item.messages[item.messages.length - 1] || prevMessage;

                return (
                  <Fragment key={`tool-group-${getMessageKey(item.messages[0])}`}>
                  {coLogRows}
                  {groupDivider}
                  <LazyMessageRow
                    lazyRows={lazyRows}
                    timestamp={item.timestamp}
                    initiallyNearViewport={initiallyNearViewport}
                  >
                    <ToolGroupContainer
                      group={item}
                      prevMessage={groupPrevMessage}
                      createDiff={createDiff}
                      getMessageKey={getMessageKey}
                      onFileOpen={onFileOpen}
                      onShowSettings={onShowSettings}
                      onGrantToolPermission={onGrantToolPermission}
                      showRawParameters={showRawParameters}
                      showThinking={showThinking}
                      selectedProject={selectedProject}
                      provider={provider}
                    />
                  </LazyMessageRow>
                  </Fragment>
                );
              }

              const messagePrevMessage = prevMessage;
              const messageDivider = dayDividerBefore(item.timestamp, messagePrevMessage);
              const messageTurnStartedAt = item.type === 'user' ? null : turnStartedAt;
              if (item.type === 'user') turnStartedAt = item.timestamp;
              prevMessage = item;

              return (
                <Fragment key={getMessageKey(item)}>
                {coLogRows}
                {messageDivider}
                <LazyMessageRow
                  lazyRows={lazyRows}
                  timestamp={item.timestamp}
                  initiallyNearViewport={initiallyNearViewport}
                  jumpAnchor={item.type === 'user' ? getMessageKey(item) : undefined}
                >
                  <MessageComponent
                    message={item}
                    prevMessage={messagePrevMessage}
                    turnStartedAt={messageTurnStartedAt}
                    isTurnEnd={turnEndIndexes.has(index)}
                    createDiff={createDiff}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                    onEditMessage={onEditMessage}
                    onForkFromMessage={onForkFromMessage}
                    onQuoteMessage={onQuoteMessage}
                    coSession={coSession}
                  />
                </LazyMessageRow>
                {item.type === 'user' ? renderFoldRow(index) : null}
                </Fragment>
              );
            }), ...coLogRowsUpTo(Number.POSITIVE_INFINITY)];
          })()}
        </>
      )}
      </div>
    </div>
    <ConversationJumpRail
      prompts={jumpPrompts}
      scrollContainerRef={scrollContainerRef}
      onLoadEarlier={
        hasMoreMessages && !allMessagesLoaded
          ? loadAllMessages
          : !hasMoreMessages && chatMessages.length > visibleMessageCount
            ? loadEarlierMessages
            : undefined
      }
      isLoadingEarlier={isLoadingAllMessages || isLoadingMoreMessages}
    />
    </div>
  );
}

export default memo(ChatMessagesPane);
