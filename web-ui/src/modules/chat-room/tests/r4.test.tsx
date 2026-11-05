import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatRoom, { chipTool, patrolHead } from '@/modules/chat-room/ChatRoom';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import SendMenu, { chatItems } from '@/modules/tool-library/tools/SendMenu';
import {
  ASSISTANT_ID, LOBBY, TOOL_SUMMARY_CHARS, closeChatPanel, dmRoom, flushChatWrites, loadChat, openChatPanel, openToolName, toolSummary,
  useChatPanel, useLibraryRequest, useToolRequest,
} from '@/shared/chatRoom';

/**
 * 10/25 R4 (稽核 P1): tool results into the chat (貼到聊天室… / 問團隊小助理), 打開：工具名 chips, the answering role on the
 * waiting line, folded 巡查 posts, and the three start cards on the empty home page.
 */
const who = vi.hoisted(() => ({ me: 'proj-me' as string | null }));
vi.mock('@/shared/userSettings', async (original) => ({
  ...(await original<typeof import('@/shared/userSettings')>()),
  resolveSettingsProjectId: () => who.me,
}));

type Call = { method: string; url: string; body: unknown };
let prefs: Record<string, unknown>;
let calls: Call[];
let status: { running: string[]; steps: Record<string, string> };
let next: unknown;

const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  who.me = 'proj-me';
  prefs = {};
  calls = [];
  status = { running: [], steps: {} };
  next = null;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url: input, body });
    if (input === '/api/user/preferences' && method === 'GET') return json(200, { preferences: prefs });
    if (input === '/api/user/preferences' && method === 'PATCH') {
      prefs = { ...prefs, ...(body as Record<string, unknown>) };
      return json(200, { success: true });
    }
    if (input === '/api/assistant/reply') return json(202, { success: true, data: { state: 'running' } });
    if (input.startsWith('/api/assistant/status')) return json(200, { success: true, data: status });
    if (input.startsWith('/api/assistant/bots')) return json(200, { success: true, data: { enabled: false, mine: [], public: [], team: [], mentions: ['@覆核'], faces: {}, myStyle: '' } });
    if (input.startsWith('/api/assistant/cards')) return json(200, { success: true, data: { cards: [], next } });
    return json(200, {});
  }));
});

afterEach(() => {
  act(() => closeChatPanel());
});

const renderChat = () => render(<MemoryRouter><ChatRoom projects={[]} isMobile={false} /></MemoryRouter>);
async function until(check: () => boolean, label: string): Promise<void> {
  // Plain polling, never waitFor (a failing waitFor pretty-prints the whole page; see assistant.test.tsx).
  for (let i = 0; i < 40; i += 1) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  }
  assert.fail(label);
}
const msgsOf = (room: string) => ((prefs[`dhc.chat:${room}`] as { msgs?: Array<{ by: string; text: string }> } | undefined)?.msgs ?? []);

let seenTool: string | null = null;
let seenLibrary = 0;
let panelOpen = false;
function Probe() {
  seenTool = useToolRequest();
  seenLibrary = useLibraryRequest();
  panelOpen = useChatPanel().open;
  return null;
}

// ---- P1-1 小工具結果送進聊天室 ----
test('a tool summary is the tool, the title and the first 1500 characters', () => {
  assert.equal(toolSummary('試算工作台', '部位', '| a |\n| --- |\n| 1 |'), '【試算工作台】部位\n| a |\n| --- |\n| 1 |');
  assert.equal(toolSummary('文件共編', '  ', 'x'), '【文件共編】（未命名）\nx');
  const long = toolSummary('文件共編', '長文', '字'.repeat(TOOL_SUMMARY_CHARS + 20));
  assert.ok(long.includes('字'.repeat(TOOL_SUMMARY_CHARS)));
  assert.ok(!long.includes('字'.repeat(TOOL_SUMMARY_CHARS + 1)));
  assert.match(long, /後面還有 20 字沒貼/);
});

