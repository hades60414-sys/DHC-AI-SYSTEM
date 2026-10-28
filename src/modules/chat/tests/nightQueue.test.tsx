import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { NightQueuePanel } from '@/modules/chat/composer/NightQueuePanel';
import { useNightQueue } from '@/modules/chat/composer/useNightQueue';
import type { NightQueueControls, NightQueueStoreResult } from '@/modules/chat/composer/useNightQueue';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { formatStartAt, nextOccurrence, parseStartAnnotation } from '@/modules/chat/utils/nightQueueTime';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { NightQueueSettings, NightQueueState, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * DHC CLI 9/24: night mode. The moon turns it on (asking first about bypass when the chat is not in bypass
 * mode); a prompt is then stored on the server instead of sent, and the server runs stored prompts one at a
 * time from 02:00 — or from the time a prompt names at its start ("@12:05", "@重置"). Pressing the moon again
 * while prompts wait asks "run now / cancel all / back".
 */

const nightApi = vi.hoisted(() => ({
  get: vi.fn(),
  setEnabled: vi.fn(),
  enqueue: vi.fn(),
  runNow: vi.fn(),
  cancelAll: vi.fn(),
  cancel: vi.fn(),
}));
const createSession = vi.hoisted(() => vi.fn());

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    // The quota-reset lookup (GET /api/dhc/usage) goes through the global fetch that stubUsage replaces.
    authenticatedFetch: (url: string, init?: RequestInit) => fetch(url, init),
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
      providers: { createSession },
      nightQueue: nightApi,
    },
  };
});

const jsonResponse = (body: unknown, ok = true, status = ok ? 200 : 400) => {
  const response = { ok, status, json: async () => body, clone: () => response };
  return response;
};
const respond = (data: unknown, ok = true, status = ok ? 200 : 400) =>
  Promise.resolve(jsonResponse({ success: ok, data }, ok, status));
const refuse = (status: number, message: string) =>
  Promise.resolve(jsonResponse({ success: false, error: { code: 'X', message } }, false, status));

const NIGHT: NightQueueSettings = { startAt: null, useBypass: true };

const state = (sessionId: string, mode: NightQueueSettings | null, pending = 0): NightQueueState => ({
  sessionId,
  enabled: mode !== null,
  mode,
  items: Array.from({ length: pending }, (_, index) => ({
    id: `item-${index}`,
    sessionId,
    content: `prompt ${index}`,
    attachmentCount: 0,
    status: 'pending' as const,
    runNow: false,
    position: index + 1,
    failureReason: null,
    startAt: null,
    useBypass: mode?.useBypass ?? false,
    createdAt: '2026-09-24 10:00:00',
  })),
});

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-1' };

type Sent = Record<string, unknown> & { type: string };
type Stored = { sessionId: string; content: string; options: Record<string, unknown>; startAt: string | null };
type Store = (
  sessionId: string,
  content: string,
  options: Record<string, unknown>,
  startAt?: string | null,
) => Promise<NightQueueStoreResult>;

const ENTER = { preventDefault: () => undefined } as never;

const storeInto = (stored: Stored[]): Store => async (sessionId, content, options, startAt = null) => {
  stored.push({ sessionId, content, options, startAt });
  return { ok: true };
};

const renderComposer = (
  sent: Sent[],
  options: {
    session?: ProjectSession | null;
    isLoading?: boolean;
    nightMode?: boolean;
    store?: Store;
    onSessionEstablished?: (sessionId: string) => void;
    errors?: string[];
  } = {},
) => {
  const session = options.session === undefined ? SESSION : options.session;
  return renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session,
    currentSessionId: session?.id ?? null,
    provider: 'claude',
    permissionMode: 'bypassPermissions',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'bypassPermissions' as PermissionMode,
    currentProviderModel: 'opus',
    currentProviderEffort: 'high',
    isLoading: options.isLoading ?? false,
    canAbortSession: options.isLoading ?? false,
    tokenBudget: null,
    sendMessage: (message) => {
      sent.push(message as Sent);
    },
    nightMode: options.nightMode ?? true,
    onNightQueueSubmit: options.store,
    onSessionEstablished: options.onSessionEstablished,
    scrollToBottom: () => undefined,
    addMessage: (message) => {
      if (message.type === 'error') options.errors?.push(String(message.content));
    },
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
    pendingPermissionRequests: [],
  }));
};

