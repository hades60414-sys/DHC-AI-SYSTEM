import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import { PaperclipIcon, MessageSquareIcon, XIcon, OctagonX, Loader2, ArrowUpIcon, PencilIcon, Eraser, ListEnd, Moon, Zap, FlaskConical, Eye, EyeOff, MoreHorizontal } from 'lucide-react';

import { ActionMenu } from '@/shared/ui';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { useIsPresenter } from '@/shared/context/ThemeContext';
import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { useVoiceAvailable } from '@/modules/chat/hooks/useVoiceAvailable';
import type { QueuedDraft, ScheduledMessage, SlashCommand,SessionActivity,PendingPermissionRequest,PermissionMode,ProviderModelOption } from '@/shared/types';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '@/modules/chat/composer/PromptInput';
import CommandMenu from '@/modules/chat/composer/CommandMenu';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import ComposerAttachment from '@/modules/chat/composer/ComposerAttachment';
import VoiceInputButton from '@/modules/chat/composer/VoiceInputButton';
import VoiceCloudConfirm from '@/modules/chat/composer/VoiceCloudConfirm';
import { hasAcceptedCloud, isCloudSupported, markCloudAccepted, readVoiceMode, writeVoiceMode, type VoiceMode } from '@/modules/chat/hooks/voiceMode';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';
import { ScheduledMessageList } from '@/modules/chat/composer/ScheduledMessageList';
import { toggleTranscriptQuiet, useTranscriptQuiet } from '@/modules/chat/utils/transcriptViewMode';
import { NightQueuePanel } from '@/modules/chat/composer/NightQueuePanel';
import type { NightQueueControls } from '@/modules/chat/composer/useNightQueue';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';
import CanvasComposerButton from '@/modules/canvas/CanvasComposerButton';
import { VoiceCallButton, VoiceCallPanel, type VoiceTurnSender } from '@/modules/voice-call';

type MentionableFile = {
  name: string;
  path: string;
};

