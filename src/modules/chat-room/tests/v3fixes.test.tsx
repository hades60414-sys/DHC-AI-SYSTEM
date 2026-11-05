import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatRoom from '@/modules/chat-room/ChatRoom';
import { LOBBY, addNote, closeChatPanel, dmRoom, flushChatWrites, flushNote, openChatPanel, setChatMe, updateNote } from '@/shared/chatRoom';

/** 11/01 V3 fixes in the chat room: 未送出 + 重試, the send key preference, a draft per room, honest 只回我 wording, labelled lights, 完成 saving a sticky note at once. */

const who = vi.hoisted(() => ({ me: 'proj-me' as string | null, ctrlEnter: false }));
vi.mock('@/shared/userSettings', async (original) => ({
  ...(await original<typeof import('@/shared/userSettings')>()),
  resolveSettingsProjectId: () => who.me,
}));
vi.mock('@/shared/uiPreferences', async (original) => ({
  ...(await original<typeof import('@/shared/uiPreferences')>()),
  readStoredUiPreferences: () => ({ sendByCtrlEnter: who.ctrlEnter }),
}));

let prefs: Record<string, unknown>;
let patchOk: boolean;
let patches: Record<string, unknown>[];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  who.me = 'proj-me';
  who.ctrlEnter = false;
  prefs = {};
  patchOk = true;
  patches = [];
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (input === '/api/user/preferences' && method === 'GET') return json(200, { preferences: prefs });
    if (input === '/api/user/preferences' && method === 'PATCH') {
      if (!patchOk) return json(503, { success: false });
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      patches.push(body);
      prefs = { ...prefs, ...body };
      return json(200, { success: true });
    }
    if (input === '/api/projects') return json(200, []);
    if (input.startsWith('/api/assistant/status')) return json(200, { success: true, data: { running: [], steps: {} } });
    if (input.startsWith('/api/assistant/bots')) return json(200, { success: true, data: { enabled: false, mine: [], public: [], team: [], mentions: [], faces: {}, myStyle: '' } });
    if (input.startsWith('/api/assistant/cards')) return json(200, { success: true, data: { cards: [], next: null } });
    return json(200, {});
  }));
});

afterEach(() => {
  act(() => closeChatPanel());
});

const renderChat = () => render(<MemoryRouter><ChatRoom projects={[]} isMobile={false} /></MemoryRouter>);
const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  }
  assert.fail(label);
}
const chatPatches = () => patches.filter((body) => Object.keys(body).some((key) => key === 'dhc.chat:lobby'));

test('a message whose save failed is marked 未送出 and kept; 重試 saves it and only then clears the mark', async () => {
  renderChat();
  act(() => openChatPanel(LOBBY));
  await until(() => screen.queryByRole('textbox') !== null, 'the box is there');
  patchOk = false;
  fireEvent.change(box(), { target: { value: '這句要送出', selectionStart: 5 } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await until(() => screen.queryByTestId('unsent') !== null, 'the failed message is marked');
  assert.ok(screen.getByText('這句要送出'), 'its text is still on screen');
  assert.ok(localStorage.getItem('dhc.chatUnsent')?.includes('這句要送出'), 'and kept on this device for a reload');

  patchOk = true;
  fireEvent.click(screen.getByRole('button', { name: /重試/ }));
  await until(() => screen.queryByTestId('unsent') === null, 'the mark clears after the save');
  assert.ok(JSON.stringify(prefs).includes('這句要送出'), 'the server has it now: ' + Object.keys(prefs).join());
  assert.equal(localStorage.getItem('dhc.chatUnsent'), null);
});

test('Ctrl+Enter 傳送 on: a bare Enter in the chat room only types; Ctrl+Enter sends. Off: Enter sends', async () => {
  who.ctrlEnter = true;
  renderChat();
  act(() => openChatPanel(LOBBY));
  await until(() => screen.queryByRole('textbox') !== null, 'the box is there');
  fireEvent.change(box(), { target: { value: '換行不送', selectionStart: 4 } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await act(async () => { await flushChatWrites(); });
  assert.equal(chatPatches().length, 0, 'a bare Enter did not send');
  fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
  await until(() => chatPatches().length === 1, 'Ctrl+Enter sent it');

  who.ctrlEnter = false;
  fireEvent.change(box(), { target: { value: '直接送', selectionStart: 3 } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await until(() => chatPatches().length === 2, 'with the setting off Enter sends');
});

test('an unsent draft survives switching tabs (and a reload of the tab)', async () => {
  renderChat();
  act(() => openChatPanel(LOBBY));
  await until(() => screen.queryByRole('textbox') !== null, 'the box is there');
  fireEvent.change(box(), { target: { value: '還沒寫完', selectionStart: 4 } });
  fireEvent.click(screen.getByRole('tab', { name: /私訊/ }));
  fireEvent.click(screen.getByRole('tab', { name: /動態/ }));
  await until(() => screen.queryByRole('textbox') !== null, 'the lobby box is back');
  assert.equal(box().value, '還沒寫完');
  assert.ok(sessionStorage.getItem('dhc.chatDraft:lobby')?.includes('還沒寫完'));
});

test('只回我 no longer promises that only you can see it', async () => {
  renderChat();
  act(() => openChatPanel(LOBBY));
  await until(() => screen.queryByRole('textbox') !== null, 'the box is there');
  fireEvent.change(box(), { target: { value: '@團隊小助理 你好', selectionStart: 9 } });
  await until(() => screen.queryByText(/只回我/) !== null, 'the checkbox label shows');
  const label = screen.getByText(/只回我/).textContent ?? '';
  assert.ok(label.includes('不發到動態，但資料不加密'), label);
  assert.ok(!label.includes('只有你看得到'));
});

test('each colour light on the handle says what it is', async () => {
  prefs[`dhc.chat:${dmRoom('proj-me', 'proj-x')}`] = { msgs: [{ id: 'm1', by: 'proj-x', text: '嗨', at: '2026-10-31T01:00:00Z', refs: [] }] };
  prefs['dhc.chat:lobby'] = { msgs: [{ id: 'm2', by: 'proj-x', text: '@ALL 開會', at: '2026-10-31T02:00:00Z', refs: [] }] };
  renderChat();
  act(() => setChatMe('proj-me'));
  await until(() => document.querySelectorAll('[data-light]').length === 2, 'two lights are on');
  const labels = Array.from(document.querySelectorAll('[data-light]')).map((light) => light.getAttribute('aria-label') ?? '').sort();
  assert.deepEqual(labels, ['公告 1', '私訊 1']);
  assert.match(screen.getByTestId('chat-room-handle').title, /私訊 1/);
});

test('完成 on a sticky note saves its text at once instead of after the 700 ms pause', async () => {
  const note = addNote({ target: { kind: 'session', id: 's1', title: 't' }, by: 'proj-me', text: '', refs: [], color: 'yellow', w: 200, h: 120 });
  await flushChatWrites();
  updateNote(note.id, { text: '新內容' });
  flushNote(note.id);
  await flushChatWrites();
  assert.ok(JSON.stringify(prefs['dhc.notes']).includes('新內容'));
});
