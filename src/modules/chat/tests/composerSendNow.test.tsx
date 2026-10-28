import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { consumeInterruptSend, resetInterruptSends } from '@/modules/chat/utils/interruptSends';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PendingPermissionRequest, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * DHC CLI 9/17: while a turn was running, Enter only queued the reply and the queue waited for the run
 * to end — which never happened when the assistant was itself waiting on the user (a question). People
 * had to stop the session by hand, and the queued reply still sat there. Now, Codex-style:
 *  - Enter while a turn runs sends at once and asks the server to interrupt that turn;
 *  - queueing is the explicit secondary action;
 *  - while an AskUserQuestion prompt is open, the typed text answers it (no "Other..." dance).
 */

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
    },
  };
});

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-1' };

type Sent = Record<string, unknown> & { type: string };

const renderComposer = (
  sent: Sent[],
  overrides: { isLoading?: boolean; pendingPermissionRequests?: PendingPermissionRequest[] } = {},
) => renderHook(() => useChatComposerState({
  selectedProject: PROJECT,
  selectedSession: SESSION,
  currentSessionId: SESSION.id,
  provider: 'claude',
  permissionMode: 'default',
  cyclePermissionMode: () => undefined,
  resolvePermissionModeForProvider: () => 'default' as PermissionMode,
  currentProviderModel: 'test-model',
  currentProviderEffort: 'medium',
  isLoading: overrides.isLoading ?? false,
  canAbortSession: overrides.isLoading ?? false,
  tokenBudget: null,
  sendMessage: (message) => {
    sent.push(message as Sent);
  },
  scrollToBottom: () => undefined,
  addMessage: () => undefined,
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
  pendingPermissionRequests: overrides.pendingPermissionRequests ?? [],
}));

const ENTER = { preventDefault: () => undefined } as never;

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  resetInterruptSends();
});

test('Enter while a turn runs sends now and asks the server to interrupt that turn', async () => {
  const sent: Sent[] = [];
  const view = renderComposer(sent, { isLoading: true });
  await act(async () => {
    view.result.current.setInput('先停，改用另一個做法');
  });
  await act(async () => {
    await view.result.current.handleSubmit(ENTER);
  });

  const sends = sent.filter((message) => message.type === 'chat.send');
  assert.equal(sends.length, 1, 'the reply goes out immediately instead of being queued');
  assert.equal(sends[0].content, '先停，改用另一個做法');
  assert.equal(sends[0].interruptActiveRun, true);
  assert.equal(view.result.current.queuedDraft, null);
  assert.equal(view.result.current.input, '');
  assert.equal(consumeInterruptSend(SESSION.id), true, 'the interrupted run\'s aborted complete is expected');
});

test('Enter while idle is a plain send without the interrupt flag', async () => {
  const sent: Sent[] = [];
  const view = renderComposer(sent, { isLoading: false });
  await act(async () => {
    view.result.current.setInput('平常的訊息');
  });
  await act(async () => {
    await view.result.current.handleSubmit(ENTER);
  });

  const sends = sent.filter((message) => message.type === 'chat.send');
  assert.equal(sends.length, 1);
  assert.equal('interruptActiveRun' in sends[0], false);
  assert.equal(consumeInterruptSend(SESSION.id), false);
});

test('the queue action holds the message for after the turn instead of sending it', async () => {
  const sent: Sent[] = [];
  const view = renderComposer(sent, { isLoading: true });
  await act(async () => {
    view.result.current.setInput('做完之後再幫我整理成表');
  });
  await act(async () => {
    await view.result.current.queueMessage(ENTER);
  });

  assert.equal(sent.filter((message) => message.type === 'chat.send').length, 0);
  assert.equal(view.result.current.queuedDraft?.content, '做完之後再幫我整理成表');
  assert.equal(view.result.current.input, '');
});

test('typed text answers an open AskUserQuestion prompt instead of starting a new turn', async () => {
  const sent: Sent[] = [];
  const request: PendingPermissionRequest = {
    requestId: 'req-1',
    toolName: 'AskUserQuestion',
    input: {
      questions: [
        { question: '要存哪裡？', header: '存放', multiSelect: false, options: [{ label: '新表', description: '' }] },
      ],
    },
    sessionId: SESSION.id,
  };
  const view = renderComposer(sent, { isLoading: true, pendingPermissionRequests: [request] });
  await act(async () => {
    view.result.current.setInput('先不要建表，寫進既有的 log 表就好');
  });
  await act(async () => {
    await view.result.current.handleSubmit(ENTER);
  });

  assert.equal(sent.filter((message) => message.type === 'chat.send').length, 0, 'no new turn is started');
  const answers = sent.filter((message) => message.type === 'chat.permission-response');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].requestId, 'req-1');
  assert.equal(answers[0].allow, true);
  assert.deepEqual(
    (answers[0].updatedInput as { answers: Record<string, string> }).answers,
    { '要存哪裡？': '先不要建表，寫進既有的 log 表就好' },
  );
  assert.equal(view.result.current.input, '');
  assert.equal(view.result.current.queuedDraft, null);
});
