import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { OFFLINE_TEXT, SAY } from '@/modules/voice-call/callMachine';
import { VOICE_SYSTEM_NOTE } from '@/modules/voice-call/config';
import { SttStartError, type EngineFactory, type SttHandlers } from '@/modules/voice-call/engines';
import { useVoiceCall } from '@/modules/voice-call/useVoiceCall';
import type { ServerEvent } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  api: { voice: { health: () => Promise.resolve({ ok: true, json: async () => ({ configured: true, callStt: true }) }) } },
  transcribeVoice: () => Promise.reject(new Error('not used')),
  synthesizeVoice: () => Promise.reject(new Error('not used')),
}));

/** Fake engines: the test plays the user (STT) and the speaker (TTS). */
function fakeEngines(options: { startError?: Error } = {}) {
  const log: string[] = [];
  const spoken: string[] = [];
  let handlers: SttHandlers | null = null;
  let finishSpeech: (() => void) | null = null;
  let holdSpeech = false;
  const engines: EngineFactory = {
    stt: () => ({
      start: async (h) => {
        if (options.startError) throw options.startError;
        handlers = h;
        log.push('stt:start');
      },
      pause: () => log.push('stt:pause'),
      guard: () => log.push('stt:guard'),
      resume: () => log.push('stt:resume'),
      stop: () => log.push('stt:stop'),
    }),
    tts: () => ({
      speak: (text, onAudible) => {
        spoken.push(text);
        onAudible?.();
        return holdSpeech ? new Promise<void>((resolve) => { finishSpeech = resolve; }) : Promise.resolve();
      },
      cancel: () => {
        log.push('tts:cancel');
        finishSpeech?.();
        finishSpeech = null;
      },
    }),
  };
  return {
    engines,
    log,
    spoken,
    say: (text: string, at = Date.now()) => handlers!.onFinal(text, at),
    bargeIn: () => handlers!.onBargeIn(),
    holdSpeech: (hold: boolean) => { holdSpeech = hold; },
    finishSpeech: () => { finishSpeech?.(); finishSpeech = null; },
  };
}

function fakeBus() {
  const listeners = new Set<(frame: ServerEvent, sid: string | null) => void>();
  return {
    emit: (frame: ServerEvent, sid: string | null) => listeners.forEach((l) => l(frame, sid)),
    subscribe: (l: (frame: ServerEvent, sid: string | null) => void) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
  };
}

type Sent = { text: string; clientRequestId: string; systemNote: string };

function setup(overrides: { isLoading?: boolean; startError?: Error; sessionId?: string | null } = {}) {
  const fake = fakeEngines({ startError: overrides.startError });
  const bus = fakeBus();
  const sent: Sent[] = [];
  let aborts = 0;
  const view = renderHook((props: { sessionId: string | null; isLoading: boolean }) => useVoiceCall({
    sessionId: props.sessionId,
    isLoading: props.isLoading,
    sendTurn: async (turn) => {
      sent.push(turn);
      return 's1';
    },
    abort: () => { aborts += 1; },
    confirmCloud: async () => true,
    engines: fake.engines,
    bus,
  }), { initialProps: { sessionId: overrides.sessionId === undefined ? 's1' : overrides.sessionId, isLoading: overrides.isLoading ?? false } });
  const frame = (f: ServerEvent) => act(() => { bus.emit(f, 's1'); });
  return { view, fake, bus, sent, frame, aborts: () => aborts };
}

const settle = (ms = 0) => act(() => new Promise((resolve) => { setTimeout(resolve, ms); }));

beforeEach(() => {
  localStorage.clear();
});

async function startCall(ctx: ReturnType<typeof setup>) {
  act(() => { ctx.view.result.current.start(); });
  await waitFor(() => assert.equal(ctx.view.result.current.call.lifecycle, 'live'));
}

test('an utterance is sent once through the composer with its clientRequestId and the voice instructions', async () => {
  const ctx = setup();
  await startCall(ctx);
  await act(async () => { ctx.fake.say('查一下昨天 2330 的部位'); });
  await settle();

  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].text, '查一下昨天 2330 的部位');
  assert.equal(ctx.sent[0].systemNote, VOICE_SYSTEM_NOTE);
  const turn = ctx.view.result.current.call.turns[0];
  assert.equal(turn.id, ctx.sent[0].clientRequestId);
  assert.equal(turn.status, 'running');

  await ctx.frame({ kind: 'stream_delta', content: '查好了，部位正常。' });
  await ctx.frame({ kind: 'complete', success: true, aborted: false });
  await settle(300);
  assert.deepEqual(ctx.fake.spoken, ['查好了，部位正常。']);
  assert.equal(ctx.view.result.current.call.turns[0].status, 'done');
  assert.ok(ctx.view.result.current.metrics[0].firstAudioMs !== undefined, 'latency to first audio is measured');
});

