import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, onTestFinished, test, vi } from 'vitest';
import { setDhcConfig } from '@/shared/dhcConfig';

import ChatRoom from '@/modules/chat-room/ChatRoom';
import { OPEN_SETTINGS_PROFILES_EVENT } from '@/modules/sidebar/SettingsProfileGate';
import { ASSISTANT_ID, LOBBY, closeChatPanel, dmRoom, flushChatWrites, loadChat, openChatPanel, useLibraryRequest } from '@/shared/chatRoom';

/**
 * 10/25 R3: 你是誰 chosen in place, the @ list with team roles and bots, 我的小助理 moved forward with starters, an
 * easier 新增 (default mention, templates, 現在試叫), 忙線 as a line instead of alert(), and a new bot callable
 * without reloading the page.
 */
const who = vi.hoisted(() => ({ me: 'proj-me' as string | null }));
vi.mock('@/shared/userSettings', async (original) => ({
  ...(await original<typeof import('@/shared/userSettings')>()),
  resolveSettingsProjectId: () => who.me,
}));

type Call = { method: string; url: string; body: unknown };
let prefs: Record<string, unknown>;
let calls: Call[];
let bots: Record<string, unknown>;
let replyStatus: number;
let cards: unknown[];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const TEAM = [{ id: 'review', name: '覆核員', mentions: ['@覆核'], prompt: '你是數字覆核員。' }];
const MINE = { id: 'b1', name: '算帳仔', mentions: ['@算帳'], duty: '對帳', style: '', avatar: '算', owner: 'proj-me', ownerName: '小明', visibility: 'private' };
const THEIRS = { id: 'b2', name: '華仔', mentions: ['@華仔'], duty: '查報表', style: '', avatar: '華', owner: 'proj-hua', ownerName: '阿華', visibility: 'public' };
const on = (extra: Record<string, unknown> = {}) => ({ enabled: true, mine: [], public: [], team: TEAM, mentions: ['@覆核'], faces: {}, myStyle: '', ...extra });

beforeEach(() => {
  who.me = 'proj-me';
  prefs = {};
  calls = [];
  cards = [];
  replyStatus = 202;
  bots = { enabled: false, mine: [], public: [], team: TEAM, mentions: ['@覆核'], faces: {}, myStyle: '' };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url: input, body });
    if (input === '/api/user/preferences' && method === 'GET') return json(200, { preferences: prefs });
    if (input === '/api/user/preferences' && method === 'PATCH') {
      prefs = { ...prefs, ...(body as Record<string, unknown>) };
      return json(200, { success: true });
    }
    if (input === '/api/projects') return json(200, [{ projectId: 'proj-me', displayName: '小明', name: 'me', path: 'C:/Users/demo/DHC Workspace/小明', fullPath: 'C:/Users/demo/DHC Workspace/小明', sessions: [] }]);
    if (input === '/api/assistant/reply') return replyStatus === 429 ? json(429, { success: false, error: { code: 'BUSY' } }) : json(replyStatus, { success: true, data: { state: 'running' } });
    if (input.startsWith('/api/assistant/status')) return json(200, { success: true, data: { running: [], steps: {} } });
    if (input.startsWith('/api/assistant/bots') && method === 'GET') return json(200, { success: true, data: bots });
    if (input === '/api/assistant/bots' && method === 'POST') return json(200, { success: true, data: { bot: { id: 'new' } } });
    if (input.startsWith('/api/assistant/cards')) return json(200, { success: true, data: { cards, next: null } });
    if (input.startsWith('/api/assistant/actions/')) return json(429, { success: false });
    return json(200, {});
  }));
});

afterEach(() => {
  act(() => closeChatPanel());
});

const renderChat = () => render(<MemoryRouter><ChatRoom projects={[]} isMobile={false} /></MemoryRouter>);
const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
async function until(check: () => boolean, label: string): Promise<void> {
  // Plain polling, never waitFor (a failing waitFor pretty-prints the whole page; see assistant.test.tsx).
  for (let i = 0; i < 40; i += 1) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  }
  assert.fail(label);
}
const pause = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
const replyCalls = () => calls.filter((call) => call.url === '/api/assistant/reply');

