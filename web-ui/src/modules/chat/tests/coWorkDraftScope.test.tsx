import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * Drafts used to be keyed by project, so every session in a project shared one
 * draft and switching sessions carried the previous one's half-typed message
 * across. They are keyed by session now (and by project only for a chat that
 * has not been sent yet), which is what lets a draft be picked up on another
 * device against the session it belongs to.
 *
 * These tests drive the real hook, so the effect ordering that decides which
 * scope a keystroke lands in is exercised rather than described.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

// The composer only ever reaches the network through these; stubbing them keeps
// the test about draft scoping rather than about fetch behaviour in jsdom.
vi.mock('@/shared/coSessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/coSessions')>();
  const shared = { ownerProjectId: 'p-owner', members: ['p-me'], sharedAt: '', title: 't', provider: 'claude' };
  const lookup = (id: string | null | undefined) => (id === 'co-session' ? shared as never : null);
  return { ...actual, readCoSession: lookup, useCoSession: lookup };
});

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

const renderComposer = (selectedSession: ProjectSession | null) => renderHook(
  ({ session }: { session: ProjectSession | null }) => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session,
    currentSessionId: session?.id ?? null,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: () => undefined,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }),
  { initialProps: { session: selectedSession } },
);

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
});

test('a Co-Work session ignores the draft another participant left on the session', async () => {
  writeDraftText('co-session', 'someone else is typing');
  const view = renderComposer({ id: 'co-session' });
  await act(async () => undefined);
  assert.equal(view.result.current.input, '');

  await act(async () => {
    view.result.current.setInput('mine');
  });
  assert.equal(readDraftText('co-session'), 'someone else is typing');
  assert.equal(readDraftText('co-session#shared'), 'mine');
});

test('an ordinary session still keeps its draft under the session id', async () => {
  writeDraftText('solo-session', 'left here');
  const view = renderComposer({ id: 'solo-session' });
  await act(async () => undefined);
  assert.equal(view.result.current.input, 'left here');
});
