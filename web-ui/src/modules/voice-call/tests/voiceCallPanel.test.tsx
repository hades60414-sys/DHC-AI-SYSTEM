import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { SttHandlers } from '@/modules/voice-call/engines';
import VoiceCallPanel from '@/modules/voice-call/VoiceCallPanel';
import { voiceCallBus } from '@/modules/voice-call/voiceCallBus';

vi.mock('@/shared/api', () => ({
  api: { voice: { health: () => Promise.resolve({ ok: true, json: async () => ({ configured: true, callStt: true }) }) } },
  transcribeVoice: () => Promise.reject(new Error('not used')),
  synthesizeVoice: () => Promise.reject(new Error('not used')),
}));

/** 測試扮演使用者（辨識結果）與喇叭（朗讀立刻念完）。 */
const fake = vi.hoisted(() => ({ handlers: null as SttHandlers | null, startError: null as Error | null }));

vi.mock('@/modules/voice-call/engines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/voice-call/engines')>();
  return {
    ...actual,
    defaultEngines: {
      stt: () => ({
        start: async (h: SttHandlers) => {
          if (fake.startError) throw fake.startError;
          fake.handlers = h;
        },
        pause: () => undefined,
        guard: () => undefined,
        resume: () => undefined,
        stop: () => undefined,
      }),
      tts: () => ({
        speak: async (_text: string, onAudible?: () => void) => { onAudible?.(); },
        cancel: () => undefined,
      }),
    },
  };
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('dhc-voice-call-config', JSON.stringify({ stt: 'whisper' }));
  fake.handlers = null;
  fake.startError = null;
});

const settle = (ms = 0) => act(() => new Promise((resolve) => { setTimeout(resolve, ms); }));

async function openPanel() {
  const closed = { count: 0 };
  await act(async () => {
    render(
      <VoiceCallPanel
        sessionId="s1"
        sendTurn={async () => 's1'}
        isLoading={false}
        onAbort={() => undefined}
        confirmCloud={async () => true}
        whisperReady
        onClose={() => { closed.count += 1; }}
      />,
    );
  });
  return closed;
}

async function openLiveCall() {
  const closed = await openPanel();
  await waitFor(() => assert.ok(fake.handlers, 'recognition started'));
  return closed;
}

const say = async (text: string) => {
  await act(async () => { fake.handlers!.onFinal(text, Date.now()); });
  await settle();
};
const reply = async (text: string) => {
  await act(async () => { voiceCallBus.emit({ kind: 'stream_delta', content: text }, 's1'); });
  await settle();
};
const replyBox = () => screen.getByTestId('voice-call-reply').textContent ?? '';

test('the reply box shows only the latest answer, next to what was heard', async () => {
  await openLiveCall();
  await say('這是測試，回覆收到就好');
  assert.equal(screen.getByTestId('voice-call-heard').textContent, '你這是測試，回覆收到就好');
  await reply('收到。');
  assert.equal(replyBox(), '收到。');

  await act(async () => { voiceCallBus.emit({ kind: 'complete', success: true, aborted: false }, 's1'); });
  await waitFor(() => assert.equal(screen.getByTestId('voice-call-phase').textContent, '聆聽中'));
  await say('幫我看一下今天的部位');
  assert.doesNotMatch(replyBox(), /收到。/, 'the previous answer is cleared when a new question goes out');
  await reply('第二次的回覆。');
  assert.equal(replyBox(), '第二次的回覆。');
});

test('mute, interrupt, and hang up are the only call buttons; hang up closes the panel', async () => {
  const closed = await openLiveCall();
  const mute = screen.getByRole('button', { name: '靜音' });
  act(() => { mute.click(); });
  assert.equal(screen.getByRole('button', { name: '取消靜音' }).getAttribute('aria-pressed'), 'true');
  assert.equal((screen.getByRole('button', { name: '插話' }) as HTMLButtonElement).disabled, true, 'nothing to interrupt while silent');
  act(() => { screen.getByRole('button', { name: '掛斷' }).click(); });
  assert.equal(closed.count, 1);
});

test('settings start folded; the gear reveals engine, voice speed, and barge-in controls', async () => {
  await openLiveCall();
  assert.equal(screen.queryByTestId('voice-call-settings'), null);
  assert.equal(screen.queryByText(/錄音不存檔/), null, 'no explanatory text on the main view');
  act(() => { screen.getByLabelText('通話設定').click(); });
  assert.ok(screen.getByTestId('voice-call-settings'));
  const bargeIn = screen.getByLabelText(/開口就打斷朗讀/) as HTMLInputElement;
  assert.equal(bargeIn.checked, true);
  fireEvent.change(screen.getByLabelText(/^插話靈敏度/), { target: { value: 'high' } });
  assert.equal(JSON.parse(localStorage.getItem('dhc-voice-call-config') ?? '{}').bargeInSensitivity, 'high');
  act(() => { bargeIn.click(); });
  assert.equal(screen.queryByLabelText(/^插話靈敏度/), null, 'sensitivity hides when barge-in is off');
  assert.ok(screen.getByText(/錄音不存檔/));
});

test('when the call cannot start the panel says why and offers restart and close', async () => {
  const { SttStartError } = await import('@/modules/voice-call/engines');
  fake.startError = new SttStartError('no_mic');
  const closed = await openPanel();
  await waitFor(() => assert.equal(screen.getByTestId('voice-call-phase').textContent, '錯誤'));
  assert.ok((screen.getByTestId('voice-call-notice').textContent ?? '').length > 0);
  assert.ok(screen.getByRole('button', { name: '重新開始' }));
  act(() => { screen.getByLabelText('關閉通話面板').click(); });
  assert.equal(closed.count, 1);
});