// ---- P0-1 你是誰 ----
test('with nobody chosen, the composer offers 選你是誰 (the picker window) and 私訊 lists the projects in place; once chosen, typing works', async () => {
  // Choosing who you are is a team feature (dhc.config.json "mode": "team").
  setDhcConfig({ mode: 'team' });
  onTestFinished(() => setDhcConfig({ mode: 'personal' }));
  who.me = null;
  const opened = vi.fn();
  window.addEventListener(OPEN_SETTINGS_PROFILES_EVENT, opened);
  const view = renderChat();
  act(() => openChatPanel(LOBBY));
  assert.equal(screen.queryByRole('textbox'), null, 'no box to type into yet');
  fireEvent.click(screen.getByRole('button', { name: '選你是誰' }));
  assert.equal(opened.mock.calls.length, 1, 'opens the same picker as 設定 → 專案設定, right here');
  window.removeEventListener(OPEN_SETTINGS_PROFILES_EVENT, opened);

  fireEvent.click(screen.getByRole('tab', { name: /私訊/ }));
  await until(() => Boolean(screen.queryByText('你是誰？')) && Boolean(screen.queryByRole('button', { name: /小明/ })), 'the project list is shown inside 私訊');
  assert.ok(screen.getByRole('button', { name: /共用設定/ }));

  // Picking reloads the page; after it this device is someone.
  who.me = 'proj-me';
  view.rerender(<MemoryRouter><ChatRoom projects={[]} isMobile={false} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('tab', { name: /動態/ }));
  await until(() => screen.queryByRole('textbox') !== null, 'the box is back');
  assert.equal(screen.queryByTestId('who-am-i'), null);
});

