import { useProjectCommandState } from '@/modules/project-workspace';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// DHC CLI D1: the one-click "review what you just changed" prompt (logic, numbers, safety — not style).
const REVIEW_OWN_CHANGES_PROMPT = '請審查你在這個 session 到目前為止改過的所有檔案（用 git diff 或你自己的修改紀錄找出來）。只找三類問題：邏輯錯誤、數字或計算錯誤、安全與資料風險（例如會覆蓋或刪除資料、少了防呆）。不要管程式風格與命名。每個問題列出檔案、行號、一句話說明、建議修法；確定沒有問題就明說沒有，不要硬找。';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '@/modules/task-master';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import { api } from '@/shared/api';
import { takeAutoStart } from '@/shared/autoStartChat';
import { fileNewSessionIntoBox } from '@/shared/sessionBoxes';
import { hasTodoChatDrag, readTodoChatDrag, todoFocusText, todoPlanPrompt } from '@/shared/todoChatDrag';
import type { TodoChatPayload } from '@/shared/todoChatDrag';
import { fileNewSessionFlash, setNewSessionFlash, setSessionFlash, useIsFlashSession, useNewSessionFlash } from '@/shared/flashTasks';
import {
  DISTILL_SYSTEM_NOTE,
  fileNewSessionDistill,
  setNewSessionDistill,
  setSessionDistill,
  useIsDistillSession,
  useNewSessionDistill,
} from '@/shared/distillSessions';
import type {
  ChatMessage,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '@/shared/types';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import { useNightQueue } from '@/modules/chat/composer/useNightQueue';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';

type ChatInterfaceProps = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
};

/**
 * Used by the project-workspace module (via the chat barrel) to render a
 * project session's chat tab; it owns the session, provider, realtime and
 * composer state that ChatMessagesPane and ChatComposer render.
 */