test('while the speaker plays, recognition is paused and anything heard is not sent; barge-in resumes listening', async () => {
  const ctx = setup();
  await startCall(ctx);
  await act(async () => { ctx.fake.say('問一下'); });
  await settle();
  ctx.fake.holdSpeech(true);
  await ctx.frame({ kind: 'stream_delta', content: '這是一段很長的回覆。' });
  await settle();
  assert.equal(ctx.view.result.current.phase, 'speaking');
  assert.ok(ctx.fake.log.includes('stt:pause'));

  await act(async () => { ctx.fake.say('這是一段很長的回覆'); });
  await settle();
  assert.equal(ctx.sent.length, 1, 'the echo of the reply is not a new turn');

  act(() => { ctx.view.result.current.bargeIn(); });
  await settle(300);
  assert.ok(ctx.fake.log.includes('tts:cancel'));
  assert.ok(ctx.fake.log.lastIndexOf('stt:resume') > ctx.fake.log.lastIndexOf('stt:pause'));
  assert.notEqual(ctx.view.result.current.phase, 'speaking');
  assert.equal(ctx.aborts(), 0, 'barge-in never cancels the task');
});

test('speaking over the reply stops it at once and the sentence is sent; the rest of the reply stays silent', async () => {
  const ctx = setup();
  await startCall(ctx);
  await act(async () => { ctx.fake.say('報表重點是什麼'); });
  await settle();
  ctx.fake.holdSpeech(true);
  await ctx.frame({ kind: 'stream_delta', content: '重點有三個。第一個是部位。' });
  await settle();
  assert.equal(ctx.view.result.current.phase, 'speaking');
  assert.ok(ctx.fake.log.includes('stt:guard'), 'the mic keeps listening for a barge-in while the reply plays');

  act(() => { ctx.fake.bargeIn(); });
  await settle(300);
  assert.ok(ctx.fake.log.includes('tts:cancel'));
  assert.notEqual(ctx.view.result.current.phase, 'speaking');
  const spokenBefore = ctx.fake.spoken.length;

  await ctx.frame({ kind: 'stream_delta', content: '第二個是損益。' });
  await settle(300);
  assert.equal(ctx.fake.spoken.length, spokenBefore, 'the interrupted reply does not start again');

  await act(async () => { ctx.fake.say('等一下，只講部位'); });
  await settle();
  assert.deepEqual(ctx.sent.map((s) => s.text), ['報表重點是什麼', '等一下，只講部位']);
  assert.equal(ctx.aborts(), 0, 'talking over the reply never cancels the task');
});

test('cancelling a running task by voice sends chat.abort only after a yes, then reports what abort means', async () => {
  const ctx = setup({ isLoading: true });
  await startCall(ctx);
  await waitFor(() => assert.equal(ctx.view.result.current.phase, 'working'));

  await act(async () => { ctx.fake.say('取消剛剛的任務'); });
  await settle(300);
  assert.equal(ctx.aborts(), 0);
  assert.ok(ctx.fake.spoken.includes(SAY.confirmCancel));

  await act(async () => { ctx.fake.say('確定'); });
  await settle();
  assert.equal(ctx.aborts(), 1);

  await ctx.frame({ kind: 'complete', success: false, aborted: true });
  await settle(300);
  assert.ok(ctx.fake.spoken.includes(SAY.cancelled));
  assert.equal(ctx.sent.length, 0, 'none of the commands went to the agent');
});

test('an abort the composer could not send is reported instead of going quiet', async () => {
  const ctx = setup({ isLoading: true });
  await startCall(ctx);
  await waitFor(() => assert.equal(ctx.view.result.current.phase, 'working'));
  await act(async () => { ctx.fake.say('取消任務'); });
  await settle(300);
  await act(async () => { ctx.fake.say('對，確定。'); });
  await settle();
  assert.equal(ctx.aborts(), 1);
  await settle(10_300);
  assert.ok(ctx.fake.spoken.some((line) => line.includes('取消沒有送出')), 'no aborted complete arrived, so the call says the task may still run');
}, 15_000);