const typeAndSubmit = async (view: ReturnType<typeof renderComposer>, text: string) => {
  await act(async () => {
    view.result.current.setInput(text);
  });
  await act(async () => {
    await view.result.current.handleSubmit(ENTER);
  });
};

const stubUsage = (resetsAt: Date | null) => {
  vi.stubGlobal('fetch', vi.fn(async () => (resetsAt
    ? { ok: true, json: async () => ({ session: { resets_at: resetsAt.toISOString() } }) }
    : { ok: false, json: async () => ({}) })));
};

const panelControls = (overrides: Partial<NightQueueControls> = {}): NightQueueControls => ({
  enabled: false,
  mode: null,
  items: [],
  pendingCount: 0,
  isAskingBypass: false,
  isConfirming: false,
  notice: null,
  onToggle: () => undefined,
  onAnswerBypass: () => undefined,
  onCancelBypass: () => undefined,
  onRunNow: () => undefined,
  onCancelAll: () => undefined,
  onCloseConfirm: () => undefined,
  onCancelItem: () => undefined,
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  Object.values(nightApi).forEach((mock) => mock.mockReset());
  createSession.mockReset();
  nightApi.get.mockImplementation((sessionId: string) => respond(state(sessionId, null)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('in night mode Enter stores the prompt, with its settings, instead of sending it', async () => {
  const sent: Sent[] = [];
  const stored: Stored[] = [];
  const view = renderComposer(sent, { store: storeInto(stored) });

  await typeAndSubmit(view, '把月報的檢核腳本重構一下');

  assert.equal(sent.filter((message) => message.type === 'chat.send').length, 0);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].sessionId, SESSION.id);
  assert.equal(stored[0].content, '把月報的檢核腳本重構一下');
  assert.equal(stored[0].startAt, null, 'no time of its own: the 02:00 default');
  assert.equal(stored[0].options.model, 'opus');
  assert.equal(stored[0].options.permissionMode, 'bypassPermissions');
  assert.deepEqual(stored[0].options.attachments, []);
  assert.equal(view.result.current.input, '');
});

test('"@12:05" at the start gives the prompt its own time and is not part of what is stored', async () => {
  const stored: Stored[] = [];
  const view = renderComposer([], { store: storeInto(stored) });

  await typeAndSubmit(view, '@12:05 跑一次月報回測');

  assert.equal(stored.length, 1);
  assert.equal(stored[0].content, '跑一次月報回測');
  assert.equal(stored[0].startAt, nextOccurrence('12:05')?.toISOString());
});

test('"@重置" starts the prompt a minute after the 5-hour quota resets', async () => {
  const resetsAt = new Date(Date.now() + 2 * 3_600_000);
  stubUsage(resetsAt);
  const stored: Stored[] = [];
  const view = renderComposer([], { store: storeInto(stored) });

  await typeAndSubmit(view, '＠重置 繼續昨天的重構');

  assert.equal(stored[0].content, '繼續昨天的重構');
  assert.equal(stored[0].startAt, new Date(resetsAt.getTime() + 60_000).toISOString());
});

test('a time that cannot be read, or a reset time that is unknown, stops the store and says so', async () => {
  const errors: string[] = [];
  const stored: Stored[] = [];
  const view = renderComposer([], { store: storeInto(stored), errors });

  await typeAndSubmit(view, '@25:00 半夜跑');
  assert.equal(stored.length, 0);
  assert.match(errors[0], /看不懂/);
  assert.equal(view.result.current.input, '@25:00 半夜跑', 'kept for the user to fix');

  stubUsage(null);
  await typeAndSubmit(view, '@重置 跑');
  assert.equal(stored.length, 0);
  assert.match(errors[1], /讀不到額度重置時間/);

  await typeAndSubmit(view, '@12:05');
  assert.equal(stored.length, 0);
  assert.match(errors[2], /只有時間沒有內容/);
});

test('a file mention at the start is not a time, and without night mode "@12:05" is just text', async () => {
  const stored: Stored[] = [];
  const nightView = renderComposer([], { store: storeInto(stored) });
  await typeAndSubmit(nightView, '@README.md 整理一下');
  assert.deepEqual(stored.map((entry) => [entry.content, entry.startAt]), [['@README.md 整理一下', null]]);

  const sent: Sent[] = [];
  const dayView = renderComposer(sent, { nightMode: false, store: storeInto(stored) });
  await typeAndSubmit(dayView, '@12:05 現在就跑');
  assert.deepEqual(sent.filter((message) => message.type === 'chat.send').map((message) => message.content), ['@12:05 現在就跑']);
  assert.equal(stored.length, 1);
});

test('in night mode Enter stores the prompt even while a turn is running, instead of interrupting it', async () => {
  const sent: Sent[] = [];
  const stored: Stored[] = [];
  const view = renderComposer(sent, { isLoading: true, store: storeInto(stored) });

  await typeAndSubmit(view, '晚上再跑回測');

  assert.equal(sent.length, 0, 'nothing is sent and the running turn is not interrupted');
  assert.deepEqual(stored.map((entry) => entry.content), ['晚上再跑回測']);
});

test('a prompt that could not be stored stays in the box with a plain-language notice', async () => {
  const sent: Sent[] = [];
  const errors: string[] = [];
  const view = renderComposer(sent, { store: async () => ({ ok: false, message: null }), errors });

  await typeAndSubmit(view, '存不進去的那則');

  assert.equal(sent.length, 0);
  assert.equal(view.result.current.input, '存不進去的那則');
  assert.deepEqual(errors, ['這則沒有存進夜間排程（連線問題），請再送一次。']);
});

test('when the server refuses a prompt, its reason is what the user reads', async () => {
  const errors: string[] = [];
  const view = renderComposer([], {
    store: async () => ({ ok: false, message: '開跑時間已經過了，請重新寫一次。' }),
    errors,
  });

  await typeAndSubmit(view, '午餐時跑');

  assert.deepEqual(errors, ['這則沒有存進夜間排程：開跑時間已經過了，請重新寫一次。']);
});

test('a new chat in night mode creates its session and stores the first prompt there', async () => {
  createSession.mockImplementation(() => respond({ sessionId: 'new-session', sessionName: '新對話' }));
  const sent: Sent[] = [];
  const stored: Stored[] = [];
  const established: string[] = [];
  const view = renderComposer(sent, {
    session: null,
    store: storeInto(stored),
    onSessionEstablished: (sessionId) => established.push(sessionId),
  });

  await typeAndSubmit(view, '@12:05 新專案：先把資料夾結構建好');

  assert.equal(createSession.mock.calls.length, 1);
  assert.equal(createSession.mock.calls[0][0].initialMessage, '新專案：先把資料夾結構建好', 'named without the time');
  assert.deepEqual(established, ['new-session']);
  assert.deepEqual(stored.map((entry) => [entry.sessionId, entry.content]), [
    ['new-session', '新專案：先把資料夾結構建好'],
  ]);
  assert.equal(sent.length, 0);
});

test('the eraser\'s /compact still runs at once in night mode', async () => {
  const sent: Sent[] = [];
  const stored: Stored[] = [];
  const view = renderComposer(sent, { store: storeInto(stored) });

  await act(async () => {
    await view.result.current.submitText('/compact');
  });

  assert.equal(stored.length, 0);
  assert.deepEqual(sent.filter((message) => message.type === 'chat.send').map((message) => message.content), ['/compact']);
});

test('in a chat already in bypass mode the moon turns night mode on at once, with bypass', async () => {
  nightApi.setEnabled.mockImplementation((sessionId: string, enabled: boolean, settings?: NightQueueSettings) =>
    respond(state(sessionId, enabled ? settings ?? NIGHT : null)));
  const view = renderHook(() => useNightQueue('session-1', 'project:project-1', 'bypassPermissions'));
  await act(async () => {});

  await act(async () => {
    view.result.current.controls.onToggle();
  });
  assert.equal(view.result.current.controls.isAskingBypass, false);
  assert.deepEqual(nightApi.setEnabled.mock.calls, [['session-1', true, { startAt: null, useBypass: true }]]);
  assert.equal(view.result.current.controls.enabled, true);
});

test('in another mode the moon asks about bypass first, and the answer decides it', async () => {
  nightApi.setEnabled.mockImplementation((sessionId: string, enabled: boolean, settings?: NightQueueSettings) =>
    respond(state(sessionId, enabled ? settings ?? NIGHT : null)));
  const view = renderHook(() => useNightQueue('session-1', 'project:project-1', 'default'));
  await act(async () => {});

  await act(async () => {
    view.result.current.controls.onToggle();
  });
  assert.equal(view.result.current.controls.isAskingBypass, true);
  assert.equal(nightApi.setEnabled.mock.calls.length, 0, 'nothing changes until the user answers');

  await act(async () => {
    view.result.current.controls.onAnswerBypass(false);
  });
  assert.deepEqual(nightApi.setEnabled.mock.calls, [['session-1', true, { startAt: null, useBypass: false }]]);
  assert.equal(view.result.current.controls.isAskingBypass, false);
  assert.deepEqual(view.result.current.controls.mode, { startAt: null, useBypass: false });
});

test('cancelling the bypass question leaves night mode off', async () => {
  const view = renderHook(() => useNightQueue('session-1', 'project:project-1', 'default'));
  await act(async () => {});
  await act(async () => {
    view.result.current.controls.onToggle();
  });
  await act(async () => {
    view.result.current.controls.onCancelBypass();
  });
  assert.equal(view.result.current.controls.isAskingBypass, false);
  assert.equal(view.result.current.controls.enabled, false);
  assert.equal(nightApi.setEnabled.mock.calls.length, 0);
});

test('pressing the moon again while prompts wait asks first; "run now" runs them and closes the question', async () => {
  nightApi.get.mockImplementation((sessionId: string) => respond(state(sessionId, NIGHT, 2)));
  nightApi.runNow.mockImplementation((sessionId: string) => respond({
    ...state(sessionId, null, 2),
    items: state(sessionId, null, 2).items.map((item) => ({ ...item, runNow: true })),
  }));
  const view = renderHook(() => useNightQueue('session-1', 'project:project-1', 'bypassPermissions'));
  await act(async () => {});

  assert.equal(view.result.current.controls.pendingCount, 2);
  await act(async () => {
    view.result.current.controls.onToggle();
  });
  assert.equal(view.result.current.controls.isConfirming, true);
  assert.equal(nightApi.setEnabled.mock.calls.length, 0, 'nothing changes until the user picks');

  await act(async () => {
    view.result.current.controls.onRunNow();
  });
  assert.deepEqual(nightApi.runNow.mock.calls, [['session-1']]);
  assert.equal(view.result.current.controls.isConfirming, false);
  assert.equal(view.result.current.controls.enabled, false);
  assert.equal(view.result.current.controls.items.every((item) => item.runNow), true);
});

test('"cancel all" drops the waiting prompts; "back" changes nothing', async () => {
  nightApi.get.mockImplementation((sessionId: string) => respond(state(sessionId, NIGHT, 1)));
  nightApi.cancelAll.mockImplementation((sessionId: string) => respond(state(sessionId, null)));
  const view = renderHook(() => useNightQueue('session-1', 'project:project-1', 'bypassPermissions'));
  await act(async () => {});

  await act(async () => {
    view.result.current.controls.onToggle();
  });
  await act(async () => {
    view.result.current.controls.onCloseConfirm();
  });
  assert.equal(view.result.current.controls.isConfirming, false);
  assert.equal(view.result.current.controls.enabled, true);

  await act(async () => {
    view.result.current.controls.onToggle();
  });
  await act(async () => {
    view.result.current.controls.onCancelAll();
  });
  assert.deepEqual(nightApi.cancelAll.mock.calls, [['session-1']]);
  assert.equal(view.result.current.controls.enabled, false);
  assert.deepEqual(view.result.current.controls.items, []);
});

test('turning off when the server knows of waiting prompts this tab missed asks instead', async () => {
  // This tab last saw night mode on with nothing stored; another device stored two since.
  let serverState = state('session-1', NIGHT);
  nightApi.get.mockImplementation(() => respond(serverState));
  nightApi.setEnabled.mockImplementation(() => refuse(409, '這個對話還有已存的 prompt，請選「立即執行」或「全部取消」。'));
  const view = renderHook(() => useNightQueue('session-1', 'project:project-1', 'bypassPermissions'));
  await act(async () => {});
  serverState = state('session-1', NIGHT, 2);

  await act(async () => {
    view.result.current.controls.onToggle();
  });

  assert.deepEqual(nightApi.setEnabled.mock.calls, [['session-1', false]]);
  assert.equal(view.result.current.controls.enabled, true);
  assert.equal(view.result.current.controls.pendingCount, 2);
  assert.equal(view.result.current.controls.isConfirming, true);
});

test('a read that overlapped a store cannot put the older state back', async () => {
  let answerRead: (value: unknown) => void = () => {};
  nightApi.get
    .mockImplementationOnce(() => respond(state('session-1', NIGHT)))
    .mockImplementationOnce(() => new Promise((resolve) => { answerRead = resolve; }));
  nightApi.enqueue.mockImplementation(() => respond(state('session-1', NIGHT, 1)));
  const view = renderHook(() => useNightQueue('session-1', 'project:project-1', 'bypassPermissions'));
  await act(async () => {});

  // A refresh leaves before the store and its answer — the state from before the store — arrives after it.
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await act(async () => {
    await view.result.current.enqueue('session-1', 'stored while reading', {});
  });
  await act(async () => {
    answerRead(jsonResponse({ success: true, data: state('session-1', null) }));
  });

  assert.equal(view.result.current.controls.enabled, true);
  assert.equal(view.result.current.controls.pendingCount, 1);
});

test('a new chat keeps its settings locally, and the prompt that creates the session carries them and its time', async () => {
  let resolveStore: (value: unknown) => void = () => {};
  nightApi.enqueue.mockImplementation(() => new Promise((resolve) => { resolveStore = resolve; }));
  const view = renderHook(
    ({ sessionId }: { sessionId: string | null }) => useNightQueue(sessionId, 'project:project-1', 'default'),
    { initialProps: { sessionId: null as string | null } },
  );

  await act(async () => {
    view.result.current.controls.onToggle();
  });
  await act(async () => {
    view.result.current.controls.onAnswerBypass(true);
  });
  assert.equal(view.result.current.controls.enabled, true);
  assert.deepEqual(view.result.current.controls.mode, NIGHT);
  assert.equal(nightApi.setEnabled.mock.calls.length, 0, 'no session yet, nothing to tell the server');

  // The first prompt created "new-session"; the store is still in flight when the chat switches to it.
  const lunch = '2026-09-25T04:05:00.000Z';
  let storing: Promise<NightQueueStoreResult> = Promise.resolve({ ok: false, message: null });
  await act(async () => {
    storing = view.result.current.enqueue('new-session', 'first', {}, lunch);
  });
  assert.deepEqual(nightApi.enqueue.mock.calls[0], ['new-session', { content: 'first', options: {}, mode: NIGHT, startAt: lunch }]);
  view.rerender({ sessionId: 'new-session' });
  await act(async () => {});
  assert.equal(view.result.current.controls.enabled, true, 'still night mode while the store is in flight');

  await act(async () => {
    resolveStore(jsonResponse({ success: true, data: state('new-session', NIGHT, 1) }, true, 201));
    assert.deepEqual(await storing, { ok: true });
  });
  assert.equal(view.result.current.controls.enabled, true);
  assert.equal(view.result.current.controls.pendingCount, 1);
});

test('the store says why the server refused a prompt', async () => {
  nightApi.enqueue.mockImplementation(() => refuse(400, '沒有內容可以存。'));
  const view = renderHook(() => useNightQueue('session-1', 'project:project-1', 'bypassPermissions'));
  await act(async () => {});

  let result: NightQueueStoreResult = { ok: true };
  await act(async () => {
    result = await view.result.current.enqueue('session-1', '', {});
  });
  assert.deepEqual(result, { ok: false, message: '沒有內容可以存。' });
});

test('the bypass question offers: with bypass, without, cancel', () => {
  const calls: string[] = [];
  render(<NightQueuePanel {...panelControls({
    isAskingBypass: true,
    onAnswerBypass: (useBypass) => calls.push(`answer:${useBypass}`),
    onCancelBypass: () => calls.push('cancel'),
  })} />);

  const buttons = Array.from(screen.getByRole('dialog').querySelectorAll('button'));
  assert.equal(buttons.length, 3);
  buttons.forEach((button) => fireEvent.click(button));
  assert.deepEqual(calls, ['answer:true', 'answer:false', 'cancel']);
});

test('the confirm box offers exactly: run now, cancel all, back', () => {
  const calls: string[] = [];
  const controls = panelControls({
    enabled: true,
    mode: NIGHT,
    items: state('session-1', NIGHT, 1).items,
    pendingCount: 1,
    isConfirming: true,
    onRunNow: () => calls.push('runNow'),
    onCancelAll: () => calls.push('cancelAll'),
    onCloseConfirm: () => calls.push('back'),
    onCancelItem: (id) => calls.push(`cancel:${id}`),
  });
  render(<NightQueuePanel {...controls} />);

  const dialog = screen.getByRole('alertdialog');
  const buttons = Array.from(dialog.querySelectorAll('button'));
  assert.equal(buttons.length, 3);
  buttons.forEach((button) => fireEvent.click(button));
  assert.deepEqual(calls, ['runNow', 'cancelAll', 'back']);

  fireEvent.click(screen.getByRole('button', { name: /cancelItem|取消這則|Cancel this prompt/ }));
  assert.deepEqual(calls.at(-1), 'cancel:item-0');
});

test('reading the time at the start of a prompt', () => {
  const now = new Date(2026, 8, 24, 11, 50);
  const time = (text: string) => {
    const result = parseStartAnnotation(text, now);
    return result.kind === 'time' ? [result.startAt.getTime(), result.rest] : result.kind;
  };
  assert.deepEqual(time('@12:05 跑回測'), [new Date(2026, 8, 24, 12, 5).getTime(), '跑回測']);
  assert.deepEqual(time('＠12：05跑回測'), [new Date(2026, 8, 24, 12, 5).getTime(), '跑回測'], 'full-width, no space');
  assert.deepEqual(time('@9:30 x'), [new Date(2026, 8, 25, 9, 30).getTime(), 'x'], 'already past today: tomorrow');
  assert.deepEqual(parseStartAnnotation('@重置 跑', now), { kind: 'reset', rest: '跑' });
  assert.equal(parseStartAnnotation('@25:00 x', now).kind, 'invalid');
  assert.equal(parseStartAnnotation('@12:5 x', now).kind, 'invalid');
  assert.equal(parseStartAnnotation('@12:60 x', now).kind, 'invalid');
  assert.equal(parseStartAnnotation('@README.md 看一下', now).kind, 'none');
  assert.equal(parseStartAnnotation('跑回測 @12:05', now).kind, 'none', 'only at the start');
  assert.equal(parseStartAnnotation('一般的 prompt', now).kind, 'none');
});

test('the next occurrence of a time is today when still ahead, else tomorrow; labels add the date when not today', () => {
  const now = new Date(2026, 8, 24, 11, 50);
  assert.equal(nextOccurrence('12:05', now)?.getTime(), new Date(2026, 8, 24, 12, 5).getTime());
  assert.equal(nextOccurrence('11:50', now)?.getTime(), new Date(2026, 8, 25, 11, 50).getTime());
  assert.equal(nextOccurrence('noon', now), null);
  assert.equal(formatStartAt(new Date(2026, 8, 24, 12, 5).toISOString(), now), '12:05');
  assert.equal(formatStartAt(new Date(2026, 8, 25, 2, 0).toISOString(), now), '9/25 02:00');
});