function ChatInterface({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
  } = useSessionProtectionActions();

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadOlderMessagesNow,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    fileNewSessionIntoBox(context.project.projectId, sessionId); // DHC CLI 收納盒 picked before the first send
    fileNewSessionFlash(context.project.projectId, sessionId); // DHC CLI ⚡ pressed before the first send
    fileNewSessionDistill(context.project.projectId, sessionId); // DHC CLI 蒸餾模式 flask pressed before the first send
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const { handleNewSession } = useProjectCommandState(); // DHC CLI: for /clear

  // DHC CLI: night mode — this chat's prompts are held on the server and run one at a time from 02:00.
  const { controls: nightQueue, enqueue: enqueueNightPrompt } = useNightQueue(
    currentSessionId || selectedSession?.id || null,
    selectedProject ? `project:${selectedProject.projectId}` : null,
    permissionMode,
  );

  // DHC CLI 快閃任務: the ⚡ marks this session (or, before the first send, the next new one in this project).
  const flashSessionId = currentSessionId || selectedSession?.id || null;
  const flashProjectId = selectedProject?.projectId ?? null;
  const sessionIsFlash = useIsFlashSession(flashSessionId, selectedProject);
  const newSessionIsFlash = useNewSessionFlash(flashProjectId);
  const flashTask = {
    enabled: flashSessionId ? sessionIsFlash : newSessionIsFlash,
    onToggle: () => {
      if (flashSessionId) void setSessionFlash(flashSessionId, !sessionIsFlash);
      else if (flashProjectId) setNewSessionFlash(flashProjectId, !newSessionIsFlash);
    },
  };

  // DHC CLI 蒸餾模式: the flask marks a session the same way. Only the Claude runtime reads the system-prompt
  // append that carries the note, so other providers don't get the button.
  const sessionIsDistill = useIsDistillSession(flashSessionId);
  const newSessionIsDistill = useNewSessionDistill(flashProjectId);
  const distillTask = provider === 'claude'
    ? {
        enabled: flashSessionId ? sessionIsDistill : newSessionIsDistill,
        onToggle: () => {
          if (flashSessionId) void setSessionDistill(flashSessionId, !sessionIsDistill);
          else if (flashProjectId) setNewSessionDistill(flashProjectId, !newSessionIsDistill);
        },
      }
    : undefined;
  const distillMode = Boolean(distillTask?.enabled);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    queueMessage,
    submitText,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
  } = useChatComposerState({
    onClearConversation: () => { if (selectedProject) handleNewSession(selectedProject); },
    onReviewChanges: () => reviewChangesRef.current(),
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    pendingPermissionRequests,
    nightMode: nightQueue.enabled,
    onNightQueueSubmit: enqueueNightPrompt,
    distillMode,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  // DHC CLI: /clear (alias /new) behaves like Claude Code's /clear - start a fresh conversation in this project.
  // DHC CLI: "N 則新訊息" on the jump-to-bottom button. The moment the user scrolls up we remember the
  // newest row's stamp; anything from the assistant newer than that is what they have not seen yet.
  const [scrolledUpSince, setScrolledUpSince] = useState<number | null>(null);
  const reviewChangesRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!isUserScrolledUp) {
      setScrolledUpSince(null);
      return;
    }
    setScrolledUpSince((previous) => {
      if (previous !== null) return previous;
      const last = chatMessages[chatMessages.length - 1];
      const stamp = last ? new Date(last.timestamp).getTime() : NaN;
      return Number.isFinite(stamp) ? stamp : Date.now();
    });
  }, [isUserScrolledUp, chatMessages]);
  const newMessageCount = useMemo(() => {
    if (!isUserScrolledUp || scrolledUpSince === null) return 0;
    return chatMessages.filter((message) => {
      if (message.type === 'user' || message.isToolUse || message.isThinking) return false;
      const stamp = new Date(message.timestamp).getTime();
      return Number.isFinite(stamp) && stamp > scrolledUpSince;
    }).length;
  }, [isUserScrolledUp, scrolledUpSince, chatMessages]);

  // DHC CLI D1: /review runs through the hook's submitText, which only exists after the hook returns.
  reviewChangesRef.current = () => { void submitText(REVIEW_OWN_CHANGES_PROMPT); };

  // DHC CLI A1/E1: the tool currently running (last tool call still without a result) and when it
  // started, so the activity indicator can say "Bash 已 45秒" and flag one that looks stuck.
  const runningTool = useMemo(() => {
    if (!isProcessing) return null;
    for (let i = chatMessages.length - 1; i >= 0; i -= 1) {
      const message = chatMessages[i];
      if (message.type === 'user') break;
      if (message.isToolUse && !message.toolResult) {
        const startedAt = new Date(message.timestamp).getTime();
        return { name: message.toolName || 'tool', startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() };
      }
    }
    return null;
  }, [isProcessing, chatMessages]);

  // DHC CLI 10/08: a todo dropped from the dock. An empty conversation switches to plan mode and sends a planning
  // turn about the task; an existing one gets a "focus on this" line appended to the composer, not sent.
  const [todoDragOver, setTodoDragOver] = useState(false);
  const pendingPlanPromptRef = useRef<string | null>(null);
  const isEmptyConversation = !selectedSession?.id && !currentSessionId && chatMessages.length === 0;
  const handleTodoDrop = useCallback((payload: TodoChatPayload) => {
    if (isEmptyConversation) {
      const prompt = todoPlanPrompt(payload);
      if (permissionMode === 'plan') {
        void submitText(prompt);
      } else if (availablePermissionModes.includes('plan')) {
        // Sent from the effect below, once the send options carry plan mode.
        pendingPlanPromptRef.current = prompt;
        selectPermissionMode('plan');
      } else {
        setInput(prompt);
        textareaRef.current?.focus();
      }
      return;
    }
    const focus = todoFocusText(payload);
    const base = input.trimEnd();
    setInput(base ? `${base}
${focus}` : focus);
    textareaRef.current?.focus();
  }, [availablePermissionModes, input, isEmptyConversation, permissionMode, selectPermissionMode, setInput, submitText, textareaRef]);
  useEffect(() => {
    const prompt = pendingPlanPromptRef.current;
    if (!prompt || permissionMode !== 'plan') return;
    pendingPlanPromptRef.current = null;
    void submitText(prompt);
  }, [permissionMode, submitText]);
  // DHC CLI 10/13: 規劃白板「開工」 opens a new chat here and leaves its brief to be sent as the first turn.
  useEffect(() => {
    if (!isEmptyConversation) return;
    const prompt = takeAutoStart(selectedProject?.projectId);
    if (prompt) void submitText(prompt);
  }, [isEmptyConversation, selectedProject?.projectId, submitText]);
  useEffect(() => {
    if (!todoDragOver) return;
    const clear = () => setTodoDragOver(false);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, [todoDragOver]);

  const handleComposerSubmit = useCallback((event: Parameters<typeof handleSubmit>[0]) => {
    const cmd = input.trim().toLowerCase();
    if ((cmd === '/clear' || cmd === '/new') && selectedProject) {
      event.preventDefault();
      setInput('');
      handleNewSession(selectedProject);
      return;
    }
    return handleSubmit(event);
  }, [input, selectedProject, setInput, handleNewSession, handleSubmit]);

  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await requestLatestMessages(selectedSession.id, isActive);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage]);

  // DHC CLI: a night-queue prompt the server started in this chat ("run now", or 02:00 with the page open)
  // runs with no browser attached. Attach to it the way a reconnect does, so it streams here.
  const runningNightItemId = nightQueue.items.find((item) => item.status === 'running')?.id ?? null;
  const attachedNightItemRef = useRef<string | null>(null);
  useEffect(() => {
    if (!runningNightItemId || attachedNightItemRef.current === runningNightItemId) return;
    attachedNightItemRef.current = runningNightItemId;
    void handleWebSocketReconnect();
  }, [handleWebSocketReconnect, runningNightItemId]);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  });

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  // DHC CLI 10/13: a bare Enter while nothing editable or clickable has focus jumps into the composer,
  // so the keyboard alone gets back to typing. Dialogs, buttons, links and other fields keep their own Enter.
  useEffect(() => {
    if (!isActive) return;
    const handleEnterToComposer = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return;
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, a[href], [contenteditable=""], [contenteditable="true"], [role="button"], [role="dialog"], [role="menu"], [role="listbox"], [tabindex]:not([tabindex="-1"])')) return;
      const textarea = textareaRef.current;
      if (!textarea || textarea.disabled || !textarea.offsetParent) return;
      event.preventDefault();
      textarea.focus();
    };
    document.addEventListener('keydown', handleEnterToComposer);
    return () => document.removeEventListener('keydown', handleEnterToComposer);
  }, [isActive, textareaRef]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  /**
   * Branches the conversation into a new session that ends at this message,
   * then opens it. The session being viewed is left exactly as it was.
   */
  const handleForkFromMessage = useCallback(async (message: ChatMessage) => {
    const anchorId = message.transcriptAnchorId;
    const sourceSessionId = selectedSession?.id;
    if (!anchorId || !sourceSessionId) return;

    try {
      const response = await api.forkSession(sourceSessionId, { upToAnchorId: anchorId });
      const payload = await response.json();
      const forkedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof forkedSessionId !== 'string') {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      onNavigateToSession?.(forkedSessionId);
    } catch (error) {
      console.error('Error forking session:', error);
    }
  }, [onNavigateToSession, selectedSession?.id]);

  const { scheduledMessages, schedule: scheduleMessage, cancel: cancelScheduledMessage } =
    useScheduledMessages(currentSessionId || selectedSession?.id || null);

  /**
   * Hands the composer's current text to the server to send later, and clears
   * the box as a send would — the message has left the composer either way.
   */
  const handleScheduleMessage = useCallback(async (scheduledFor: Date) => {
    const content = input.trim();
    if (!content) return;

    const scheduled = await scheduleMessage({
      content,
      scheduledFor,
      options: {
        model: currentProviderModel,
        effort: currentProviderEffort,
        permissionMode,
        ...(distillMode ? { appendSystemPrompt: DISTILL_SYSTEM_NOTE } : {}),
      },
    });
    if (scheduled) {
      setInput('');
    }
  }, [currentProviderEffort, currentProviderModel, distillMode, input, permissionMode, scheduleMessage, setInput]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, provider, selectProviderModel, selectedSession?.id]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [currentSessionId, provider, selectProviderEffort, selectedSession?.id]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }


  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div
        className="relative flex h-full min-h-0 flex-col"
        onDragOver={(event) => {
          if (!hasTodoChatDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          if (!todoDragOver) setTodoDragOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTodoDragOver(false);
        }}
        onDrop={(event) => {
          if (!hasTodoChatDrag(event.dataTransfer)) return;
          event.preventDefault();
          setTodoDragOver(false);
          const payload = readTodoChatDrag(event.dataTransfer);
          if (payload) handleTodoDrop(payload);
        }}
      >
        {todoDragOver && (
          <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/10">
            <p className="rounded-xl border border-border/40 bg-card px-4 py-3 text-sm font-medium shadow-lg">
              {isEmptyConversation ? '放開：用計畫模式開始規劃這個任務' : '放開：把這個任務帶進輸入框聚焦'}
            </p>
          </div>
        )}
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          // Not redundant with the `scroll` listener. A first page is 20 rows,
          // tool results fold into their calls, and the "load earlier" link is
          // hidden while more pages exist — so a short transcript is often not
          // scrollable at all and never emits `scroll`. Wheel and touch are
          // then the only way to reach the top pager or the "load all" overlay.
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          providerModels={providerModels}
          setProviderModel={setStoredProviderModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadOlderMessagesNow={loadOlderMessagesNow}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          // Editing replaces the turn and everything after it, so it is only
          // offered when the session is idle — a half-truncated transcript with
          // a live stream writing into it is not recoverable.
          onEditMessage={supportsMessageEditing && !isProcessing ? beginEditMessage : undefined}
          onForkFromMessage={supportsSessionForking ? handleForkFromMessage : undefined}
          onQuoteMessage={(text) => {
            // DHC CLI G2: appended as a markdown quote through the voice-transcript path, which also keeps
            // the composer's value ref in sync; the user then types what is wrong with it.
            const quoted = text.split('\n').map((line) => `> ${line}`).join('\n');
            handleVoiceTranscript(`${quoted}\n`);
          }}
          onLoadFullTranscript={loadFullTranscript}
        />

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className={`pointer-events-auto flex h-8 items-center justify-center rounded-full border shadow-sm transition-all duration-200 ${
                  newMessageCount > 0
                    ? 'gap-1.5 border-primary/40 bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90'
                    : 'w-8 border-border/50 bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
                {newMessageCount > 0 && (
                  <span>{t('input.newMessages', { count: newMessageCount, defaultValue: '{{count}} 則新訊息' })}</span>
                )}
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          runningTool={runningTool}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={selectPermissionMode}
          providerLabel={selectedProviderLabel}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={handleSelectComposerEffort}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
          modelsLoading={providerModelsLoading}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          onCompact={() => { void submitText('/compact'); }}
          isEditingSentMessage={Boolean(editingAnchorId)}
          onCancelEditMessage={cancelEditMessage}
          scheduledMessages={scheduledMessages}
          onScheduleMessage={handleScheduleMessage}
          onCancelScheduledMessage={cancelScheduledMessage}
          nightQueue={nightQueue}
          flashTask={flashTask}
          distillTask={distillTask}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleComposerSubmit}
          onQueueMessage={queueMessage}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          onReplaceAttachment={(index, edited) =>
            setAttachedFiles((previous) =>
              previous.map((current, currentIndex) => (currentIndex === index ? edited : current)),
            )
          }
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={currentProviderModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
