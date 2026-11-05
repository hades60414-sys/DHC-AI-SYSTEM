import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatRoom from '@/modules/chat-room/ChatRoom';
import { ASSISTANT_ID, closeChatPanel, dmRoom, loadChat, openChatPanel } from '@/shared/chatRoom';

vi.mock('@/shared/userSettings', async (original) => ({
  ...(await original<typeof import('@/shared/userSettings')>()),
  resolveSettingsProjectId: () => 'proj-me',
}));

type Call = { method: string; url: string; body: unknown };
let prefs: Record<string, unknown>;
let running: string[];
let trail: Record<string, unknown>;
let examples: string[] | null;
let calls: Call[];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  prefs = {};
  running = [];
  trail = {};
  examples = [];
  calls = [];
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
    if (input.startsWith('/api/assistant/status')) return json(200, { success: true, data: { running, steps: {}, trail } });
    if (input === '/api/assistant/examples') return examples ? json(200, { success: true, data: { examples } }) : json(404, {});
    if (input.startsWith('/api/assistant/bots')) return json(200, { success: true, data: { enabled: false, mentions: [] } });
    if (input.startsWith('/api/assistant/cards')) return json(200, { success: true, data: { cards: [], next: null } });
    return json(200, {});
  }));
});

afterEach(() => {
  act(() => closeChatPanel());
});

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  }
  assert.fail(label);
}

const renderChat = () => render(<MemoryRouter><ChatRoom projects={[]} isMobile={false} /></MemoryRouter>);

test('the running answer lists its steps with a marker per state', async () => {
  const room = dmRoom('proj-me', ASSISTANT_ID);
  const q = { id: 'q1', by: 'proj-me', text: '查一下', at: '2026-11-02T07:00:00.000Z', refs: [] };
  prefs = { [`dhc.chat:${room}`]: { msgs: [q] } };
  running = [q.at];
  trail = { [q.at]: [
    { label: '讀檔', state: 'done' },
    { label: '連線', state: 'failed' },
    { label: '查部位', state: 'empty' },
    { label: '算損益', state: 'now' },
  ] };
  renderChat();
  await act(async () => { await loadChat(); });
  act(() => openChatPanel(room));
  await until(() => Boolean(document.querySelector('[data-testid="assistant-trail"]')), 'the trail is shown');
  const items = [...document.querySelectorAll('[data-testid="assistant-trail"] li')].map((li) => li.textContent);
  assert.deepEqual(items, ['✓ 讀檔', '✗ 連線', '∅ 查部位 無結果', '• 算損益']);
  assert.ok(document.querySelector('[data-testid="assistant-trail"] li:nth-child(2)')?.className.includes('rose'));
  assert.ok(document.querySelector('[data-testid="assistant-trail"] li:nth-child(3)')?.className.includes('amber'));
  assert.ok(screen.getByRole('button', { name: /停止/ }), '停止 stays');
});

test('no trail, no list', async () => {
  const room = dmRoom('proj-me', ASSISTANT_ID);
  const q = { id: 'q1', by: 'proj-me', text: '查一下', at: '2026-11-02T07:00:00.000Z', refs: [] };
  prefs = { [`dhc.chat:${room}`]: { msgs: [q] } };
  running = [q.at];
  renderChat();
  await act(async () => { await loadChat(); });
  act(() => openChatPanel(room));
  await until(() => calls.some((call) => call.url.startsWith('/api/assistant/status')), 'polled');
  await until(() => !document.querySelector('[data-testid="assistant-trail"]'), 'the earlier trail is gone');
  assert.ok(document.querySelector('[data-testid="assistant-thinking"]'), 'still thinking');
});

test('試著問 chips send the example to the assistant', async () => {
  const room = dmRoom('proj-me', ASSISTANT_ID);
  examples = ['查昨天的部位', '本月損益多少'];
  renderChat();
  act(() => openChatPanel(room));
  await until(() => Boolean(document.querySelector('[data-testid="assistant-examples"]')), 'examples shown');
  assert.ok(document.querySelector('[data-testid="assistant-examples"]')?.textContent?.includes('試著問：'));
  assert.ok(screen.getByRole('button', { name: '查資料庫範例' }), 'starters stay');
  fireEvent.click(screen.getByRole('button', { name: '本月損益多少' }));
  await until(() => calls.some((call) => call.url === '/api/assistant/reply'), 'asked');
  const asked = calls.find((call) => call.url === '/api/assistant/reply')!.body as { roomId: string; triggerAt: string };
  assert.equal(asked.roomId, room);
  const sent = (prefs[`dhc.chat:${room}`] as { msgs: Array<{ text: string; at: string }> }).msgs.find((m) => m.at === asked.triggerAt);
  assert.equal(sent?.text, '本月損益多少');
});

test('examples endpoint missing: no 試著問 row', async () => {
  const room = dmRoom('proj-me', ASSISTANT_ID);
  examples = null;
  renderChat();
  act(() => openChatPanel(room));
  await screen.findByRole('button', { name: '查資料庫範例' });
  await until(() => calls.some((call) => call.url === '/api/assistant/examples'), 'fetched');
  assert.ok(!document.querySelector('[data-testid="assistant-examples"]'));
});
