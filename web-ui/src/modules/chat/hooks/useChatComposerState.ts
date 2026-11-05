import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';

import { api } from '@/shared/api';
import { findPiiInTurn, piiBlockMessage } from '@/shared/piiGuard';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import { readActiveSettingsProfile, readUserPreference } from '@/shared/userSettings';
import { readCoSession, useCoSession, withSenderPrefix } from '@/shared/coSessions';
import { DISTILL_SYSTEM_NOTE } from '@/shared/distillSessions';
import { appendNotes, CANVAS_SYSTEM_NOTE, isCanvasMode } from '@/modules/canvas';
import type { CommandModalPayload, CostCommandData, HelpCommandData, MarkSessionProcessing, ModelCommandData, QueuedDraft, SessionActivityMap, StatusCommandData,QueuedSendOptions,ChatAttachment,ChatMessage,PendingPermissionRequest,PermissionMode,SessionEstablishedContext,Project,ProjectSession,LLMProvider,SlashCommand } from '@/shared/types';
import { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
import { CHUNKED_UPLOAD_MAX_SIZE, DIRECT_UPLOAD_MAX_SIZE, uploadFileInChunks } from '@/modules/chat/utils/chunkedUpload';
import {
  clearQueuedMessage,
  hydrateChatDrafts,
  readDraftText,
  readQueuedMessage,
  subscribeToChatDrafts,
  writeDraftText,
  writeQueuedMessage,
} from '@/shared/chatDrafts';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
import { markInterruptSend } from '@/modules/chat/utils/interruptSends';
import { parseStartAnnotation } from '@/modules/chat/utils/nightQueueTime';
import { commitCommandModeTurn, prepareCommandModeAttachment } from '@/modules/command-mode';
import { fetchModelAdvice, isOpusModel, readModelAdviceMode, SONNET_MODEL, type ModelAdviceChip } from '@/modules/chat/utils/modelAdvice';

type UseChatComposerStateArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  sendByCtrlEnter?: boolean;
  /** False when the selected provider never receives files or images: paste and drop then attach nothing. */
  attachmentsEnabled?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onClearConversation?: () => void; // DHC CLI: /clear and /new
  onReviewChanges?: () => void; // DHC CLI: /review — ask Claude to review what it changed this session
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /** DHC CLI: the run's open permission prompts; a typed reply answers a pending AskUserQuestion. */
  pendingPermissionRequests?: PendingPermissionRequest[];
  /** DHC CLI: this chat is in night mode — prompts are stored for the night queue instead of sent. */
  nightMode?: boolean;
  /**
   * DHC CLI: stores one prompt in a session's night queue — at `startAt` when it named its own time ("@12:05"),
   * else the 02:00 window; says why when it could not be stored.
   */
  onNightQueueSubmit?: (
    sessionId: string,
    content: string,
    options: Record<string, unknown>,
    startAt?: string | null,
  ) => Promise<{ ok: true } | { ok: false; message: string | null }>;
  /** DHC CLI: the flask is on — every turn carries the 蒸餾模式 note as the system-prompt append. */
  distillMode?: boolean;
  /** DHC CLI 開對話建議模型: records a model against one session only (the new-chat default stays). */
  selectSessionModel?: (sessionId: string, model: string) => Promise<void> | void;
};

type MentionableFile = {
  name: string;
  path: string;
};

type CommandExecutionResult = {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
};






// files: 指揮模式附上的電腦畫面截圖（可能畫了圈點），走一般附件上傳。
type VoiceTurnInput = { text: string; clientRequestId: string; appendSystemPrompt: string; files?: File[] };

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const EDIT_ANCHOR_PREFIX = 'dhc.editAnchor.';
const MAX_ATTACHMENT_COUNT = 10;
// DHC CLI: files up to 10MB go up in one request; larger ones (up to 2GB) in chunks.
const MAX_ATTACHMENT_SIZE = CHUNKED_UPLOAD_MAX_SIZE;

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

