import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatRoom from '@/modules/chat-room/ChatRoom';
import { ASSISTANT_ID, LOBBY, closeChatPanel, dmRoom, flushChatWrites, loadChat, openChatPanel } from '@/shared/chatRoom';

vi.mock('@/shared/userSettings', async (original) => ({
  ...(await original<typeof import('@/shared/userSettings')>()),
  resolveSettingsProjectId: () => 'proj-me',
}));

type Call = { method: string; url: string; body: unknown };
let prefs: Record<string, unknown>;
let running: string[];
let calls: Call[];
let cards: unknown[];
let steps: Record<string, string>;
let next: unknown;
let bots: unknown;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  prefs = {};
  running = [];
  calls = [];
  cards = [];
  steps = {};
  next = null;
  bots = { enabled: false, mentions: ['@覆核', '@審查', '@值班'] };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url: input, body });
    if (input === '/api/user/preferences' && method === 'GET') return json(200, { preferences: prefs });
    if (input === '/api/user/preferences' && method === 'PATCH') {
      prefs = { ...prefs, ...(body as Record<string, unknown>) };
      return json(200, { success: true });
    }
    if (input === '/api/assistant/reply') {
      running = [(body as { triggerAt: string }).triggerAt];
      return json(202, { success: true, data: { state: 'running' } });
    }
    if (input.startsWith('/api/assistant/status')) return json(200, { success: true, data: { running, steps } });
    if (input.startsWith('/api/assistant/bots') && method === 'GET') return json(200, { success: true, data: bots });
    if (input.startsWith('/api/assistant/cards')) return json(200, { success: true, data: { cards, next } });
    if (input.startsWith('/api/assistant/actions/')) return json((body as { decision: string }).decision === 'approve' ? 202 : 200, { success: true, data: { state: 'x' } });
    return json(200, {});
  }));
});

afterEach(() => {
  act(() => closeChatPanel());
});

const renderChat = () => render(<MemoryRouter><ChatRoom projects={[]} isMobile={false} /></MemoryRouter>);
const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;

test('@ lists 團隊小助理 first, with its own avatar', async () => {
  renderChat();
  act(() => openChatPanel(LOBBY));
  fireEvent.change(box(), { target: { value: '@', selectionStart: 1 } });
  const options = await screen.findAllByRole('button', { name: /團隊小助理/ });
  assert.ok(options.length > 0);
  const first = document.querySelector('.absolute.bottom-full button');
  assert.ok(first?.textContent?.includes('團隊小助理'), 'the assistant is the first candidate');
  assert.ok(first?.querySelector('[data-testid="assistant-avatar"]'), 'drawn as 助, not as a person');
});

test('a message in the private chat with the assistant is saved, then asked; 思考中 shows until the reply lands', async () => {
  renderChat();
  const room = dmRoom('proj-me', ASSISTANT_ID);
  act(() => openChatPanel(room));
  fireEvent.change(box(), { target: { value: '今天要對帳嗎', selectionStart: 6 } });
  fireEvent.keyDown(box(), { key: 'Enter' });

  await waitFor(() => assert.ok(calls.some((call) => call.url === '/api/assistant/reply')));
  const saveIndex = calls.findIndex((call) => call.method === 'PATCH');
  const askIndex = calls.findIndex((call) => call.url === '/api/assistant/reply');
  assert.ok(saveIndex >= 0 && saveIndex < askIndex, 'the message is on the server before the assistant is asked');
  const saved = (prefs[`dhc.chat:${room}`] as { msgs: Array<{ at: string; text: string }> }).msgs;
  assert.deepEqual(calls[askIndex].body, { roomId: room, triggerAt: saved[0].at, profileId: 'proj-me' });

  await screen.findByTestId('assistant-thinking');
  prefs = { ...prefs, [`dhc.chat:${room}`]: { msgs: [...saved, { id: 'r1', by: ASSISTANT_ID, text: '要，先看 break 清單。', at: new Date(Date.now() + 1000).toISOString(), refs: [], replyTo: 'x' }] } };
  running = [];
  // Plain polling: a failing waitFor/findBy here pretty-prints the whole page and once ran a worker to 48 GB.
  let landed = false;
  for (let i = 0; i < 24 && !landed; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    landed = !document.querySelector('[data-testid="assistant-thinking"]') && document.body.textContent!.includes('要，先看 break 清單。');
  }
  assert.ok(landed, '思考中 is gone and the reply is in the room');
}, 15_000);

