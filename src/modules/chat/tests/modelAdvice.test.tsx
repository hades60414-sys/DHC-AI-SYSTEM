import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import ModelAdviceChip from '@/modules/chat/composer/ModelAdviceChip';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetInterruptSends } from '@/modules/chat/utils/interruptSends';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * DHC CLI 10/24 開對話建議模型: 'auto' (the default since 10/31) waits for the advice and sends a new chat's first
 * message with Sonnet when it is enough. Existing chats, other models and 'off' never ask.
 */

const advice = vi.hoisted(() => ({ calls: [] as unknown[], answer: Promise.resolve('sonnet') as Promise<string> }));

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
      providers: {
        createSession: () => okJson({ success: true, data: { sessionId: 'new-1', sessionName: '新對話' } }),
        modelAdvice: (body: unknown) => {
          advice.calls.push(body);
          return advice.answer.then((answer) => ({ ok: true, json: async () => ({ advice: answer }) }));
        },
      },
    },
  };
});

const FOLDER: Project = { projectId: 'project-1', displayName: '同事D', fullPath: 'C:\\Users\\demo\\DHC Workspace\\同事D' };

type Sent = Record<string, unknown> & { type: string; options?: Record<string, unknown> };

const renderComposer = (sent: Sent[], picked: string[], { model = 'opus[1m]', session = null as ProjectSession | null } = {}) =>
  renderHook(() => useChatComposerState({
    selectedProject: FOLDER,
    selectedSession: session,
    currentSessionId: session?.id ?? null,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: model,
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: (message) => { sent.push(message as Sent); },
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
    selectSessionModel: (sessionId, picked2) => { picked.push(`${sessionId}:${picked2}`); },
  }));

const ENTER = { preventDefault: () => undefined } as never;

const send = async (view: ReturnType<typeof renderComposer>, text: string) => {
  await act(async () => { view.result.current.setInput(text); });
  await act(async () => { await view.result.current.handleSubmit(ENTER); });
};

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  resetInterruptSends();
  advice.calls = [];
  advice.answer = Promise.resolve('sonnet');
});

test('no setting or an old suggest setting switches by itself', async () => {
  for (const stored of [null, 'suggest']) {
    localStorage.clear();
    if (stored) localStorage.setItem('dhc.modelAdvice', stored);
    const sent: Sent[] = [];
    await send(renderComposer(sent, []), '可轉債擔保比例是什麼');
    assert.equal(sent.find((message) => message.type === 'chat.send')?.options?.model, 'sonnet');
  }
});

test('auto: a sonnet advice sends the first message with Sonnet and records it for this session only', async () => {
  localStorage.setItem('dhc.modelAdvice', 'auto');
  const sent: Sent[] = [];
  const picked: string[] = [];
  const view = renderComposer(sent, picked);
  await send(view, '可轉債擔保比例是什麼');

  const sends = sent.filter((message) => message.type === 'chat.send');
  assert.equal(sends[0].options?.model, 'sonnet');
  assert.deepEqual(picked, ['new-1:sonnet']);
  assert.deepEqual(view.result.current.modelAdviceChip, { sessionId: 'new-1', kind: 'auto', from: 'opus[1m]' });
});

test('auto: an opus advice keeps the picked model and shows no chip', async () => {
  localStorage.setItem('dhc.modelAdvice', 'auto');
  advice.answer = Promise.resolve('opus');
  const sent: Sent[] = [];
  const view = renderComposer(sent, []);
  await send(view, '上週權證損益多少');
  assert.equal(sent.find((message) => message.type === 'chat.send')?.options?.model, 'opus[1m]');
  assert.equal(view.result.current.modelAdviceChip, null);
});

test('an existing chat, a Sonnet pick or mode off never asks', async () => {
  const cases: Array<[Parameters<typeof renderComposer>[2], string | null]> = [
    [{ session: { id: 'old-1' } }, null],
    [{ model: 'sonnet' }, null],
    [{}, 'off'],
  ];
  for (const [options, mode] of cases) {
    localStorage.clear();
    if (mode) localStorage.setItem('dhc.modelAdvice', mode);
    const sent: Sent[] = [];
    await send(renderComposer(sent, [], options), '嗨');
    assert.equal(sent.filter((message) => message.type === 'chat.send').length, 1);
  }
  assert.equal(advice.calls.length, 0);
});

test('the chip says what it will do and its two buttons switch or close', () => {
  const onSwitch = vi.fn();
  const onDismiss = vi.fn();
  const view = render(<ModelAdviceChip chip={{ sessionId: 's', kind: 'auto', from: 'opus[1m]' }} onSwitch={onSwitch} onDismiss={onDismiss} />);
  fireEvent.click(view.getByText('這題改用 Sonnet 回答 · 改回 Opus'));
  fireEvent.click(view.getByLabelText('關閉'));
  assert.equal(onSwitch.mock.calls.length, 1);
  assert.equal(onDismiss.mock.calls.length, 1);
});