const uploadAttachmentFiles = async (
  files: File[],
  onProgress?: (fileName: string, fraction: number) => void,
): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const results: unknown[] = new Array(files.length);
  const directIndexes = files.flatMap((file, index) => (file.size <= DIRECT_UPLOAD_MAX_SIZE ? [index] : []));

  if (directIndexes.length > 0) {
    const formData = new FormData();
    directIndexes.forEach((index) => {
      formData.append('files', files[index]);
    });

    const response = await api.assets.uploadFiles(formData);

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || 'Failed to upload files');
    }

    const result = await response.json();
    if (!Array.isArray(result.attachments) || result.attachments.length !== directIndexes.length) {
      throw new Error('File upload returned an incomplete result');
    }
    directIndexes.forEach((fileIndex, resultIndex) => {
      results[fileIndex] = result.attachments[resultIndex];
    });
  }

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file.size > DIRECT_UPLOAD_MAX_SIZE) {
      try {
        results[index] = await uploadFileInChunks(file, (fraction) => onProgress?.(file.name, fraction));
      } catch (error) {
        onProgress?.(file.name, -1);
        throw error;
      }
    }
  }
  return results;
};


/** DHC CLI: a Co-Work session's draft scope, one per person (device profile). */
const coWorkDraftScope = (sessionId: string): string => (
  `${sessionId}#${readActiveSettingsProfile()?.id ?? 'shared'}`
);

