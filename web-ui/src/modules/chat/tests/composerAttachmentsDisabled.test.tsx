import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project } from '@/shared/types';

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
    },
  };
});

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };

const renderComposer = (attachmentsEnabled: boolean) => renderHook(() => useChatComposerState({
  selectedProject: PROJECT,
  selectedSession: { id: 'session-1' },
  currentSessionId: 'session-1',
  provider: 'agy',
  permissionMode: 'default',
  cyclePermissionMode: () => undefined,
  resolvePermissionModeForProvider: () => 'default' as PermissionMode,
  currentProviderModel: 'test-model',
  currentProviderEffort: 'medium',
  isLoading: false,
  canAbortSession: false,
  tokenBudget: null,
  sendMessage: () => undefined,
  attachmentsEnabled,
  scrollToBottom: () => undefined,
  addMessage: () => undefined,
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
}));

const pasteImage = () => {
  const file = new File(['x'], 'shot.png', { type: 'image/png' });
  return { clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }], files: [file], getData: () => '' }, preventDefault: () => undefined } as never;
};

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
});

test('a provider that receives no files gets no attachments from paste', async () => {
  const view = renderComposer(false);
  await act(async () => { view.result.current.handlePaste(pasteImage()); });
  assert.equal(view.result.current.attachedFiles.length, 0);
});

test('with attachments enabled the same paste attaches the image', async () => {
  const view = renderComposer(true);
  await act(async () => { view.result.current.handlePaste(pasteImage()); });
  assert.equal(view.result.current.attachedFiles.length, 1);
});