type ChatComposerProps = {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  activity: SessionActivity | null;
  /** DHC CLI: the tool call still waiting for its result, for the "Bash 已 45秒" readout. */
  runningTool?: { name: string; startedAt: number } | null;
  isLoading: boolean;
  onAbortSession: () => void;
  permissionMode: PermissionMode;
  availablePermissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
  providerLabel: string;
  /** Set while the Google agy provider is selected: the data-handling warning and, when the project is not whitelisted, why it cannot be used. */
  agyNotice?: { modelLabel: string; blockedReason: string | null } | null;
  effort: string;
  availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  model: string;
  availableModelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  onCompact?: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  /** DHC CLI: holds the typed message until the current turn finishes (Enter sends now instead). */
  onQueueMessage: (event: MouseEvent<HTMLButtonElement>) => void;
  onInterruptMessage: (event: MouseEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  queuedDraft: QueuedDraft | null;
  /** Set while the composer is replacing an already-sent message. */
  isEditingSentMessage: boolean;
  onCancelEditMessage: () => void;
  /** Messages waiting to be sent to this session later. */
  scheduledMessages: ScheduledMessage[];
  onScheduleMessage: (scheduledFor: Date) => void;
  /** Set while scheduling cannot work (an unsent new chat, files attached); shown as the clock's tooltip. */
  scheduleBlockedReason?: string | null;
  /** Set while the provider cannot receive files or images: the attach button is off and says why. */
  attachDisabledReason?: string | null;
  onCancelScheduledMessage: (id: string) => void;
  /** DHC CLI: this chat's night mode — prompts stored and run one at a time from 02:00. */
  nightQueue: NightQueueControls;
  /** DHC CLI 快閃任務: the ⚡ toggle, per session like the moon. */
  flashTask?: { enabled: boolean; onToggle: () => void };
  /** DHC CLI 蒸餾模式: the flask toggle, per session like the ⚡; only passed for Claude sessions. */
  distillTask?: { enabled: boolean; onToggle: () => void };
  onEditQueuedDraft: () => void;
  onDeleteQueuedDraft: () => void;
  attachedFiles: File[];
  onRemoveAttachment: (index: number) => void;
  /** DHC CLI: an attached image after it was marked up. */
  onReplaceAttachment?: (index: number, file: File) => void;
  fileErrors: Map<string, string>;
  fileProgress?: Map<string, number>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openAttachmentPicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onVoiceTranscript?: (text: string, send?: boolean) => void;
  /** DHC CLI 語音通話: the conversation on screen and the composer's spoken-turn send. */
  voiceCall?: { sessionId: string | null; sendTurn: VoiceTurnSender };
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  isInputFocused?: boolean;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
};

/**
 * Rendered by chat's ChatInterface as the whole input area: textarea, pending
 * attachments, queued message, permission banner, voice input and the
 * model/permission popovers that drive the next turn.
 */
export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  activity,
  runningTool = null,
  isLoading,
  onAbortSession,
  permissionMode,
  availablePermissionModes,
  onSelectPermissionMode,
  providerLabel,
  agyNotice,
  effort,
  availableEffortOptions,
  onSelectEffort,
  model,
  availableModelOptions,
  onSelectModel,
  modelsLoading,
  tokenBudget,
  onShowTokenUsage,
  onCompact,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  onSubmit,
  onQueueMessage,
  onInterruptMessage,
  isDragActive,
  queuedDraft,
  isEditingSentMessage,
  onCancelEditMessage,
  scheduledMessages,
  onScheduleMessage,
  scheduleBlockedReason,
  attachDisabledReason,
  onCancelScheduledMessage,
  nightQueue,
  flashTask,
  distillTask,
  onEditQueuedDraft,
  onDeleteQueuedDraft,
  attachedFiles,
  onRemoveAttachment,
  onReplaceAttachment,
  fileErrors,
  fileProgress,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openAttachmentPicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onVoiceTranscript,
  voiceCall,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  isInputFocused = false,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  const isPresenter = useIsPresenter();
  // Phone width: one compact row (⋯ tools, mic, send); the other controls fold into the ⋯ panel.
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const [toolsOpen, setToolsOpen] = useState(false);
  const fileDropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedFileRef = useRef<HTMLDivElement | null>(null);
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [isCommandMenuOpen, textareaRef]);

  useEffect(() => {
    const dropdown = fileDropdownRef.current;
    const selectedFile = selectedFileRef.current;
    if (!showFileDropdown || !dropdown || !selectedFile) {
      return;
    }

    const itemTop = selectedFile.offsetTop;
    const itemBottom = itemTop + selectedFile.offsetHeight;
    const visibleTop = dropdown.scrollTop;
    const visibleBottom = visibleTop + dropdown.clientHeight;

    if (itemTop < visibleTop) {
      dropdown.scrollTop = itemTop;
    } else if (itemBottom > visibleBottom) {
      dropdown.scrollTop = itemBottom - dropdown.clientHeight;
    }
  }, [selectedFileIndex, showFileDropdown]);

  // Voice state is hosted here (not in the mic button) so the main Send button can stop
  // recording and send the transcript in one tap, the way the mic button drops it in the box.
  const voiceAvailable = useVoiceAvailable();
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVoiceError = useCallback((msg: string) => {
    setVoiceError(msg);
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
    voiceErrorTimer.current = setTimeout(() => setVoiceError(null), 6000);
  }, []);
  useEffect(() => () => {
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
  }, []);
  const noopTranscript = useCallback(() => {}, []);
  // 語音模式：雲端（Web Speech）或本機（whisper）；不支援 Web Speech 時只有本機
  const cloudSupported = isCloudSupported();
  const [voiceMode, setVoiceModeState] = useState<VoiceMode>(readVoiceMode);
  const changeVoiceMode = useCallback((m: VoiceMode) => {
    writeVoiceMode(m);
    setVoiceModeState(m);
  }, []);
  const [cloudConfirmOpen, setCloudConfirmOpen] = useState(false);
  const cloudConfirmResolver = useRef<((ok: boolean) => void) | null>(null);
  const confirmCloud = useCallback(
    () => new Promise<boolean>((resolve) => {
      if (hasAcceptedCloud()) { resolve(true); return; }
      cloudConfirmResolver.current = resolve;
      setCloudConfirmOpen(true);
    }),
    [],
  );
  const resolveCloudConfirm = useCallback((ok: boolean) => {
    setCloudConfirmOpen(false);
    if (ok) markCloudAccepted();
    cloudConfirmResolver.current?.(ok);
    cloudConfirmResolver.current = null;
  }, []);
  const { state: voiceState, toggle: voiceToggle, stop: voiceStop, interim: voiceInterim } = useVoiceInput(
    onVoiceTranscript ?? noopTranscript,
    handleVoiceError,
    { mode: voiceMode, confirmCloud },
  );
  // 麥克風選單選了雲端／本地：先換模式，等下一輪 render 拿到新模式的 toggle 再開始錄音
  const [voiceStartTick, setVoiceStartTick] = useState(0);
  const startVoiceWith = useCallback((m: VoiceMode) => {
    changeVoiceMode(m);
    setVoiceStartTick((n) => n + 1);
  }, [changeVoiceMode]);
  useEffect(() => {
    if (voiceStartTick > 0) voiceToggle();
    // 只在選單觸發時跑；voiceToggle 跟著模式換，不列入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceStartTick]);
  const isRecording = voiceState === 'recording';
  const [callOpen, setCallOpen] = useState(false);
  const isTranscribing = voiceState === 'transcribing';

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // Hide the thinking/status bar while any permission request is pending
  const hasPendingPermissions = pendingPermissionRequests.length > 0;
  const hasActivityIndicator = Boolean(activity && !hasPendingPermissions);

  const quietView = useTranscriptQuiet();
  // DHC CLI UI night 1: the toolbar keeps attach / voice / context / 分流; the rest lives in a "…" menu.
  const contextUsed = Number(tokenBudget?.used ?? 0);
  const contextTotal = Number(tokenBudget?.total ?? 0);
  const contextPct = contextTotal > 0 ? Math.round((contextUsed / contextTotal) * 100) : 0;
  const contextHot = contextPct >= 80;
  const hasQueuedDraft = Boolean(queuedDraft);
  const hasPendingInput = Boolean(input.trim() || attachedFiles.length > 0);
  // DHC CLI: in night mode the typed prompt is stored for the night queue — even while a turn runs — except
  // when it answers an open question or replaces an already-sent message.
  const nightMode = nightQueue.enabled;
  const flashMode = Boolean(flashTask?.enabled);
  const distillMode = Boolean(distillTask?.enabled);
  const storesForNight = nightMode && !hasQuestionPanel && !isEditingSentMessage;
  const canStoreForNight = storesForNight && hasPendingInput;
  // DHC CLI: while a turn runs, Enter hands the message to that turn (desktop-app style — Claude reads it before
  // its next step); interrupting and queueing are the explicit secondary buttons. While an AskUserQuestion
  // prompt is open, typed text answers it.
  const canSendNow = isLoading && hasPendingInput && !hasQuestionPanel && !storesForNight;
  const canQueueDraft = canSendNow;
  const interruptLabel = t('input.interruptNow', { defaultValue: 'Interrupt: stop this turn and send now' });
  const queueLabel = hasQueuedDraft
    ? t('input.queue.update', { defaultValue: 'Replace the queued message' })
    : t('input.queue.sendNext', { defaultValue: 'Queue: send after this turn finishes' });
  // DHC CLI 10/31 收起輸入框 (desktop): with nothing typed the composer folds to a one-line strip and opens when the
  // pointer reaches it. Enter with nothing focused opens and focuses it (locked open); Enter on the empty box, or
  // focusing anything else, lets it fold again. Menus portalled to <body> count as inside, so a trigger never
  // vanishes under its own open menu.
  const [dockEngaged, setDockEngaged] = useState(false);
  useEffect(() => {
    if (isMobile) return undefined;
    const inside = (target: EventTarget | null) => target instanceof Element
      && Boolean(target.closest('[data-composer-dock], [role="menu"], [role="dialog"], [role="listbox"]'));
    // Folding moves everything above the composer down, so it waits until the pointer is released: folding on
    // pointerdown made a click on a button above the composer land somewhere else.
    let pointerHeld = false;
    let release: boolean | null = null;
    const update = (event: Event) => {
      if (event.type === 'pointerdown') pointerHeld = true;
      if (inside(event.target)) {
        release = null;
        setDockEngaged(true);
      } else if (pointerHeld) {
        release = true;
      } else {
        setDockEngaged(false);
      }
    };
    const onPointerUp = () => {
      window.setTimeout(() => {
        pointerHeld = false;
        if (release) setDockEngaged(false);
        release = null;
      }, 0);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      textareaRef.current?.focus();
    };
    document.addEventListener('focusin', update);
    document.addEventListener('pointerdown', update, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('pointerdown', update, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [isMobile, textareaRef]);
  const dockFoldable = !isMobile && !dockEngaged && !hasPendingInput && !isRecording && !callOpen && !isDragActive
    && !hasQuestionPanel && !isEditingSentMessage;
  const releaseDockOnEmptyEnter = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || target !== textareaRef.current) return;
    if (hasPendingInput || isCommandMenuOpen || showFileDropdown) return;
    event.preventDefault();
    event.stopPropagation();
    textareaRef.current?.blur();
    setDockEngaged(false);
  };
  const contextBarColor = contextPct >= 90 ? 'bg-red-500' : contextPct >= 70 ? 'bg-amber-500' : 'bg-primary/60';
  const scheduleModelPermission = (
    <>
      {/* While a turn runs, typing adds the 打斷／排隊 buttons; the clock steps aside so the toolbar stays one row. */}
      {!canSendNow && (
        <ScheduleMessagePopover
          disabled={!input.trim()}
          disabledReason={scheduleBlockedReason}
          onSchedule={onScheduleMessage}
        />
      )}

      <ComposerModelMenu
        effort={effort}
        effortOptions={availableEffortOptions}
        onSelectEffort={onSelectEffort}
        model={model}
        modelOptions={availableModelOptions}
        onSelectModel={onSelectModel}
        modelsLoading={modelsLoading}
      />

      <ComposerPermissionMenu
        permissionMode={permissionMode}
        permissionModes={availablePermissionModes}
        onSelectPermissionMode={onSelectPermissionMode}
        providerLabel={providerLabel}
      />

    </>
  );
  const submitAriaLabel = hasQuestionPanel
    ? t('input.send')
    : canStoreForNight
      ? t('nightQueue.store')
      : canSendNow
        ? t('input.sendNow', { defaultValue: 'Add to the running turn' })
        : isLoading
          ? t('input.stop')
          : t('input.send');

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6">
      {!hasPendingPermissions && (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-10 w-[calc(100%-1rem)] max-w-[54.25rem] -translate-x-1/2 translate-y-px bg-transparent sm:w-[calc(100%-2rem)]">
          <ActivityIndicator activity={activity} runningTool={runningTool} onAbort={onAbortSession} isInputFocused={isInputFocused} />
        </div>
      )}

      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-[54.25rem]">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
          />
        </div>
      )}

      <ScheduledMessageList
        scheduledMessages={scheduledMessages}
        onCancel={onCancelScheduledMessage}
      />

      <NightQueuePanel {...nightQueue} />

      {flashMode && (
        <div className="mx-auto mb-2 flex max-w-[54.25rem] items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-foreground">
          <Zap className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500" />
          <span className="min-w-0 flex-1">
            快閃任務
            <span data-tutorial className="text-muted-foreground">：做完在側欄按 ×，或按上方「結束任務」，對話會移到側欄「封存」，7 天內可以還原，之後自動刪除。要留就再次點擊快閃任務轉換成正式專案。</span>
          </span>
        </div>
      )}

      {distillMode && (
        <div className="mx-auto mb-2 flex max-w-[54.25rem] items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-foreground">
          <FlaskConical className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="min-w-0 flex-1">
            蒸餾模式
            <span data-tutorial className="text-muted-foreground">：Claude 會把你的糾正、選擇和理由記到「蒸餾任務」資料夾；做完說「結案」，整理成下次能直接用的技能草稿。</span>
          </span>
        </div>
      )}

      {isEditingSentMessage && (
        <div className="mx-auto mb-2 flex max-w-[54.25rem] items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
          <PencilIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1">
            {t('composer.editing.title')}
            {' — '}
            <span className="text-muted-foreground">{t('composer.editing.filesNotReverted')}</span>
          </span>
          <button
            type="button"
            onClick={onCancelEditMessage}
            className="shrink-0 rounded-md px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('composer.editing.cancel')}
          </button>
        </div>
      )}

      {queuedDraft && (
        <QueuedMessageCard
          content={queuedDraft.content}
          attachmentCount={
            queuedDraft.uploadedAttachments?.length ?? queuedDraft.attachments.length
          }
          onEdit={onEditQueuedDraft}
          onDelete={onDeleteQueuedDraft}
        />
      )}

      {callOpen && voiceCall && (
        <VoiceCallPanel
          sessionId={voiceCall.sessionId}
          sendTurn={voiceCall.sendTurn}
          isLoading={isLoading}
          onAbort={onAbortSession}
          confirmCloud={confirmCloud}
          whisperReady={voiceAvailable}
          onClose={() => setCallOpen(false)}
        />
      )}

      <div
        data-composer-dock
        data-foldable={dockFoldable || undefined}
        onKeyDownCapture={releaseDockOnEmptyEnter}
        className="relative mx-auto max-w-[54.25rem]"
      >
        {showFileDropdown && filteredFiles.length > 0 && (
          <div
            ref={fileDropdownRef}
            className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md"
          >
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                ref={index === selectedFileIndex ? selectedFileRef : undefined}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        {agyNotice && (
          <div className="mb-1.5 space-y-1 text-xs" data-testid="agy-notice">
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-foreground">
              {`經 Google agy（目前模型：${agyNotice.modelLabel}）：內容會原文送到 Google、不經去識別；回答與改動請自行核對。`}
            </p>
            {agyNotice.blockedReason && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive">
                {agyNotice.blockedReason}
              </p>
            )}
          </div>
        )}
        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading && !hasQuestionPanel ? 'streaming' : 'ready'}
          className={[
            isTextareaExpanded ? 'chat-input-expanded' : '',
            hasActivityIndicator ? 'rounded-t-none' : '',
          ].filter(Boolean).join(' ')}
          {...getRootProps()}
        >
          {isMobile && contextTotal > 0 && (
            <button
              type="button"
              onClick={onShowTokenUsage}
              aria-label={t('misc.showTokenUsage')}
              title={`上下文已用 ${contextPct}%`}
              className="absolute inset-x-0 top-0 z-10 h-3"
            >
              <span className={`block h-0.5 ${contextBarColor}`} style={{ width: `${Math.min(100, contextPct)}%` }} />
            </button>
          )}

          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">{t('chat:misc.dropFiles')}</p>
              </div>
            </div>
          )}

          {attachedFiles.length > 0 && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedFiles.map((file, index) => (
                    <ComposerAttachment
                      key={`${file.name}-${file.lastModified}-${index}`}
                      file={file}
                      onRemove={() => onRemoveAttachment(index)}
                      onReplace={onReplaceAttachment ? (edited) => onReplaceAttachment(index, edited) : undefined}
                      error={fileErrors.get(file.name)}
                      progress={fileProgress?.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          <PromptInputBody>
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className="chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent max-md:text-base">
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              aria-label="輸入訊息"
              dir="auto"
              className="max-md:text-base"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={
                hasQuestionPanel
                  ? t('input.placeholderAnswer', { defaultValue: 'Or type your answer here…' })
                  : storesForNight
                    ? t('nightQueue.placeholder')
                    : (isPresenter ? '請輸入您想問的問題' : placeholder)
              }
            />
        </PromptInputBody>

        <PromptInputFooter className="flex-wrap gap-y-1">
          {isMobile && (
            <PromptInputButton
              onClick={() => setToolsOpen((open) => !open)}
              aria-expanded={toolsOpen}
              aria-label="輸入框工具"
              data-tutorial-tip="輸入框工具：展開附件、語音等按鈕"
              className={`h-10 w-10 ${toolsOpen ? 'bg-muted text-foreground' : ''}`}
            >
              <MoreHorizontal />
            </PromptInputButton>
          )}
          {isMobile && onVoiceTranscript && voiceAvailable && (
            <span className="inline-flex [&_button]:h-10 [&_button]:w-10">
              <VoiceInputButton state={voiceState} onToggle={voiceToggle} errorMsg={voiceError} interim={voiceInterim} mode={voiceMode} onStartWith={cloudSupported ? startVoiceWith : undefined} onCall={voiceCall ? () => setCallOpen(true) : undefined} />
            </span>
          )}

          <PromptInputTools className={isMobile ? `min-w-0 flex-wrap order-last basis-full [&_button]:min-h-10 [&_button]:min-w-10 ${toolsOpen ? '' : 'hidden'}` : 'min-w-0'}>
            <PromptInputButton
              tooltip={{ content: attachDisabledReason || t('input.attachFiles') }}
              disabled={Boolean(attachDisabledReason)}
              onClick={openAttachmentPicker}
              aria-label={t('input.attachFiles')}
              data-tutorial-tip="附加檔案：選圖片或檔案，跟訊息一起送出"
            >
              <PaperclipIcon />
            </PromptInputButton>

            {/* 投影 外觀：DHC 的小工具平常藏起來，按住 Alt 才浮出 */}
            <div data-presenter-extra className="contents">
            {!isMobile && onVoiceTranscript && voiceAvailable && (
              <VoiceInputButton state={voiceState} onToggle={voiceToggle} errorMsg={voiceError} interim={voiceInterim} mode={voiceMode} onStartWith={cloudSupported ? startVoiceWith : undefined} onCall={voiceCall ? () => setCallOpen(true) : undefined} />
            )}
            {voiceCall && !(onVoiceTranscript && voiceAvailable) && <VoiceCallButton active={callOpen} whisperReady={voiceAvailable} onClick={() => setCallOpen(true)} />}

            <TokenUsageSummary usage={tokenBudget} onClick={onShowTokenUsage} />
            {onCompact && contextHot && (
              <PromptInputButton
                tooltip={{ content: `上下文已用 ${contextPct}%，建議清理（/compact：摘要後釋放空間，工作不中斷）` }}
                onClick={onCompact}
                disabled={isLoading}
                className="text-amber-600 dark:text-amber-400"
                aria-label="清理上下文"
                data-tutorial-tip="清理上下文：對話快滿了，按一下把舊內容摘要掉（/compact）"
              >
                <Eraser className="h-4 w-4" />
              </PromptInputButton>
            )}

            <PromptInputButton
              tooltip={{ content: nightMode ? t('nightQueue.toggleOff') : t('nightQueue.toggleOn') }}
              onClick={nightQueue.onToggle}
              aria-pressed={nightMode}
              aria-label={t('nightQueue.label')}
              data-tutorial-tip="分流：送出的內容先存起來，01:00 起依序跑；指定時間改用時鐘"
              className={
                nightMode
                  ? 'w-auto gap-1 bg-indigo-500/15 px-2 text-indigo-600 hover:bg-indigo-500/25 dark:text-indigo-300'
                  : undefined
              }
            >
              <Moon />
              {nightMode && <span className="text-xs font-medium">{t('nightQueue.label')}</span>}
            </PromptInputButton>

            {flashTask && (
              <PromptInputButton
                tooltip={{ content: flashMode ? '關閉快閃任務（對話會保留）' : '快閃任務：一次性的小事，做完一鍵收掉（7 天後自動刪除）' }}
                onClick={flashTask.onToggle}
                aria-pressed={flashMode}
                aria-label="快閃任務"
                data-tutorial-tip="快閃任務：一次性的小事，做完一鍵收掉，7 天後自動刪除"
                className={
                  flashMode
                    ? 'w-auto gap-1 bg-amber-500/15 px-2 text-amber-600 hover:bg-amber-500/25 dark:text-amber-300'
                    : undefined
                }
              >
                <Zap className={flashMode ? 'fill-amber-400' : undefined} />
                {flashMode && <span className="text-xs font-medium">快閃任務</span>}
              </PromptInputButton>
            )}

            {distillTask && (
              <PromptInputButton
                tooltip={{ content: distillMode ? '關閉蒸餾模式（已記的保留）' : '蒸餾模式：記下這件工作的判斷，結案時整理成技能' }}
                onClick={distillTask.onToggle}
                aria-pressed={distillMode}
                aria-label="蒸餾模式"
                data-tutorial-tip="蒸餾模式：記下這件工作的判斷，結案時整理成技能"
                className={
                  distillMode
                    ? 'w-auto gap-1 bg-emerald-500/15 px-2 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-300'
                    : undefined
                }
              >
                <FlaskConical />
                {distillMode && <span className="text-xs font-medium">蒸餾模式</span>}
              </PromptInputButton>
            )}

            <CanvasComposerButton />

            <span className="inline-flex" data-tutorial-tip="更多：清理上下文、簡約檢視、指令清單">
            <ActionMenu
              label="更多"
              ariaLabel="更多輸入框工具"
              icon={MoreHorizontal}
              iconOnly
              portal
              align="left"
              variant="ghost"
              size="icon"
              triggerClassName="h-8 w-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              menuClassName="w-[280px] rounded-xl p-1.5 shadow-xl"
              items={[
                ...(onCompact ? [{
                  key: 'compact',
                  label: contextPct ? `清理上下文（已用 ${contextPct}%）` : '清理上下文',
                  description: '/compact：把對話摘要成短版釋放空間，工作不中斷',
                  icon: Eraser,
                  onSelect: onCompact,
                  disabled: isLoading,
                }] : []),
                {
                  key: 'quiet',
                  label: quietView ? '切回完整檢視' : '簡約檢視',
                  description: quietView ? '顯示所有工具呼叫與中間過程' : '只留提問和每輪結論，中間過程摺成一行',
                  icon: quietView ? EyeOff : Eye,
                  onSelect: toggleTranscriptQuiet,
                },
                {
                  key: 'commands',
                  label: slashCommandsCount > 0 ? `指令清單（${slashCommandsCount}）` : '指令清單',
                  description: '也可以直接在輸入框打 /，/review 會請 Claude 審自己的修改',
                  icon: MessageSquareIcon,
                  onSelect: onToggleCommandMenu,
                },
              ]}
            />
            </span>
            </div>

            {isMobile && scheduleModelPermission}

            {hasInput && (
              <PromptInputButton
                data-presenter-extra
                tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                onClick={onClearInput}
                className="hidden sm:flex"
              >
                <XIcon />
              </PromptInputButton>
            )}

          </PromptInputTools>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {!isMobile && <div data-presenter-extra className="contents">{scheduleModelPermission}</div>}

            {canSendNow && (
              <PromptInputButton
                tooltip={{ content: interruptLabel }}
                onClick={(e: MouseEvent<HTMLButtonElement>) => {
                  e.preventDefault();
                  onInterruptMessage(e);
                }}
                aria-label={interruptLabel}
                data-tutorial-tip="打斷：停掉這一輪，立刻送出你剛打的訊息"
                className="h-10 w-10 sm:h-10 sm:w-10"
              >
                <OctagonX className="h-4 w-4" />
              </PromptInputButton>
            )}

            {canQueueDraft && (
              <PromptInputButton
                tooltip={{ content: queueLabel }}
                onClick={(e: MouseEvent<HTMLButtonElement>) => {
                  e.preventDefault();
                  onQueueMessage(e);
                }}
                aria-label={queueLabel}
                data-tutorial-tip="排隊：等 Claude 這一輪做完再送出"
                className="h-10 w-10 sm:h-10 sm:w-10"
              >
                <ListEnd className="h-4 w-4" />
              </PromptInputButton>
            )}

            <PromptInputSubmit
              data-presenter-send
              onClick={
                canSendNow || canStoreForNight
                  ? (e: MouseEvent<HTMLButtonElement>) => {
                      e.preventDefault();
                      onSubmit(e);
                    }
                  : isLoading && !hasQuestionPanel
                    ? onAbortSession
                    : isRecording
                      ? (e: MouseEvent<HTMLButtonElement>) => {
                          e.preventDefault();
                          voiceStop({ send: true });
                        }
                      : undefined
              }
              disabled={
                isLoading && !hasQuestionPanel
                  ? false
                  : isRecording
                    ? false
                    : isTranscribing
                      ? true
                      : !input.trim() && attachedFiles.length === 0
              }
              aria-label={submitAriaLabel}
              title={submitAriaLabel}
              data-tutorial-tip="送出訊息；Claude 回覆中有打字＝插話，沒打字＝停止"
              className="h-10 w-10 sm:h-10 sm:w-10"
            >
              {isTranscribing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : storesForNight && !isRecording && (hasPendingInput || !isLoading) ? (
                <Moon className="h-4 w-4" />
              ) : flashMode && !isRecording && (canSendNow || !isLoading || hasQuestionPanel) ? (
                <Zap className="h-4 w-4" />
              ) : canSendNow ? (
                <ArrowUpIcon className="h-4 w-4" />
              ) : undefined}
            </PromptInputSubmit>
          </div>

        </PromptInputFooter>
      </PromptInput>
      <VoiceCloudConfirm open={cloudConfirmOpen} onResolve={resolveCloudConfirm} />
      </div>
    </div>
  );
}