const restoreQueuedDraft = (sessionKey: string): QueuedDraft | null => {
  const saved = readQueuedMessage(sessionKey);
  return saved
    ? {
        content: saved.content,
        attachments: [],
        uploadedAttachments: saved.attachments ?? saved.images,
        options: saved.options,
      }
    : null;
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  currentProviderModel,
  currentProviderEffort,
  isLoading,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  attachmentsEnabled = true,
  pendingPermissionRequests,
  nightMode = false,
  onNightQueueSubmit,
  distillMode = false,
  selectSessionModel,
  onSessionProcessing,
  onSessionEstablished,
  onFileOpen,
  onShowSettings,
  onClearConversation,
  onReviewChanges,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  // The composer text together with the chat scope it belongs to. They are one
  // state rather than a value plus a ref because they have to move in lockstep:
  // on a session switch there is one commit where the scope has already changed
  // while the text has not, and anything that persisted the text in that commit
  // would write the previous session's message into the new session's draft.
  // A ref cannot express this — React evaluates a state updater eagerly, so a
  // ref set inside one is already ahead by the time the effects run.
  //
  // Restored synchronously from the draft mirror so a reload shows what was
  // being typed on the first paint rather than after the drafts request lands.
  /**
   * The already-sent message the composer is currently replacing, or null.
   *
   * Holds the anchor rather than the message, because that is all the send
   * needs and it keeps a stale message object from being captured while the
   * transcript refreshes underneath the composer.
   */
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);

  const [inputState, setInputState] = useState<{ scope: string | null; value: string }>(() => {
    if (typeof window === 'undefined') {
      return { scope: null, value: '' };
    }
    const initialSessionId = selectedSession?.id || currentSessionId;
    const initialScope = initialSessionId
      ? (readCoSession(initialSessionId) ? coWorkDraftScope(initialSessionId) : initialSessionId)
      : (selectedProject ? `project:${selectedProject.projectId}` : null);
    return {
      scope: initialScope,
      value: initialScope ? readDraftText(initialScope) : '',
    };
  });
  const input = inputState.value;
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  // DHC CLI: chunked-upload progress (0–1) per attachment name, cleared when the upload ends.
  const [fileProgress, setFileProgress] = useState<Map<string, number>>(new Map());
  const reportUploadProgress = useCallback((fileName: string, fraction: number) => {
    setFileProgress((previous) => {
      const next = new Map(previous);
      // 1 = done, -1 = failed; either way the bar goes away.
      if (fraction >= 1 || fraction < 0) next.delete(fileName);
      else next.set(fileName, fraction);
      return next;
    });
  }, []);
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [modelAdviceChip, setModelAdviceChip] = useState<ModelAdviceChip | null>(null);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
    ) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  // The chat scope a draft belongs to: the open session, or the project for a
  // chat that has not been sent yet and so has no session id. Drafts used to be
  // keyed by project alone, so every session in a project shared one draft.
  const baseDraftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  // DHC CLI: everyone shares one server account, so a Co-Work session's draft
  // would sync what another participant is typing into this composer. Give each
  // person (device profile) their own draft there; the queue stays per session.
  const isCoWorkSession = Boolean(useCoSession(sessionKey));
  const draftScope = isCoWorkSession && sessionKey ? coWorkDraftScope(sessionKey) : baseDraftScope;
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  // The edit target goes with the draft: after a reload the text is back, so the anchor it replaces must be too.
  const writeEditAnchor = (scope: string | null, anchorId: string | null) => {
    if (!scope) return;
    try {
      if (anchorId) localStorage.setItem(EDIT_ANCHOR_PREFIX + scope, anchorId);
      else localStorage.removeItem(EDIT_ANCHOR_PREFIX + scope);
    } catch { /* storage unavailable: the edit just does not survive a reload */ }
  };
  const endEditing = useCallback(() => {
    setEditingAnchorId(null);
    writeEditAnchor(draftScopeRef.current, null);
  }, []);
  const setInput = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setInputState((previous) => ({
      scope: draftScopeRef.current,
      value: typeof next === 'function' ? next(previous.value) : next,
    }));
  }, []);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  // Recall writes go through the same pair of stores a send reads: the state
  // (for the render) and inputValueRef (so an immediate Enter submits the
  // recalled text, not a stale value).
  const setInputFromHistory = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, [setInput]);
  const { recordSentMessage, handleHistoryKeyDown } = useInputHistory({
    setInput: setInputFromHistory,
    textareaRef,
    scope: draftScope,
  });

  const [queuedDraft, setQueuedDraft] = useState<QueuedDraft | null>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return null;
    }
    return restoreQueuedDraft(sessionKey);
  });
  // Which session the in-memory `queuedDraft` belongs to. On a session switch
  // there is one commit where `sessionKey` already points at the new session
  // while `queuedDraft` still holds the old session's draft; the persistence
  // effect must not write across that gap.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [addMessage]);

  const onReviewChangesRef = useRef(onReviewChanges);
  onReviewChangesRef.current = onReviewChanges;

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }
      // DHC CLI: /clear (alias /new) = fresh conversation in this project, handled entirely client-side.
      if (command.name === '/clear' || command.name === '/new') {
        setInput('');
        onClearConversation?.();
        return;
      }
      // DHC CLI: /review = the one-click self-review prompt (was a toolbar button; the toolbar was too full).
      if (command.name === '/review') {
        setInput('');
        onReviewChangesRef.current?.();
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await api.commands.execute({
          commandName: command.name,
          commandPath: command.path,
          args,
          context,
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      tokenBudget,
      onClearConversation,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleAttachmentFiles = useCallback((files: File[]) => {
    if (!attachmentsEnabled) return;
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          // DHC CLI: a rejected file never becomes a chip, so the old chip error was invisible.
          addMessage({
            type: 'error',
            content: `「${file.name || 'Unknown file'}」超過 2GB 上限，沒有附加。請先壓縮或分割後再傳。`,
            timestamp: new Date(),
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, [addMessage, attachmentsEnabled]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      // DHC CLI B2: a big paste (a log, a query result) used to blow the box up to hundreds of lines.
      // It becomes a text attachment instead — Claude gets the whole thing, the composer shows a chip.
      const pastedText = event.clipboardData.getData('text/plain');
      const pastedLines = pastedText ? pastedText.split('\n').length : 0;
      if (attachmentsEnabled && pastedText && (pastedLines > 40 || pastedText.length > 6000)) {
        event.preventDefault();
        const stamp = new Date();
        const name = `貼上內容-${pastedLines}行-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}.txt`;
        handleAttachmentFiles([new File([pastedText], name, { type: 'text/plain' })]);
        return;
      }

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [attachmentsEnabled, handleAttachmentFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxFiles: MAX_ATTACHMENT_COUNT,
    disabled: !attachmentsEnabled,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => readUserPreference(
      PROVIDER_PERMISSION_PREFERENCE_KEYS[provider],
      {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      },
    );

    const toolsSettings = getToolsSettings();

    return {
      model: currentProviderModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
      ...appendNotes(distillMode && DISTILL_SYSTEM_NOTE, isCanvasMode() && CANVAS_SYSTEM_NOTE),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    distillMode,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedProject?.projectId,
    selectedSession,
  ]);

  const submitTurn = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      mode?: { queue?: boolean; interrupt?: boolean; voice?: VoiceTurnInput },
    ) => {
      event.preventDefault();
      // DHC CLI 語音通話: a spoken turn brings its own text and leaves the typed draft and attachments alone.
      const voice = mode?.voice;
      const currentInput = voice?.text ?? queuedSubmission?.content ?? inputValueRef.current;
      const currentAttachments = voice ? voice.files ?? [] : queuedSubmission?.attachments ?? attachedFiles;
      const previouslyUploadedAttachments = queuedSubmission?.uploadedAttachments ?? [];
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && previouslyUploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return;
      }

      // DHC CLI 個資防誤傳: checked before any branch below can send or upload, so the text and files stay in the box.
      const piiHits = await findPiiInTurn(currentInput, currentAttachments);
      if (piiHits.length > 0) {
        addMessage({ type: 'error', content: piiBlockMessage(piiHits), timestamp: new Date() });
        return;
      }

      // DHC CLI: while the assistant waits on an AskUserQuestion prompt, the typed reply IS the answer.
      // Before, the box was hidden behind the panel, so people stopped the session to get a word in.
      // Voice never answers a question for the user: it goes to the run as a message.
      const questionRequest = queuedSubmission || voice
        ? undefined
        : pendingPermissionRequests?.find((request) => request.toolName === 'AskUserQuestion');
      if (questionRequest && currentInput.trim() && currentAttachments.length === 0) {
        const questionInput = questionRequest.input && typeof questionRequest.input === 'object'
          ? questionRequest.input as Record<string, unknown>
          : {};
        const questions = Array.isArray(questionInput.questions)
          ? questionInput.questions as Array<{ question?: unknown }>
          : [];
        const firstQuestion = typeof questions[0]?.question === 'string' ? questions[0].question : null;
        const answers: Record<string, string> = firstQuestion ? { [firstQuestion]: currentInput.trim() } : {};
        sendMessage({
          type: 'chat.permission-response',
          requestId: questionRequest.requestId,
          allow: true,
          updatedInput: { ...questionInput, answers },
        });
        setPendingPermissionRequests((previous) =>
          previous.filter((request) => request.requestId !== questionRequest.requestId),
        );
        recordSentMessage(currentInput, sessionKey);
        setInput('');
        inputValueRef.current = '';
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        if (draftScopeRef.current) {
          writeDraftText(draftScopeRef.current, '');
        }
        return;
      }

      // A turn is already in flight and the user chose to queue: stash this message instead of sending it.
      // Upload attached files now so the queued record contains durable image
      // descriptors that can be sent even if another session is open later.
      // DHC CLI: plain Enter while a turn runs no longer queues — it joins the running turn (below).
      if (isLoading && (queuedSubmission || mode?.queue)) {
        // A run can restart in the tiny gap between scheduling and flushing a
        // queued submission. Put the same durable draft back without uploading
        // its files again.
        if (queuedSubmission) {
          queuedDraftSessionRef.current = sessionKey;
          setQueuedDraft(queuedSubmission);
          return;
        }

        const queuedOptions = buildSendOptions(currentInput);
        const queuedSessionKey = sessionKey;
        let uploadedAttachments: unknown[] = [];
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments, reportUploadProgress);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Queued file upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        const durableDraft: QueuedDraft = {
          content: currentInput,
          attachments: currentAttachments,
          uploadedAttachments,
          options: queuedOptions,
        };
        if (queuedSessionKey) {
          // Write the claim ticket synchronously after upload; this closes the
          // gap before React's persistence effect runs.
          writeQueuedMessage(queuedSessionKey, {
            content: durableDraft.content,
            options: durableDraft.options,
            attachments: durableDraft.uploadedAttachments,
          });
        }

        // Recorded under the session the message was queued FOR, and before
        // the session-switch return below — the queued text must be
        // recallable even when it dispatches without this composer.
        recordSentMessage(currentInput, queuedSessionKey);

        // The server owns dispatch after persistence. If the user changed
        // sessions during upload, the durable record is already enough; do
        // not attach its UI card to the newly opened composer.
        if (queuedSessionKey && sessionKeyRef.current !== queuedSessionKey) {
          return;
        }

        queuedDraftSessionRef.current = queuedSessionKey;
        setQueuedDraft(durableDraft);
        setInput('');
        inputValueRef.current = '';
        setAttachedFiles([]);
        setFileErrors(new Map());
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        if (draftScopeRef.current) {
          writeDraftText(draftScopeRef.current, '');
        }
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (!voice && (commandInput.startsWith('/') || isHelpAlias)) {
        const firstSpace = commandInput.indexOf(' ');
        const commandName = isHelpAlias
          ? '/help'
          : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          recordSentMessage(currentInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedFiles([]);
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      // DHC CLI: night mode stores the prompt for the night queue instead of sending it (below). Programmatic
      // turns (the eraser's /compact) and edits of a sent message still go now. 11/01: night only — a prompt's
      // own time and the quota reset are the clock's (排程送出); a leading "@夜間" is read off here.
      const storesForNight = Boolean(nightMode && onNightQueueSubmit && !queuedSubmission && !editingAnchorId && !voice);
      let messageContent = currentInput;
      const nightStartAt: string | null = null;
      if (storesForNight) {
        const annotation = parseStartAnnotation(currentInput);
        if (annotation.kind === 'night') {
          messageContent = annotation.rest;
          if (!messageContent.trim() && currentAttachments.length === 0 && previouslyUploadedAttachments.length === 0) {
            addMessage({ type: 'error', content: '@夜間 後面要寫要做的事。', timestamp: new Date() });
            return;
          }
        }
      }

      let uploadedAttachments = previouslyUploadedAttachments;
      if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments, reportUploadProgress);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('File upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, messageContent);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      // DHC CLI 開對話建議模型: a new chat's first send with an Opus model asks whether Sonnet is enough.
      // 'suggest' does not wait; 'auto' waits (capped) and sends this first message with Sonnet when advised.
      const adviceMode = !targetSessionId && !storesForNight && !queuedSubmission && !editingAnchorId
        && provider === 'claude' && isOpusModel(currentProviderModel)
        ? readModelAdviceMode()
        : 'off';
      const advice = adviceMode === 'off'
        ? null
        : fetchModelAdvice({ text: messageContent, projectPath: resolvedProjectPath, hasAttachment: uploadedAttachments.length > 0 });
      // DHC CLI 11/01: a new chat's bubble shows before the model advice and session creation, and the two run
      // side by side, so the first send no longer sits on screen for the 2–3 s the Haiku judge takes. With no
      // session yet, addMessage keeps it as the pending bubble, which moves into the session once it exists.
      const attachmentRecords = uploadedAttachments as ChatAttachment[];
      const buildUserMessage = (senderName: string, midTurnSend: boolean): ChatMessage => ({
        type: 'user',
        content: withSenderPrefix(currentInput, senderName),
        images: attachmentRecords.filter(isImageAttachment),
        files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
        timestamp: new Date(),
        ...(midTurnSend && !mode?.interrupt ? { midTurn: true } : {}),
        // Tags this echo as the replacement, so the truncation the server
        // broadcasts a moment later cuts the turns being replaced without
        // taking the message the user just sent with them.
        ...(editingAnchorId ? { replacesAnchorId: editingAnchorId } : {}),
      });
      const earlyBubble = !targetSessionId && !storesForNight;
      // A spoken turn is not what the box holds, so it leaves the typed draft and its attachments alone.
      const clearsComposer = earlyBubble && !voice;
      if (earlyBubble) {
        addMessage(buildUserMessage('', false));
      }
      if (clearsComposer) {
        setInput('');
        inputValueRef.current = '';
        setAttachedFiles([]);
      }
      const sessionCreation = targetSessionId
        ? null
        : api.providers.createSession({
          provider,
          projectPath: resolvedProjectPath,
          initialMessage: messageContent,
        }).then((response) => ({ response }), (error: unknown) => ({ error }));
      const firstSendModel = adviceMode === 'auto' && await advice === 'sonnet' ? SONNET_MODEL : null;
      if (!targetSessionId) {
        let createdSessionName = sessionSummary;
        try {
          const created = await sessionCreation!;
          if ('error' in created) {
            throw created.error;
          }
          const { response } = created;
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
          // A blank server name would leave the session unlabeled, so the local
          // summary stays the fallback unless a real name comes back.
          const returnedSessionName = typeof body?.data?.sessionName === 'string'
            ? body.data.sessionName.trim()
            : '';
          if (returnedSessionName) {
            createdSessionName = returnedSessionName;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          if (clearsComposer) {
            setInput(currentInput);
            inputValueRef.current = currentInput;
            setAttachedFiles(currentAttachments);
          }
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          if (clearsComposer) {
            setInput(currentInput);
            inputValueRef.current = currentInput;
            setAttachedFiles(currentAttachments);
          }
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: createdSessionName,
        });
      }

      // DHC CLI Co-workspace: in a shared session every message says who sent it, for Claude and for the others.
      const coSenderName = readCoSession(targetSessionId) ? readActiveSettingsProfile()?.name ?? '' : '';
      messageContent = withSenderPrefix(messageContent, coSenderName);

      // DHC CLI: night mode — store it (from 02:00, or its own time), one at a time, instead of sending it.
      if (storesForNight && onNightQueueSubmit) {
        const stored = await onNightQueueSubmit(targetSessionId, messageContent, {
          ...buildSendOptions(messageContent),
          attachments: uploadedAttachments,
        }, nightStartAt);
        if (!stored.ok) {
          addMessage({
            type: 'error',
            content: stored.message
              ? `這則沒有存進夜間排程：${stored.message}`
              : '這則沒有存進夜間排程（連線問題），請再送一次。',
            timestamp: new Date(),
          });
          return;
        }

        recordSentMessage(currentInput, targetSessionId);
        setInput('');
        inputValueRef.current = '';
        resetCommandMenuState();
        setAttachedFiles([]);
        setFileErrors(new Map());
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        if (draftScopeRef.current) {
          writeDraftText(draftScopeRef.current, '');
        }
        return;
      }

      // DHC CLI: sending while a turn runs hands the message to that turn, the way the desktop app does —
      // Claude reads it before its next step. The explicit "interrupt" action stops the turn instead.
      const midTurnSend = isLoading && !editingAnchorId;
      if (!earlyBubble) {
        addMessage(buildUserMessage(coSenderName, midTurnSend));
      }
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      // DHC CLI: "interrupt" stops the running turn server-side (Codex-style steer). Mark it so the
      // interrupted run's `complete { aborted }` does not drop the indicator for the turn replacing it.
      const interruptActiveRun = midTurnSend && mode?.interrupt === true;
      if (interruptActiveRun) {
        markInterruptSend(targetSessionId);
      }

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      sendMessage({
        // Replacing an already-sent message is its own frame: it changes the
        // shape of the conversation, so it gets validated separately and can
        // report why it was refused.
        type: editingAnchorId ? 'chat.edit-send' : 'chat.send',
        sessionId: targetSessionId,
        ...(editingAnchorId ? { anchorId: editingAnchorId } : {}),
        ...(interruptActiveRun ? { interruptActiveRun: true } : midTurnSend ? { injectIntoActiveRun: true } : {}),
        ...(voice ? { clientRequestId: voice.clientRequestId } : {}),
        content: messageContent,
        options: {
          ...(queuedSubmission?.options ?? buildSendOptions(messageContent)),
          ...(firstSendModel ? { model: firstSendModel } : {}),
          ...(voice ? { appendSystemPrompt: voice.appendSystemPrompt } : {}),
          attachments: uploadedAttachments,
        },
      });
      endEditing();
      if (firstSendModel) {
        void selectSessionModel?.(targetSessionId, firstSendModel);
        setModelAdviceChip({ sessionId: targetSessionId, kind: 'auto', from: currentProviderModel });
      } else if (adviceMode === 'suggest' && advice) {
        const adviceSessionId = targetSessionId;
        void advice.then((answer) => {
          if (answer === 'sonnet') {
            setModelAdviceChip({ sessionId: adviceSessionId, kind: 'suggest', from: currentProviderModel });
          }
        });
      }

      if (voice) return targetSessionId;

      // Recorded under the (possibly just-allocated) session id, so the first
      // message of a new chat lands in the history of the session the user is
      // navigated to. Queued drafts were recorded when they were queued; the
      // consecutive-duplicate check keeps this second call a no-op.
      recordSentMessage(currentInput, targetSessionId);
      setInput('');
      inputValueRef.current = '';
      resetCommandMenuState();
      setAttachedFiles([]);
      setFileErrors(new Map());
      setIsTextareaExpanded(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      if (draftScopeRef.current) {
        writeDraftText(draftScopeRef.current, '');
      }
    },
    [
      selectedSession,
      attachedFiles,
      buildSendOptions,
      currentSessionId,
      editingAnchorId,
      endEditing,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      recordSentMessage,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      sessionKey,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
      pendingPermissionRequests,
      setPendingPermissionRequests,
      nightMode,
      onNightQueueSubmit,
      reportUploadProgress,
      currentProviderModel,
      selectSessionModel,
    ],
  );

  // DHC CLI: a turn with attachments waits for its upload before the box clears, so a second Enter in that
  // window sent the whole turn again and the server rejected the copy as RUN_IN_PROGRESS (9/17 08:40: the same
  // image uploaded twice, 267ms apart). Only an identical repeat is dropped — the upload has no timeout, so
  // refusing every submit while one is pending could lock the composer.
  const turnInFlightRef = useRef<{ content: string; attachments: File[] } | null>(null);
  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      mode?: { queue?: boolean; interrupt?: boolean },
    ) => {
      const turn = {
        content: queuedSubmission?.content ?? inputValueRef.current,
        attachments: queuedSubmission?.attachments ?? attachedFiles,
      };
      const inFlight = turnInFlightRef.current;
      if (inFlight && inFlight.content === turn.content && inFlight.attachments === turn.attachments) {
        event.preventDefault();
        return;
      }
      turnInFlightRef.current = turn;
      try {
        await submitTurn(event, queuedSubmission, mode);
      } finally {
        if (turnInFlightRef.current === turn) turnInFlightRef.current = null;
      }
    },
    [attachedFiles, submitTurn],
  );

  // DHC CLI: the composer's explicit "queue" action — hold the message until the current turn finishes.
  const queueMessage = useCallback(
    (event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) =>
      handleSubmit(event, undefined, { queue: true }),
    [handleSubmit],
  );

  // DHC CLI: the composer's explicit "interrupt" action — stop the running turn and send this as a new one.
  const interruptMessage = useCallback(
    (event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) =>
      handleSubmit(event, undefined, { interrupt: true }),
    [handleSubmit],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // The VPS dispatcher owns sending. While the card is visible, periodically
  // reconcile only its removal so the UI notices when the server claims it.
  useEffect(() => {
    if (!sessionKey || !queuedDraft) {
      return;
    }
    let cancelled = false;
    const reconcile = async () => {
      await hydrateChatDrafts();
      if (!cancelled && !readQueuedMessage(sessionKey)) {
        queuedDraftSessionRef.current = sessionKey;
        setQueuedDraft(null);
      }
    };
    const timer = setInterval(() => void reconcile(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [queuedDraft, sessionKey]);

  const editQueuedDraft = useCallback(() => {
    if (!queuedDraft) {
      return;
    }
    setQueuedDraft(null);
    setInput(queuedDraft.content);
    inputValueRef.current = queuedDraft.content;
    setAttachedFiles(queuedDraft.attachments);
    textareaRef.current?.focus();
  }, [queuedDraft]);

  const deleteQueuedDraft = useCallback(() => {
    setQueuedDraft(null);
  }, []);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // Swap in the open scope's draft, and pick up one that arrives from another
  // device with the hydrated drafts.
  useEffect(() => {
    if (!draftScope) {
      return;
    }

    const restoreDraft = () => {
      const savedInput = readDraftText(draftScope);
      setInputState((previous) => {
        if (previous.scope === draftScope && previous.value === savedInput) {
          return previous;
        }
        inputValueRef.current = savedInput;
        return { scope: draftScope, value: savedInput };
      });
    };

    restoreDraft();
    // The edit target belongs to this scope's draft; another scope starts without one.
    let storedAnchor: string | null = null;
    try {
      storedAnchor = localStorage.getItem(EDIT_ANCHOR_PREFIX + draftScope);
    } catch { /* ignore */ }
    setEditingAnchorId(storedAnchor);
    return subscribeToChatDrafts(restoreDraft);
  }, [draftScope]);

  // Only persist text that was typed for the scope it is about to be written
  // to; see the inputState declaration for why the scope travels with the text.
  useEffect(() => {
    if (!draftScope || inputState.scope !== draftScope) {
      return;
    }
    writeDraftText(draftScope, inputState.value);
  }, [inputState, draftScope]);

  // Persist the queued draft under its session's key. Must be defined BEFORE
  // the swap effect below: on a session switch there is one commit where
  // `sessionKey` already points at the new session while `queuedDraft` (and
  // the owner ref) still describe the old one — the ref mismatch makes this
  // effect skip that commit instead of writing/clearing across sessions.
  useEffect(() => {
    if (!sessionKey || queuedDraftSessionRef.current !== sessionKey) {
      return;
    }
    if (
      queuedDraft
      && (queuedDraft.content.trim() || (queuedDraft.uploadedAttachments?.length ?? 0) > 0)
    ) {
      writeQueuedMessage(sessionKey, {
        content: queuedDraft.content,
        options: queuedDraft.options,
        attachments: queuedDraft.uploadedAttachments,
      });
    } else {
      clearQueuedMessage(sessionKey);
    }
  }, [queuedDraft, sessionKey]);

  // Switching sessions swaps in that session's queued draft. Browser File
  // objects are local to the mounted composer, while their already-uploaded
  // descriptors restore from storage and remain sendable.
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDraft(null);
      return;
    }
    setQueuedDraft(restoreQueuedDraft(sessionKey));
  }, [sessionKey]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (handleHistoryKeyDown(event)) {
        return;
      }

      // Esc backs out of an edit the way the banner's cancel does.
      if (event.key === 'Escape' && editingAnchorId) {
        event.preventDefault();
        endEditing();
        setInput('');
        inputValueRef.current = '';
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      editingAnchorId,
      endEditing,
      setInput,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleHistoryKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
    },
    [],
  );

  /** Loads an already-sent message back into the composer to be replaced. */
  const beginEditMessage = useCallback((message: ChatMessage) => {
    if (!message.transcriptAnchorId) return;
    setEditingAnchorId(message.transcriptAnchorId);
    writeEditAnchor(draftScopeRef.current, message.transcriptAnchorId);
    setInput(message.content || '');
    inputValueRef.current = message.content || '';
    textareaRef.current?.focus();
  }, [setInput]);

  const cancelEditMessage = useCallback(() => {
    endEditing();
    setInput('');
    inputValueRef.current = '';
  }, [setInput]);

  // DHC CLI: send a literal text turn (used for built-in slash commands like /compact) without touching the draft box.
  const submitText = useCallback((text: string) => {
    return handleSubmit(createFakeSubmitEvent(), {
      content: text,
      attachments: [],
      uploadedAttachments: [],
      options: buildSendOptions(text),
    });
  }, [handleSubmit, buildSendOptions]);

  // DHC CLI 語音通話: a spoken turn takes the normal send path (same transcript, same session, injected into a
  // running turn) and resolves to the session it went to. Refused while a sent message is being edited, because
  // that send would replace the edited message instead.
  const sendVoiceTurn = useCallback(async (turn: { text: string; clientRequestId: string; systemNote: string }) => {
    if (editingAnchorId) return null;
    const notes = [buildSendOptions(turn.text).appendSystemPrompt, turn.systemNote].filter(Boolean).join('\n\n');
    // 指揮模式：這句講話期間有圈點就附合成圖，沒有就附有變過的最新電腦畫面。
    const shot = await prepareCommandModeAttachment();
    const sessionId = await submitTurn(createFakeSubmitEvent(), undefined, {
      voice: {
        text: shot ? `${turn.text}\n${shot.note}` : turn.text,
        clientRequestId: turn.clientRequestId,
        appendSystemPrompt: notes,
        ...(shot ? { files: [shot.file] } : {}),
      },
    });
    if (sessionId) commitCommandModeTurn(shot);
    return sessionId ?? null;
  }, [editingAnchorId, buildSendOptions, submitTurn]);

  return {
    input,
    sendVoiceTurn,
    setInput,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
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
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    fileProgress,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    attachFiles: handleAttachmentFiles,
    handleSubmit,
    queueMessage,
    interruptMessage,
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
    modelAdviceChip,
    setModelAdviceChip,
  };
}