test('送到… → 問團隊小助理 sends the summary with @團隊小助理 to the private chat, asks it, and opens that chat', async () => {
  renderChat();
  render(<><Probe /><SendMenu items={chatItems('試算工作台', () => ({ title: '部位', body: '| 客戶 | 金額 |\n| --- | --- |\n| A | 10 |' }))} /></>);
  await act(async () => { await flushChatWrites(); await loadChat(); });
  fireEvent.click(screen.getByRole('button', { name: /送到/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: '問團隊小助理' }));
  const room = dmRoom('proj-me', ASSISTANT_ID);
  await until(() => calls.some((call) => call.url === '/api/assistant/reply'), 'the assistant is asked');
  const asked = msgsOf(room).at(-1)!;
  assert.equal(asked.by, 'proj-me');
  assert.match(asked.text, /^@團隊小助理 幫我看一下這份試算工作台的內容：\n【試算工作台】部位\n\| 客戶 \| 金額 \|/);
  assert.equal((calls.find((call) => call.url === '/api/assistant/reply')!.body as { roomId: string }).roomId, room);
  assert.ok(panelOpen, 'the chat opens');
  await until(() => Boolean(screen.queryByText('團隊小助理', { selector: 'span.truncate' })), 'on the private chat with 團隊小助理');
});

test('送到… → 貼到聊天室… only fills the 動態 composer; nothing is sent until 送出', async () => {
  renderChat();
  render(<SendMenu items={chatItems('專案板', () => ({ title: '十月', body: '【待辦】\n- 對帳' }))} />);
  await act(async () => { await flushChatWrites(); await loadChat(); });
  fireEvent.click(screen.getByRole('button', { name: /送到/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: '貼到聊天室…' }));
  await until(() => Boolean(screen.queryByRole('textbox')), 'the 動態 composer');
  await until(() => (screen.getByRole('textbox') as HTMLTextAreaElement).value === '【專案板】十月\n【待辦】\n- 對帳', 'the summary waits in the composer');
  assert.equal(msgsOf(LOBBY).length, 0, 'nothing posted yet');
  fireEvent.click(screen.getByRole('button', { name: '送出' }));
  await act(async () => { await flushChatWrites(); });
  assert.equal(msgsOf(LOBBY).at(-1)?.text, '【專案板】十月\n【待辦】\n- 對帳');
});

// ---- P1-2 打開：工具名 ----
test('打開：工具名 names a built tool by its catalog name; anything else is an ordinary chip', () => {
  assert.equal(openToolName('打開：試算工作台'), '試算工作台');
  assert.equal(openToolName('打開: 專案板 '), '專案板');
  assert.equal(openToolName('查昨天的'), null);
  assert.deepEqual(chipTool('打開：試算工作台'), { id: 'sheet-bench', name: '試算工作台' });
  assert.deepEqual(chipTool('打開：程式差異審閱台'), { id: 'code-review', name: '程式差異審閱台' });
  assert.equal(chipTool('打開：不存在的工具'), null);
  assert.deepEqual(chipTool('打開：規劃白板'), { id: 'plan-board', name: '規劃白板' }, 'ProjectWishPool opens its own window');
});

test('a 打開：試算工作台 chip opens that tool and closes the chat; the other chips still send', async () => {
  const room = dmRoom('proj-me', ASSISTANT_ID);
  prefs = { [`dhc.chat:${room}`]: { msgs: [
    { id: 'q1', by: 'proj-me', text: '幫我把 Excel 加總', at: new Date(Date.now() - 60_000).toISOString(), refs: [] },
    { id: 'r1', by: ASSISTANT_ID, text: '用試算工作台最快。', at: new Date(Date.now() - 50_000).toISOString(), refs: [], replyTo: 'q1' },
  ] } };
  next = { messageId: 'r1', items: ['打開：試算工作台', '直接幫我算'] };
  renderChat();
  render(<Probe />);
  act(() => openChatPanel(room));
  await act(async () => { await flushChatWrites(); await loadChat(); });
  await until(() => Boolean(screen.queryByTestId('assistant-tool-chip')), 'the tool chip');
  assert.equal(screen.getByTestId('assistant-tool-chip').textContent, '打開試算工作台');
  assert.ok(screen.getByRole('button', { name: '直接幫我算' }));
  fireEvent.click(screen.getByTestId('assistant-tool-chip'));
  assert.equal(seenTool, 'sheet-bench');
  assert.equal(panelOpen, false);
  assert.equal(msgsOf(room).length, 2, 'nothing sent');
});

