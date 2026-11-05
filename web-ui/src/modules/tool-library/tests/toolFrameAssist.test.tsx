import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageSquare } from 'lucide-react';
import React, { useState } from 'react';
import { afterEach, test, vi } from 'vitest';

import ToolFrame from '@/modules/tool-library/ToolFrame';
import { askToolAssist, assistFailureText } from '@/shared/customTools';
import type { AssistMessage } from '@/shared/customTools';

/**
 * DHC CLI 10/24 小工具 AI: the real failure reason, 停止 and closing stop the request, the waiting counter, and
 * a reply that claims a change without one.
 */

Element.prototype.scrollIntoView = () => {};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const answerWith = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

/** A fetch that never answers until aborted; records the signal it was given. */
function pendingFetch() {
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal as AbortSignal;
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  return { fetch, signals };
}

function Harness({ onResult = () => undefined, open = true }: { onResult?: (result: unknown) => string | void; open?: boolean }) {
  const [chat, setChat] = useState<AssistMessage[]>([]);
  return (
    <>
      {open && (
        <ToolFrame
          icon={MessageSquare}
          title="測試工具"
          profileName="p"
          isMobile={false}
          onClose={() => {}}
          assist={{ tool: 'doc-editor', getContext: () => ({}), onResult, chat, onChatChange: setChat, intro: '說明', busyText: 'AI 正在寫' }}
        >
          <div />
        </ToolFrame>
      )}
    </>
  );
}

const ask = (text: string) => {
  fireEvent.change(screen.getByLabelText('跟 AI 說'), { target: { value: text } });
  fireEvent.click(screen.getByLabelText('送出'));
};

test('a failure under HTTP 200 shows its reason in plain Chinese, not a generic line', async () => {
  vi.stubGlobal('fetch', answerWith({ success: false, error: { code: 'ASSIST_QUOTA', message: "You've hit your limit" } }));
  assert.equal((await askToolAssist('doc-editor', { message: 'x', context: null, chat: [] })).reply, 'AI 額度用完了，要等額度重置後再試。');
  vi.stubGlobal('fetch', answerWith({ success: false, error: { code: 'ASSIST_AUTH', message: 'Please run /login' } }));
  assert.match((await askToolAssist('doc-editor', { message: 'x', context: null, chat: [] })).reply, /登入過期/);
  assert.match(assistFailureText({ code: 'ASSIST_TIMEOUT' }), /逾時/);
  assert.match(assistFailureText({ code: 'ASSIST_FORMAT' }), /格式錯誤/);
  const long = `API Error: 500 ${'x'.repeat(200)}`;
  assert.equal(assistFailureText({ code: 'ASSIST_FAILED', message: long }), `AI 這次沒有完成。其他：${long.slice(0, 80)}`);
});

test('停止 aborts the request and says nothing was applied; the counter shows how long it has waited', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { fetch, signals } = pendingFetch();
  vi.stubGlobal('fetch', fetch);
  render(<Harness />);
  ask('補一節');
  await screen.findByText(/AI 正在寫，已等 0 秒/);
  await act(async () => { vi.advanceTimersByTime(3000); });
  screen.getByText(/已等 3 秒/);
  fireEvent.click(screen.getByLabelText('停止'));
  await screen.findByText('已停止，這次沒有套用任何修改。');
  assert.equal(signals[0].aborted, true);
  screen.getByLabelText('送出');
});

test('closing the tool while the AI is working aborts the request', async () => {
  const { fetch, signals } = pendingFetch();
  vi.stubGlobal('fetch', fetch);
  const view = render(<Harness />);
  ask('補一節');
  await waitFor(() => assert.equal(signals.length, 1));
  view.rerender(<Harness open={false} />);
  assert.equal(signals[0].aborted, true);
});

test('hiding the chat keeps the answer coming', async () => {
  const { fetch, signals } = pendingFetch();
  vi.stubGlobal('fetch', fetch);
  render(<Harness />);
  ask('補一節');
  await waitFor(() => assert.equal(signals.length, 1));
  fireEvent.click(screen.getByText('AI 對話'));
  assert.equal(signals[0].aborted, false);
});

test('a reply that claims a change with nothing to apply says so', async () => {
  const onResult = vi.fn();
  vi.stubGlobal('fetch', answerWith({ success: true, data: { reply: '已新增異常處理一節。', result: null } }));
  render(<Harness onResult={onResult} />);
  ask('補一節');
  await screen.findByText(/AI 有回覆但沒產生可套用的結果/);
  assert.equal(onResult.mock.calls.length, 0);
});

test('a lost result from the server is flagged even when the reply sounds neutral; a plain answer is not', async () => {
  vi.stubGlobal('fetch', answerWith({ success: true, data: { reply: '好的', result: null, lostResult: true } }));
  render(<Harness />);
  ask('做一個工具');
  await screen.findByText(/AI 有回覆但沒產生可套用的結果/);
  cleanup();
  vi.stubGlobal('fetch', answerWith({ success: true, data: { reply: '這份文件有三節。', result: null } }));
  render(<Harness />);
  ask('有幾節？');
  await screen.findByText('這份文件有三節。');
});
