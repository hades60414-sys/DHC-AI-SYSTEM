import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * 9/17 08:40: a message with an image reached the server twice — the same file landed in the upload store
 * twice, 267ms apart — and the server rejected the second chat.send as RUN_IN_PROGRESS, which the chat
 * showed as an error. A turn with attachments waits for its upload before the box clears, so a second Enter
 * in that window submitted the whole turn again. These drive the real hook with the upload held open.
 */

const upload = vi.hoisted(() => ({ calls: 0, release: [] as Array<() => void> }));

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
      assets: {
        uploadFiles: () => {
          upload.calls += 1;
          return new Promise((resolve) => {
            upload.release.push(() => resolve({
              ok: true,
              json: async () => ({ attachments: [{ name: 'shot.png', path: '/uploads/shot.png', mimeType: 'image/png' }] }),
            }));
          });
        },
      },
    },
  };
});

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-1' };

type Sent = { type: string; content?: string };

const renderComposer = (sent: Sent[]) => renderHook(() => useChatComposerState({
  selectedProject: PROJECT,
  selectedSession: SESSION,
  currentSessionId: SESSION.id,
  provider: 'claude',
  permissionMode: 'default',
  cyclePermissionMode: () => undefined,
  resolvePermissionModeForProvider: () => 'default' as PermissionMode,
  currentProviderModel: 'test-model',
  currentProviderEffort: 'medium',
  isLoading: false,
  canAbortSession: false,
  tokenBudget: null,
  sendMessage: (message) => {
    sent.push(message as Sent);
  },
  scrollToBottom: () => undefined,
  addMessage: () => undefined,
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
}));

const ENTER = { preventDefault: () => undefined } as never;
const chatSends = (sent: Sent[]) => sent.filter((message) => message.type === 'chat.send').map((message) => message.content);

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  upload.calls = 0;
  upload.release = [];
});

test('a second Enter while the attachment uploads does not send the turn again', async () => {
  const sent: Sent[] = [];
  const view = renderComposer(sent);
  await act(async () => {
    view.result.current.setInput('是這樣打嗎？');
    view.result.current.setAttachedFiles([new File(['png'], 'shot.png', { type: 'image/png' })]);
  });

  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  await act(async () => {
    first = view.result.current.handleSubmit(ENTER);
  });
  await act(async () => {
    second = view.result.current.handleSubmit(ENTER);
  });
  assert.equal(upload.calls, 1, 'the repeat must not upload the image again');

  await act(async () => {
    upload.release.forEach((release) => release());
    await first;
    await second;
  });
  assert.deepEqual(chatSends(sent), ['是這樣打嗎？']);
});

test('a different message is not held back by an upload still in flight', async () => {
  const sent: Sent[] = [];
  const view = renderComposer(sent);
  await act(async () => {
    view.result.current.setInput('是這樣打嗎？');
    view.result.current.setAttachedFiles([new File(['png'], 'shot.png', { type: 'image/png' })]);
  });

  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  await act(async () => {
    first = view.result.current.handleSubmit(ENTER);
  });
  await act(async () => {
    view.result.current.setInput('算了，改問別的');
  });
  await act(async () => {
    second = view.result.current.handleSubmit(ENTER);
  });
  assert.equal(upload.calls, 2, 'an edited message is a new turn, even while the first upload hangs');

  await act(async () => {
    upload.release.forEach((release) => release());
    await first;
    await second;
  });
  assert.deepEqual([...chatSends(sent)].sort(), ['是這樣打嗎？', '算了，改問別的'].sort());
});