// ---- P1-3 等待列顯示實際回答的人 ----
test('the waiting line shows the role that is answering, and keeps it when the step changes', async () => {
  const room = dmRoom('proj-me', ASSISTANT_ID);
  const at = new Date(Date.now() - 5_000).toISOString();
  prefs = { [`dhc.chat:${room}`]: { msgs: [{ id: 'q1', by: 'proj-me', text: '@覆核 這兩個數對嗎', at, refs: [] }] } };
  status = { running: [at], steps: { [at]: '以覆核員的角色處理' } };
  renderChat();
  act(() => openChatPanel(room));
  await act(async () => { await flushChatWrites(); await loadChat(); });
  await until(() => Boolean(screen.queryByTestId('assistant-thinking')), 'the waiting line');
  await until(() => /覆核員 正在處理/.test(screen.getByTestId('assistant-thinking').textContent!), 'the role name');
  assert.ok(screen.getAllByTestId('assistant-avatar').some((face) => face.textContent === '覆'), 'the role face');
  status = { running: [at], steps: { [at]: '在 DB2 跑指令' } };
  await until(() => /覆核員 正在在 DB2 跑指令/.test(screen.getByTestId('assistant-thinking').textContent!), 'still the role after a later step');
});

// ---- P1-4 巡查貼文摺疊 ----
test('patrolHead keeps the title line and the conclusion; short or other posts are not folded', () => {
  assert.equal(patrolHead('【巡查】晨間值班報\n**整體正常**\n| 主機 | 狀態 |\n| --- | --- |\n| DB2 | 正常 |'), '【巡查】晨間值班報\n整體正常');
  assert.equal(patrolHead('【巡查】晨間值班報\n## 有 1 台異常\n- X1 查不到'), '【巡查】晨間值班報\n有 1 台異常');
  assert.equal(patrolHead('【巡查】晨間值班報 這次沒跑成：額度用完'), null);
  assert.equal(patrolHead('【巡查】晨間值班報\n整體正常'), null);
  assert.equal(patrolHead('一般回覆\n第二行\n第三行'), null);
});

test('a long 巡查 post in 動態 shows two lines and 展開全文; 收起 folds it again', async () => {
  prefs = { [`dhc.chat:${LOBBY}`]: { msgs: [{ id: 'p1', by: ASSISTANT_ID, text: '【巡查】晨間值班報\n整體正常\n| 主機 | 狀態 |\n| --- | --- |\n| DB2 | 正常 |\n| X1 | 正常 |', at: new Date(Date.now() - 60_000).toISOString(), refs: [] }] } };
  renderChat();
  act(() => openChatPanel(LOBBY));
  await act(async () => { await flushChatWrites(); await loadChat(); });
  await until(() => Boolean(screen.queryByTestId('patrol-folded')), 'folded');
  assert.match(screen.getByTestId('patrol-folded').textContent!, /^【巡查】晨間值班報\n整體正常展開全文$/);
  assert.equal(document.querySelector('table'), null, 'the table is hidden');
  fireEvent.click(screen.getByRole('button', { name: '展開全文' }));
  assert.ok(document.querySelector('table'), 'the whole report');
  fireEvent.click(screen.getByRole('button', { name: '收起' }));
  assert.ok(screen.getByTestId('patrol-folded'));
});

// ---- P1-5 首頁空狀態 ----
test('the empty home page offers 問團隊小助理, 打開工具庫 and 選專案開對話, and each one does something', async () => {
  renderChat();
  const onMenuClick = vi.fn();
  render(<><Probe /><WorkspaceStateView mode="empty" isMobile={false} onMenuClick={onMenuClick} /></>);
  const cards = screen.getByTestId('start-cards');
  assert.deepEqual([...cards.querySelectorAll('button')].map((button) => button.getAttribute('data-start')), ['assistant', 'library', 'project']);
  fireEvent.click(cards.querySelector('[data-start="assistant"]')!);
  assert.ok(panelOpen, 'the chat opens');
  await until(() => Boolean(screen.queryByText('團隊小助理', { selector: 'span.truncate' })), 'on the private chat with 團隊小助理');
  act(() => closeChatPanel());
  fireEvent.click(cards.querySelector('[data-start="library"]')!);
  assert.ok(seenLibrary > 0, '工具庫 is asked for');
  fireEvent.click(cards.querySelector('[data-start="project"]')!);
  assert.equal(onMenuClick.mock.calls.length, 1);
});