test('a lobby message without the mention does not ask the assistant', async () => {
  renderChat();
  act(() => openChatPanel(LOBBY));
  fireEvent.change(box(), { target: { value: '大家早', selectionStart: 3 } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => assert.ok(calls.some((call) => call.method === 'PATCH')));
  assert.equal(calls.some((call) => call.url === '/api/assistant/reply'), false);
});

test('the private-chat list always offers 團隊小助理', async () => {
  renderChat();
  act(() => openChatPanel(LOBBY));
  fireEvent.click(screen.getByRole('tab', { name: /私訊/ }));
  const row = await screen.findByRole('button', { name: /團隊小助理/ });
  fireEvent.click(row);
  await screen.findByPlaceholderText('私訊 團隊小助理…');
});

// ---- 10/20 action cards and 重試 ----
async function until(check: () => boolean, label: string): Promise<void> {
  // Plain polling, never waitFor: a failing waitFor pretty-prints the whole page (see the 48 GB note above).
  for (let i = 0; i < 40; i += 1) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  }
  assert.fail(label);
}

function seedAssistantRoom(reply: Record<string, unknown>): string {
  const room = dmRoom('proj-me', ASSISTANT_ID);
  const at = new Date(Date.now() - 60_000).toISOString();
  prefs = { [`dhc.chat:${room}`]: { msgs: [
    { id: 'q1', by: 'proj-me', text: '刪掉 old.txt', at, refs: [] },
    { id: 'r1', by: ASSISTANT_ID, at: new Date(Date.now() - 50_000).toISOString(), refs: [], replyTo: 'q1', ...reply },
  ] } };
  return room;
}

test('a pending card shows what it will do; 執行 asks once in the card (確定), then posts approve for that card', async () => {
  const room = seedAssistantRoom({ text: '要刪 old.txt，按卡片執行。' });
  cards = [{ id: 'c1', messageId: 'r1', tool: 'Bash', summary: '執行指令：rm old.txt', detail: '{"command":"rm old.txt"}', status: 'pending' }];
  const confirm = vi.spyOn(window, 'confirm');
  renderChat();
  act(() => openChatPanel(room));
  // Opening queues a seen-mark save, and a load during a save is dropped; load once it is through.
  await act(async () => { await flushChatWrites(); await loadChat(); });
  await until(() => Boolean(screen.queryByText('執行指令：rm old.txt')), 'the card is shown under the reply');
  assert.ok(screen.getByText('等人按'));
  fireEvent.click(screen.getByRole('button', { name: '執行' }));
  assert.match(screen.getByTestId('card-confirm').textContent!, /確定讓團隊小助理執行/);
  assert.equal(calls.some((call) => call.url.startsWith('/api/assistant/actions/')), false, 'nothing sent before 確定');
  fireEvent.click(screen.getByRole('button', { name: '確定' }));
  await until(() => calls.some((call) => call.url === '/api/assistant/actions/c1'), 'the press reaches the server');
  assert.equal(confirm.mock.calls.length, 0, 'no window.confirm (10/25 R4)');
  assert.deepEqual(calls.find((call) => call.url === '/api/assistant/actions/c1')!.body, { decision: 'approve', profileId: 'proj-me' });
  confirm.mockRestore();
});

