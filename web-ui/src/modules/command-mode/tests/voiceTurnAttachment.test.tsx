import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetInterruptSends } from '@/modules/chat/utils/interruptSends';
import { commandModeStore } from '@/modules/command-mode/store';
import { classifyStroke } from '@/modules/command-mode/strokes';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project, ProjectSession } from '@/shared/types';

const uploads: File[][] = [];

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
        uploadFiles: (form: FormData) => {
          const files = form.getAll('files') as File[];
          uploads.push(files);
          return okJson({ attachments: files.map((f) => ({ name: f.name, path: `C:/assets/${f.name}`, mimeType: f.type })) });
        },
      },
    },
  };
});

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };
type Sent = Record<string, unknown> & { type: string; content?: string; options?: Record<string, unknown> };

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
  sendMessage: (message) => { sent.push(message as Sent); },
  scrollToBottom: () => undefined,
  addMessage: (_message: ChatMessage) => undefined,
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
  pendingPermissionRequests: [],
}));

const FRAME = { id: 'f1', capturedAt: 0, width: 4, height: 3, dataUrl: 'data:image/jpeg;base64,/9j/AAAA' };
const VOICE = { text: '這是測試，回覆收到就好', clientRequestId: 'voice-1', systemNote: '' };

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  resetInterruptSends();
  commandModeStore.reset();
  uploads.length = 0;
  globalThis.fetch = (async (url: string) => ({ blob: async () => new Blob([url.slice(0, 8)], { type: 'image/jpeg' }) })) as unknown as typeof fetch;
});

test('during a call with the desktop shared, a spoken turn carries the screen as an image attachment plus a note, once', async () => {
  commandModeStore.setCallLive(true);
  commandModeStore.receiveFrame(FRAME);
  const sent: Sent[] = [];
  const view = renderComposer(sent);
  await act(async () => { await view.result.current.sendVoiceTurn(VOICE); });

  const send = sent.find((m) => m.type === 'chat.send');
  assert.equal(uploads.length, 1, 'the screenshot goes through the normal attachment upload');
  assert.match(uploads[0][0].name, /^指揮模式-.*\.jpg$/);
  assert.match(send?.content ?? '', /^這是測試，回覆收到就好\n〔指揮模式：附上目前的電腦畫面/);
  assert.equal((send?.options?.attachments as unknown[]).length, 1);

  await act(async () => { await view.result.current.sendVoiceTurn({ ...VOICE, clientRequestId: 'voice-2' }); });
  const second = sent.filter((m) => m.type === 'chat.send')[1];
  assert.equal(second?.content, VOICE.text, 'unchanged screen is not attached again');
  assert.equal(uploads.length, 1);
});

test('without a live call the spoken turn is sent exactly as before', async () => {
  commandModeStore.receiveFrame(FRAME);
  commandModeStore.addStroke({ id: 's', source: 'phone', frame: FRAME, startedAt: 1, endedAt: 2, shape: classifyStroke([]), points: [{ x: 0.5, y: 0.5, t: 1 }] });
  const sent: Sent[] = [];
  const view = renderComposer(sent);
  await act(async () => { await view.result.current.sendVoiceTurn(VOICE); });
  assert.equal(sent.find((m) => m.type === 'chat.send')?.content, VOICE.text);
  assert.equal(uploads.length, 0);
});
