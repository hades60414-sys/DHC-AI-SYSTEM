import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetInterruptSends } from '@/modules/chat/utils/interruptSends';
import { resetChatDrafts } from '@/shared/chatDrafts';
import { DISTILL_SYSTEM_NOTE } from '@/shared/distillSessions';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * DHC CLI 10/06 蒸餾模式: with the flask on, every turn's chat.send options carry the note as
 * `appendSystemPrompt`, which the server hands to the Claude runtime as the system-prompt append. The user's
 * message itself stays as typed. A queued message keeps the note it was composed under.
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

type Sent = Record<string, unknown> & { type: string; options?: Record<string, unknown> };

const renderComposer = (sent: Sent[], distillMode: boolean, isLoading = false) => renderHook(() => useChatComposerState({
  selectedProject: PROJECT,
  selectedSession: SESSION,
  currentSessionId: SESSION.id,
  provider: 'claude',
  permissionMode: 'default',
  cyclePermissionMode: () => undefined,
  resolvePermissionModeForProvider: () => 'default' as PermissionMode,
  currentProviderModel: 'test-model',
  currentProviderEffort: 'medium',
  isLoading,
  canAbortSession: isLoading,
  tokenBudget: null,
  sendMessage: (message) => {
    sent.push(message as Sent);
  },
  scrollToBottom: () => undefined,
  addMessage: () => undefined,
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
  distillMode,
}));

const ENTER = { preventDefault: () => undefined } as never;

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  resetInterruptSends();
});

const sendOne = async (distillMode: boolean): Promise<Sent> => {
  const sent: Sent[] = [];
  const view = renderComposer(sent, distillMode);
  await act(async () => {
    view.result.current.setInput('風管說 T0 損益要是 0');
  });
  await act(async () => {
    await view.result.current.handleSubmit(ENTER);
  });
  const sends = sent.filter((message) => message.type === 'chat.send');
  assert.equal(sends.length, 1);
  return sends[0];
};

test('with the flask on, the turn carries the note as the system-prompt append and the text stays as typed', async () => {
  const send = await sendOne(true);
  assert.equal(send.options?.appendSystemPrompt, DISTILL_SYSTEM_NOTE);
  assert.equal(send.content, '風管說 T0 損益要是 0');
});

test('with the flask off, nothing is appended', async () => {
  const send = await sendOne(false);
  assert.equal(send.options && 'appendSystemPrompt' in send.options, false);
});

test('a message queued with the flask on keeps the note for when it is sent', async () => {
  const sent: Sent[] = [];
  const view = renderComposer(sent, true, true);
  await act(async () => {
    view.result.current.setInput('做完之後再整理成表');
  });
  await act(async () => {
    await view.result.current.queueMessage(ENTER);
  });
  assert.equal(view.result.current.queuedDraft?.options?.appendSystemPrompt, DISTILL_SYSTEM_NOTE);
});