// ---- P0-2 the @ list ----
test('@ lists team roles always, and my bots and the others\' public ones when switched on; picking one types its mention and calls it', async () => {
  bots = on({ mine: [MINE], public: [THEIRS], mentions: ['@覆核', '@算帳', '@華仔'], faces: { 算帳仔: '算', 華仔: '華' } });
  renderChat();
  act(() => openChatPanel(LOBBY));
  await until(() => calls.some((call) => call.url.startsWith('/api/assistant/bots')), 'the list is loaded');
  await pause();
  fireEvent.change(box(), { target: { value: '@覆', selectionStart: 2 } });
  await until(() => Boolean(screen.queryByRole('button', { name: /覆核員/ })), 'the team role is offered');
  assert.ok(screen.getByRole('button', { name: /覆核員/ }).textContent!.includes('團隊角色'));
  fireEvent.change(box(), { target: { value: '@算', selectionStart: 2 } });
  await until(() => Boolean(screen.queryByRole('button', { name: /算帳仔/ })), 'my own bot is offered');
  assert.ok(screen.getByRole('button', { name: /算帳仔/ }).textContent!.includes('我的（私人）'));
  fireEvent.change(box(), { target: { value: '@華', selectionStart: 2 } });
  await until(() => Boolean(screen.queryByRole('button', { name: /華仔/ })), 'a public bot is offered');
  assert.ok(screen.getByRole('button', { name: /華仔/ }).textContent!.includes('阿華的'));

  fireEvent.change(box(), { target: { value: '@覆', selectionStart: 2 } });
  await until(() => Boolean(screen.queryByRole('button', { name: /覆核員/ })), 'offered again');
  fireEvent.mouseDown(screen.getByRole('button', { name: /覆核員/ }));
  assert.equal(box().value, '@覆核 ', 'its mention as plain text');
  fireEvent.change(box(), { target: { value: '@覆核 這張表對嗎', selectionStart: 10 } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await until(() => replyCalls().length === 1, 'the role is called');
});

test('switched off, the @ list has the team roles but no own bots', async () => {
  bots = { ...on({ mine: [MINE], public: [THEIRS] }), enabled: false };
  renderChat();
  act(() => openChatPanel(LOBBY));
  await until(() => calls.some((call) => call.url.startsWith('/api/assistant/bots')), 'the list is loaded');
  await pause();
  fireEvent.change(box(), { target: { value: '@', selectionStart: 1 } });
  await until(() => Boolean(screen.queryByRole('button', { name: /覆核員/ })), 'team roles are there');
  assert.equal(screen.queryByRole('button', { name: /算帳仔/ }), null);
  assert.equal(screen.queryByRole('button', { name: /華仔/ }), null);
});

// ---- A3: a bot made after this page opened ----
test('a mention the page does not know yet reloads the list once before sending, so a brand-new bot answers without a refresh', async () => {
  bots = on();
  renderChat();
  act(() => openChatPanel(LOBBY));
  await until(() => calls.some((call) => call.url.startsWith('/api/assistant/bots')), 'loaded once');
  await pause();
  bots = on({ public: [{ ...THEIRS, name: '新來的', mentions: ['@新來的'] }], mentions: ['@覆核', '@新來的'] });
  const loadsBefore = calls.filter((call) => call.url.startsWith('/api/assistant/bots')).length;
  fireEvent.change(box(), { target: { value: '@新來的 幫我看', selectionStart: 8 } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await until(() => replyCalls().length === 1, 'the new bot is called');
  assert.equal(calls.filter((call) => call.url.startsWith('/api/assistant/bots')).length, loadsBefore + 1, 'one reload');

  // An email with no real mention: nothing is asked.
  fireEvent.change(box(), { target: { value: '寄到 x@新來的.com', selectionStart: 12 } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await pause();
  await pause();
  assert.equal(replyCalls().length, 1);
});

// ---- P0-3 入口往前移 and the starters ----
test('switched on, 私訊 has 我的小助理 right under 團隊小助理 and it opens the panel; an empty private chat offers three starters', async () => {
  who.me = 'proj-p3';
  bots = on({ mine: [{ ...MINE, owner: 'proj-p3' }] });
  renderChat();
  act(() => openChatPanel(LOBBY));
  fireEvent.click(screen.getByRole('tab', { name: /私訊/ }));
  await until(() => Boolean(screen.queryByTestId('my-bots-row')?.textContent?.includes('我的小助理（1）')), 'the row is there, with my count');
  fireEvent.click(screen.getByTestId('my-bots-row'));
  await until(() => Boolean(screen.queryByTestId('my-bots')), 'the panel opens directly');
  fireEvent.click(screen.getByRole('button', { name: '回私聊' }));

  await until(() => Boolean(screen.queryByTestId('assistant-starters')), 'starters in the empty private chat');
  const starters = screen.getByTestId('assistant-starters');
  assert.deepEqual([...starters.querySelectorAll('button')].map((button) => button.textContent), ['查資料庫範例', '建一個小助理', '打開工具庫']);
  fireEvent.click(screen.getByRole('button', { name: '建一個小助理' }));
  await until(() => Boolean(screen.queryByTestId('my-bot-form')), 'the add form is open at once');
});

test('switched off, no 我的小助理 row and no 建一個小助理 starter; 查資料庫範例 asks', async () => {
  who.me = 'proj-p3off';
  renderChat();
  act(() => openChatPanel(LOBBY));
  fireEvent.click(screen.getByRole('tab', { name: /私訊/ }));
  await until(() => Boolean(screen.queryByRole('button', { name: /團隊小助理/ })), 'the list is there');
  await pause();
  assert.equal(screen.queryByTestId('my-bots-row'), null);
  fireEvent.click(screen.getByRole('button', { name: /團隊小助理/ }));
  await until(() => Boolean(screen.queryByTestId('assistant-starters')), 'starters');
  assert.equal(screen.queryByRole('button', { name: '建一個小助理' }), null);
  fireEvent.click(screen.getByRole('button', { name: '查資料庫範例' }));
  await until(() => replyCalls().length === 1, 'the example question is asked');
  await act(async () => { await flushChatWrites(); });
  const room = dmRoom('proj-p3off', ASSISTANT_ID);
  assert.ok((prefs[`dhc.chat:${room}`] as { msgs: Array<{ text: string }> }).msgs.some((m) => m.text.includes('查資料庫')));
});

test('打開工具庫 closes the chat panel and asks 自選功能 to open the library', async () => {
  who.me = 'proj-lib';
  let library = 0;
  function Probe() {
    library = useLibraryRequest();
    return null;
  }
  render(<Probe />);
  renderChat();
  act(() => openChatPanel(dmRoom('proj-lib', ASSISTANT_ID)));
  await until(() => Boolean(screen.queryByRole('button', { name: '打開工具庫' })), 'starter shown');
  fireEvent.click(screen.getByRole('button', { name: '打開工具庫' }));
  await until(() => library > 0 && !screen.queryByTestId('chat-room-panel'), 'the library is asked for and the chat is closed');
});

// ---- P0-4 建小助理少一步 ----
test('name and 負責什麼 are enough (呼叫詞 defaults to @name); a template fills the form; after saving, 現在試叫 sends a call', async () => {
  who.me = 'proj-p4';
  bots = on();
  renderChat();
  const room = dmRoom('proj-p4', ASSISTANT_ID);
  act(() => openChatPanel(room));
  await until(() => Boolean(screen.queryByTestId('my-bots-open')), 'the entry');
  fireEvent.click(screen.getByTestId('my-bots-open'));
  await until(() => Boolean(screen.queryByTestId('my-bot-templates')), 'templates offered');
  assert.deepEqual([...screen.getByTestId('my-bot-templates').querySelectorAll('button')].map((b) => b.textContent), ['對帳小幫手', 'SQL 小幫手', '報表摘要', '會議紀錄整理']);

  fireEvent.click(screen.getByRole('button', { name: '對帳小幫手' }));
  const form = await screen.findByTestId('my-bot-form');
  assert.equal((form.querySelector('input') as HTMLInputElement).value, '對帳小幫手');
  assert.match((form.querySelector('textarea') as HTMLTextAreaElement).value, /核對兩份資料/);
  assert.ok(form.querySelector('[data-tutorial-tip*="不填就用 @對帳小幫手"]'));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));

  fireEvent.click(screen.getByRole('button', { name: /新增/ }));
  const fresh = await screen.findByTestId('my-bot-form');
  fireEvent.change(fresh.querySelector('input') as HTMLInputElement, { target: { value: '晨報 仔' } });
  fireEvent.change(fresh.querySelector('textarea') as HTMLTextAreaElement, { target: { value: '整理晨報重點' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存' }));
  await until(() => calls.some((call) => call.method === 'POST' && call.url === '/api/assistant/bots'), 'saved');
  const sent = calls.find((call) => call.method === 'POST' && call.url === '/api/assistant/bots')!.body as { name: string; mentions: string[]; avatar: string };
  assert.deepEqual([sent.name, sent.mentions, sent.avatar], ['晨報 仔', ['@晨報仔'], '晨']);

  await until(() => Boolean(screen.queryByTestId('my-bot-saved')), 'where and how to call it');
  assert.ok(screen.getByTestId('my-bot-saved').textContent!.includes('@晨報仔'));
  fireEvent.click(screen.getByRole('button', { name: /現在試叫/ }));
  await until(() => replyCalls().length === 1, 'the try is asked');
  await act(async () => { await flushChatWrites(); });
  const asked = (prefs[`dhc.chat:${room}`] as { msgs: Array<{ text: string; at: string }> }).msgs.at(-1)!;
  assert.match(asked.text, /^@晨報仔 /);
  assert.equal((replyCalls()[0].body as { roomId: string }).roomId, room);
  assert.equal(screen.queryByTestId('my-bots'), null, 'back in the private chat to see the answer');
});

// ---- P0-5 忙線 without alert() ----
test('忙線 (429) shows a line in the room with 重試, never alert(); a busy card press says so under the card', async () => {
  who.me = 'proj-p5';
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  replyStatus = 429;
  renderChat();
  act(() => openChatPanel(LOBBY));
  fireEvent.change(box(), { target: { value: '@團隊小助理 在嗎', selectionStart: 9 } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await until(() => Boolean(screen.queryByTestId('assistant-busy')), 'the busy line');
  assert.match(screen.getByTestId('assistant-busy').textContent!, /忙線中.*30 秒後自動再試一次/);
  replyStatus = 202;
  fireEvent.click(screen.getByRole('button', { name: /重試/ }));
  await until(() => replyCalls().length === 2 && !screen.queryByTestId('assistant-busy'), 'asked again, the line goes away');
  act(() => closeChatPanel());

  // A card pressed while busy.
  const room = dmRoom('proj-p5', ASSISTANT_ID);
  prefs = { [`dhc.chat:${room}`]: { msgs: [
    { id: 'q1', by: 'proj-p5', text: '刪掉 old.txt', at: new Date(Date.now() - 60_000).toISOString(), refs: [] },
    { id: 'r1', by: ASSISTANT_ID, text: '按卡片執行。', at: new Date(Date.now() - 50_000).toISOString(), refs: [], replyTo: 'q1' },
  ] } };
  cards = [{ id: 'c1', messageId: 'r1', tool: 'Bash', summary: '執行指令：rm old.txt', detail: '{}', status: 'pending' }];
  act(() => openChatPanel(room));
  await act(async () => { await flushChatWrites(); await loadChat(); });
  await until(() => Boolean(screen.queryByRole('button', { name: '執行' })), 'the card');
  fireEvent.click(screen.getByRole('button', { name: '執行' }));
  fireEvent.click(screen.getByRole('button', { name: '確定' }));
  await until(() => Boolean(screen.queryByTestId('card-note')), 'the reason under the card');
  assert.match(screen.getByTestId('card-note').textContent!, /忙線中/);
  assert.equal(alert.mock.calls.length, 0, 'no alert() anywhere');
  alert.mockRestore();
});