test('先不要 at the confirm line sends nothing; 取消 sends reject without asking', async () => {
  const room = seedAssistantRoom({ text: '要刪 old.txt。' });
  cards = [{ id: 'c2', messageId: 'r1', tool: 'Bash', summary: '執行指令：rm old.txt', detail: '{}', status: 'pending' }];
  const confirm = vi.spyOn(window, 'confirm');
  renderChat();
  act(() => openChatPanel(room));
  // Opening queues a seen-mark save, and a load during a save is dropped; load once it is through.
  await act(async () => { await flushChatWrites(); await loadChat(); });
  await until(() => Boolean(screen.queryByRole('button', { name: '執行' })), 'the card has its buttons');
  fireEvent.click(screen.getByRole('button', { name: '執行' }));
  fireEvent.click(screen.getByRole('button', { name: '先不要' }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  assert.equal(calls.some((call) => call.url.startsWith('/api/assistant/actions/')), false, 'cancelled at the confirm line');
  assert.equal(screen.queryByTestId('card-confirm'), null);
  assert.equal(confirm.mock.calls.length, 0);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await until(() => calls.some((call) => call.url === '/api/assistant/actions/c2'), 'the reject reaches the server');
  assert.deepEqual(calls.find((call) => call.url === '/api/assistant/actions/c2')!.body, { decision: 'reject', profileId: 'proj-me' });
  confirm.mockRestore();
});

test('a decided card has no buttons and says who pressed it', async () => {
  const room = seedAssistantRoom({ text: '好。' });
  cards = [{ id: 'c3', messageId: 'r1', tool: 'Bash', summary: '執行指令：rm old.txt', detail: '{}', status: 'done', by: '阿華', doneAt: new Date().toISOString() }];
  renderChat();
  act(() => openChatPanel(room));
  // Opening queues a seen-mark save, and a load during a save is dropped; load once it is through.
  await act(async () => { await flushChatWrites(); await loadChat(); });
  await until(() => Boolean(screen.queryByText('已執行')), 'the status shows');
  assert.equal(screen.queryByRole('button', { name: '執行' }), null);
  assert.ok(document.body.textContent!.includes('阿華'));
});

test('a failed answer offers 重試, which asks again about the same message', async () => {
  const room = seedAssistantRoom({ text: '這次沒回成：Claude 沒有正常結束，晚點再試一次', failed: true });
  renderChat();
  act(() => openChatPanel(room));
  // Opening queues a seen-mark save, and a load during a save is dropped; load once it is through.
  await act(async () => { await flushChatWrites(); await loadChat(); });
  await until(() => Boolean(screen.queryByRole('button', { name: /重試/ })), 'retry is offered');
  fireEvent.click(screen.getByRole('button', { name: /重試/ }));
  await until(() => calls.some((call) => call.url === '/api/assistant/reply'), 'asked again');
  const msgs = (prefs[`dhc.chat:${room}`] as { msgs: Array<{ id: string; at: string }> }).msgs;
  assert.deepEqual(calls.find((call) => call.url === '/api/assistant/reply')!.body, { roomId: room, triggerAt: msgs.find((m) => m.id === 'q1')!.at, profileId: 'proj-me' });
});

test('思考中 names the current step and 停止 asks the server to stop; the answer\'s chips send the next ask', async () => {
  const room = dmRoom('proj-me', ASSISTANT_ID);
  const q = { id: 'q1', by: 'proj-me', text: '查一下', at: '2026-10-21T07:00:00.000Z', refs: [] };
  prefs = { [`dhc.chat:${room}`]: { msgs: [q] } };
  running = [q.at];
  steps = { [q.at]: '查 DB2 資料庫' };
  renderChat();
  await act(async () => { await loadChat(); });
  act(() => openChatPanel(room));
  await until(() => Boolean(document.querySelector('[data-testid="assistant-thinking"]')?.textContent?.includes('正在查 DB2 資料庫…')), 'the step is shown');
  fireEvent.click(screen.getByRole('button', { name: /停止/ }));
  await until(() => calls.some((call) => call.url === '/api/assistant/stop'), 'stop sent');
  assert.deepEqual(calls.find((call) => call.url === '/api/assistant/stop')!.body, { roomId: room, profileId: 'proj-me' });

  prefs = { [`dhc.chat:${room}`]: { msgs: [q, { id: 'r1', by: ASSISTANT_ID, text: '✓ 有 3 筆', at: '2026-10-21T07:00:05.000Z', refs: [], replyTo: 'q1' }] } };
  next = { messageId: 'r1', items: ['列出全部', '改成表格'] };
  running = [];
  steps = {};
  await until(() => Boolean(screen.queryByRole('button', { name: '改成表格' })), 'chips under the latest answer');
  calls = [];
  fireEvent.click(screen.getByRole('button', { name: '改成表格' }));
  await until(() => calls.some((call) => call.url === '/api/assistant/reply'), 'the chip asks the assistant');
  const asked = calls.find((call) => call.url === '/api/assistant/reply')!.body as { triggerAt: string };
  const sent = (prefs[`dhc.chat:${room}`] as { msgs: Array<{ text: string; at: string }> }).msgs.find((m) => m.at === asked.triggerAt);
  assert.equal(sent?.text, '改成表格', 'in the private chat the chip is sent as is');
});

test('只回我 sends the question to your private chat with the assistant, about this room, and nothing to the room', async () => {
  renderChat();
  act(() => openChatPanel(LOBBY));
  fireEvent.change(box(), { target: { value: '@團隊小助理 break 是哪幾筆', selectionStart: 17 } });
  fireEvent.click(screen.getByRole('checkbox', { name: /只回我/ }));
  fireEvent.keyDown(box(), { key: 'Enter' });
  await until(() => calls.some((call) => call.url === '/api/assistant/reply'), 'asked');
  const dm = dmRoom('proj-me', ASSISTANT_ID);
  const body = calls.find((call) => call.url === '/api/assistant/reply')!.body as { roomId: string; aboutRoom: string };
  assert.equal(body.roomId, dm);
  assert.equal(body.aboutRoom, LOBBY);
  const asked = (prefs[`dhc.chat:${dm}`] as { msgs: Array<{ text: string }> }).msgs.at(-1)!;
  assert.equal(asked.text, '（在「動態」悄悄問）break 是哪幾筆');
  assert.equal((prefs[`dhc.chat:${LOBBY}`] as { msgs: unknown[] } | undefined)?.msgs?.length ?? 0, 0, 'the lobby got nothing');
  assert.ok(screen.getByTestId('side-note'));
});

// ---- 10/25 自建小助理: the borrow card in the owner's private chat, and the 我的小助理 panel ----
test('a borrow request shows the bot face and 同意／拒絕; 同意 asks once and posts approve', async () => {
  bots = { enabled: true, mine: [], public: [], team: [], mentions: ['@算帳'], faces: { 算帳仔: '算' }, myStyle: '' };
  const room = seedAssistantRoom({ text: '【算帳仔】借用請求：阿華 在「動態」叫了你的私人小助理「算帳仔」，問：@算帳 借' });
  cards = [{ id: 'b1', messageId: 'r1', kind: 'borrow', tool: 'borrow', summary: '借用「算帳仔」：阿華 在動態問', detail: '@算帳 借', status: 'pending' }];
  renderChat();
  act(() => openChatPanel(room));
  await act(async () => { await flushChatWrites(); await loadChat(); });
  await until(() => Boolean(screen.queryByRole('button', { name: '同意' })), 'the borrow card has its buttons');
  assert.ok(screen.getByRole('button', { name: '拒絕' }));
  assert.ok(screen.getAllByTestId('assistant-avatar').some((face) => face.textContent === '算'), 'the bot answers with its own face');
  fireEvent.click(screen.getByRole('button', { name: '同意' }));
  assert.match(screen.getByTestId('card-confirm').textContent!, /確定借他用/);
  fireEvent.click(screen.getByRole('button', { name: '確定' }));
  await until(() => calls.some((call) => call.url === '/api/assistant/actions/b1'), 'the press reaches the server');
  assert.deepEqual(calls.find((call) => call.url === '/api/assistant/actions/b1')!.body, { decision: 'approve', profileId: 'proj-me' });
});

test('我的小助理 is offered only when switched on; 複製 a team role fills the form and 儲存 sends it', async () => {
  const room = dmRoom('proj-me', ASSISTANT_ID);
  const first = renderChat();
  act(() => openChatPanel(room));
  await screen.findByPlaceholderText('私訊 團隊小助理…');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  assert.equal(screen.queryByTestId('my-bots-open'), null, 'off: no entry');
  act(() => closeChatPanel());
  first.unmount();

  bots = { enabled: true, mine: [], public: [{ id: 'p1', name: '華仔', mentions: ['@華仔'], duty: '查報表', style: '', avatar: '華', owner: 'proj-hua', ownerName: '阿華', visibility: 'public' }], team: [{ id: 'r', name: '覆核員', mentions: ['@覆核'], prompt: '你是數字覆核員。' }], mentions: ['@覆核', '@華仔'], faces: { 華仔: '華' }, myStyle: '' };
  renderChat();
  act(() => openChatPanel(room));
  await until(() => Boolean(screen.queryByTestId('my-bots-open')), 'on: the entry is at the top of the private chat');
  fireEvent.click(screen.getByTestId('my-bots-open'));
  await until(() => Boolean(screen.queryByText('我的（0/5）')), 'the panel opens');
  assert.ok(screen.getByText('別人公開的') && screen.getByText('華仔') && screen.getByText('團隊') && screen.getByText('覆核員'));
  fireEvent.click(screen.getByRole('button', { name: /複製/ }));
  const form = await screen.findByTestId('my-bot-form');
  assert.equal((form.querySelector('textarea') as HTMLTextAreaElement).value, '你是數字覆核員。');
  fireEvent.change(screen.getByPlaceholderText('@算帳 @對帳'), { target: { value: '@我覆核 對數' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存' }));
  await until(() => calls.some((call) => call.method === 'POST' && call.url === '/api/assistant/bots'), 'the new bot reaches the server');
  assert.deepEqual(calls.find((call) => call.method === 'POST' && call.url === '/api/assistant/bots')!.body, {
    name: '我的覆核員', mentions: ['@我覆核', '@對數'], avatar: '覆', duty: '你是數字覆核員。', style: '', visibility: 'private', profileId: 'proj-me',
  });
});