test('a run that fails on quota is spoken and shown with the text path still usable', async () => {
  const ctx = setup();
  await startCall(ctx);
  await act(async () => { ctx.fake.say('跑月報'); });
  await settle();
  await ctx.frame({ kind: 'error', content: 'Claude AI usage limit reached' });
  await ctx.frame({ kind: 'complete', success: false, aborted: false });
  await settle(300);
  assert.ok(ctx.fake.spoken.includes(SAY.quota));
  assert.equal(ctx.view.result.current.call.notice?.text, SAY.quota);
  assert.equal(ctx.view.result.current.call.turns[0].status, 'failed');
});

test('a duplicate notice from the server keeps the original turn and status', async () => {
  const ctx = setup();
  await startCall(ctx);
  await act(async () => { ctx.fake.say('跑月報'); });
  await settle();
  const id = ctx.sent[0].clientRequestId;
  await ctx.frame({ kind: 'chat_send_duplicate', clientRequestId: id, sessionId: 's1' });
  assert.equal(ctx.view.result.current.call.turns.length, 1);
  assert.equal(ctx.view.result.current.call.turns[0].status, 'running');
});

test('a permission prompt is announced and the call waits for the on-screen answer', async () => {
  const ctx = setup();
  await startCall(ctx);
  await act(async () => { ctx.fake.say('把暫存檔刪掉'); });
  await settle();
  await ctx.frame({ kind: 'permission_request', requestId: 'p1', toolName: 'Bash' });
  await settle(300);
  assert.equal(ctx.view.result.current.phase, 'awaiting_confirm');
  assert.ok(ctx.fake.spoken.includes(SAY.permission));
  await ctx.frame({ kind: 'permission_resolved', requestId: 'p1' });
  assert.equal(ctx.view.result.current.phase, 'working');
});

test('a denied microphone ends the call with a clear message', async () => {
  const ctx = setup({ startError: new SttStartError('mic_denied') });
  act(() => { ctx.view.result.current.start(); });
  await waitFor(() => assert.equal(ctx.view.result.current.phase, 'error'));
  assert.match(ctx.view.result.current.call.notice!.text, /麥克風權限被拒絕/);
});

test('going offline stops the call and says the text path still works', async () => {
  const ctx = setup();
  await startCall(ctx);
  act(() => { window.dispatchEvent(new Event('offline')); });
  assert.equal(ctx.view.result.current.phase, 'error');
  assert.equal(ctx.view.result.current.call.notice?.text, OFFLINE_TEXT);
  assert.ok(ctx.fake.log.includes('stt:stop'));
});

test('opening another conversation ends the call instead of talking into it', async () => {
  const ctx = setup();
  await startCall(ctx);
  ctx.view.rerender({ sessionId: 's2', isLoading: false });
  assert.equal(ctx.view.result.current.phase, 'off');
  assert.match(ctx.view.result.current.call.notice!.text, /切換到別的對話/);
});

test('starting a new chat (no session id) ends the call bound to the old one', async () => {
  const ctx = setup();
  await startCall(ctx);
  ctx.view.rerender({ sessionId: null, isLoading: false });
  assert.equal(ctx.view.result.current.phase, 'off');
  assert.match(ctx.view.result.current.call.notice!.text, /切換到別的對話/);
});

test('a call started in a new chat is not ended when its own first turn allocates the session', async () => {
  const ctx = setup({ sessionId: null });
  await startCall(ctx);
  ctx.view.rerender({ sessionId: 's1', isLoading: false });
  assert.notEqual(ctx.view.result.current.phase, 'off');
});

test('frames from other sessions are ignored', async () => {
  const ctx = setup();
  await startCall(ctx);
  await act(async () => { ctx.fake.say('問'); });
  await settle();
  act(() => { ctx.bus.emit({ kind: 'complete', success: true }, 'other-session'); });
  assert.equal(ctx.view.result.current.call.turns[0].status, 'running');
});

test('the e2e snapshot hook exposes phase and turn latencies', async () => {
  const ctx = setup();
  await startCall(ctx);
  const snap = window.__dhcVoiceCall?.snapshot() as { phase: string; fastWhisper: boolean } | undefined;
  assert.equal(snap?.phase, 'listening');
  assert.equal(snap?.fastWhisper, true, 'the fast call recognizer reported by /api/voice/health is used');
});
