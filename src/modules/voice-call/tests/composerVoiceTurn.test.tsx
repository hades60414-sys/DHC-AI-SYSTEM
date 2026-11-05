import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetInterruptSends } from '@/modules/chat/utils/interruptSends';
import { VOICE_SYSTEM_NOTE } from '@/modules/voice-call/config';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, PendingPermissionRequest, PermissionMode, Project, ProjectSession } from '@/shared/types';

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      assets: { uploadFiles: () => okJson({ attachments: [] }) },
      providers: { createSession: () => okJson({ data: { sessionId: 'new-session' } }) },
    },
  };
});

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };
type Sent = Record<string, unknown> & { type: string; options?: Record<string, unknown> };

const renderComposer = (
  sent: Sent[],
  added: ChatMessage[],
  overrides: { isLoading?: boolean; pendingPermissionRequests?: PendingPermissionRequest[]; newChat?: boolean } = {},
) => renderHook(() => useChatComposerState({
  selectedProject: PROJECT,
  selectedSession: overrides.newChat ? null : SESSION,
  currentSessionId: overrides.newChat ? null : SESSION.id,
  provider: 'claude',
  permissionMode: 'default',
  cyclePermissionMode: () => undefined,
  resolvePermissionModeForProvider: () => 'default' as PermissionMode,
  currentProviderModel: 'test-model',
  currentProviderEffort: 'medium',
  isLoading: overrides.isLoading ?? false,
  canAbortSession: overrides.isLoading ?? false,
  tokenBudget: null,
  sendMessage: (message) => { sent.push(message as Sent); },
  scrollToBottom: () => undefined,
  addMessage: (message: ChatMessage) => { added.push(message); },
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
  pendingPermissionRequests: overrides.pendingPermissionRequests ?? [],
}));

const VOICE = { text: '幫我查昨天的部位', clientRequestId: 'voice-1', systemNote: VOICE_SYSTEM_NOTE };

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  resetInterruptSends();
});

test('a spoken turn goes out as a normal chat.send with its id and the voice note, and leaves the typed draft alone', async () => {
  const sent: Sent[] = [];
  const added: ChatMessage[] = [];
  const view = renderComposer(sent, added);
  await act(async () => { view.result.current.setInput('還在打的草稿'); });
  let sessionId: string | null = null;
  await act(async () => { sessionId = await view.result.current.sendVoiceTurn(VOICE); });

  const sends = sent.filter((m) => m.type === 'chat.send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].content, '幫我查昨天的部位');
  assert.equal(sends[0].clientRequestId, 'voice-1');
  assert.equal(sends[0].options?.appendSystemPrompt, VOICE_SYSTEM_NOTE);
  assert.equal(sessionId, 'session-1');
  assert.equal(view.result.current.input, '還在打的草稿');
  assert.equal(added.filter((m) => m.type === 'user').map((m) => m.content).join(), '幫我查昨天的部位', 'the transcript shows the spoken turn');
});

test('a spoken turn in a new chat keeps the typed draft too', async () => {
  const sent: Sent[] = [];
  const view = renderComposer(sent, [], { newChat: true });
  await act(async () => { view.result.current.setInput('還在打的草稿'); });
  let sessionId: string | null = null;
  await act(async () => { sessionId = await view.result.current.sendVoiceTurn(VOICE); });
  assert.equal(sessionId, 'new-session');
  assert.equal(view.result.current.input, '還在打的草稿');
});

test('while a turn runs, a spoken turn joins it instead of stopping it', async () => {
  const sent: Sent[] = [];
  const view = renderComposer(sent, [], { isLoading: true });
  await act(async () => { await view.result.current.sendVoiceTurn(VOICE); });
  const send = sent.find((m) => m.type === 'chat.send');
  assert.equal(send?.injectIntoActiveRun, true);
  assert.equal(send && 'interruptActiveRun' in send, false);
});

test('a spoken turn never answers an open AskUserQuestion prompt', async () => {
  const sent: Sent[] = [];
  const question: PendingPermissionRequest = {
    requestId: 'q1',
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: '要刪除嗎？' }] },
    sessionId: SESSION.id,
    receivedAt: new Date(),
  } as PendingPermissionRequest;
  const view = renderComposer(sent, [], { isLoading: true, pendingPermissionRequests: [question] });
  await act(async () => { await view.result.current.sendVoiceTurn({ ...VOICE, text: '要' }); });
  assert.equal(sent.some((m) => m.type === 'chat.permission-response'), false);
  assert.equal(sent.filter((m) => m.type === 'chat.send').length, 1);
});
