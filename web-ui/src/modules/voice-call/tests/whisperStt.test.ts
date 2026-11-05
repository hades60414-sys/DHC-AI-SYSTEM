import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { WhisperStt } from '@/modules/voice-call/engines/whisperStt';
import type { SttHandlers } from '@/modules/voice-call/engines/types';

const uploads: Array<{ blob: Blob; name: string; durationMs?: number }> = [];

vi.mock('@/shared/api', () => ({
  transcribeVoice: (blob: Blob, name: string, _profile: string, durationMs?: number) => {
    uploads.push({ blob, name, durationMs });
    return Promise.resolve({ ok: true, json: async () => ({ text: '等一下，只講部位' }) });
  },
}));

const RATE = 48_000;
const FRAME = 2048;
const FRAME_MS = (FRAME / RATE) * 1000;

let processor: { onaudioprocess: ((e: unknown) => void) | null } | null = null;
let clock = 0;

class FakeAudioContext {
  sampleRate = RATE;
  destination = {};
  resume = () => Promise.resolve();
  close = () => Promise.resolve();
  createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
  createGain = () => ({ gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined });
  createScriptProcessor = () => {
    processor = { onaudioprocess: null, connect: () => undefined, disconnect: () => undefined } as never;
    return processor;
  };
}

/** 餵 ms 毫秒、音量 rms 的 200 Hz 方波。 */
function play(rms: number, ms: number) {
  const end = clock + ms;
  while (clock < end) {
    const data = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) data[i] = Math.floor(i / 120) % 2 ? rms : -rms;
    vi.setSystemTime(clock);
    processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => data } });
    clock += FRAME_MS;
  }
  return clock;
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function echo(ms: number) {
  for (let t = 0; t < ms; t += 300) {
    play(t % 1500 === 900 ? 0.09 : 0.06, 220);
    play(0.015, 80);
  }
}

beforeEach(() => {
  uploads.length = 0;
  clock = 1_000_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function recorder() {
  const calls: string[] = [];
  const finals: string[] = [];
  let bargeAt: number | null = null;
  const handlers: SttHandlers = {
    onPartial: () => undefined,
    onSpeechEnd: () => calls.push('speech_end'),
    onBargeIn: () => {
      calls.push('barge_in');
      bargeAt = Date.now();
    },
    onFinal: (text) => finals.push(text),
    onNoSpeech: () => undefined,
    onError: (message) => calls.push(`error:${message}`),
  };
  return { handlers, calls, finals, bargeAt: () => bargeAt };
}

test('while the reply plays, its echo is never sent; the user cutting in fires within half a second and the whole sentence, start included, is transcribed', async () => {
  const stt = new WhisperStt({ maxUtteranceSec: 60, timeoutSec: 45, bargeInSensitivity: 'medium' });
  const rec = recorder();
  await stt.start(rec.handlers);
  stt.guard();

  echo(3000);
  assert.deepEqual(rec.calls, [], 'echo alone triggers nothing');
  assert.equal(uploads.length, 0);

  const userStart = clock;
  play(0.25, 1200);
  assert.deepEqual(rec.calls, ['barge_in']);
  assert.ok(rec.bargeAt()! - userStart <= 500, `stopped ${rec.bargeAt()! - userStart} ms after the user started`);

  stt.resume();
  play(0.003, 1600);
  assert.deepEqual(rec.calls, ['barge_in', 'speech_end']);
  await vi.waitFor(() => assert.deepEqual(rec.finals, ['等一下，只講部位']));

  const { blob, name } = uploads[0];
  assert.equal(name, 'call.wav');
  const bytes = await readBlob(blob);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  const pcm = new Int16Array(bytes.slice(44));
  const firstVoice = pcm.findIndex((v) => Math.abs(v) > 0.2 * 0x7fff);
  const prerollMs = (firstVoice / 16_000) * 1000;
  assert.ok(prerollMs >= 250, `the clip starts ${Math.round(prerollMs)} ms before the user's voice, so the first syllable is kept`);
  stt.stop();
});

test('when paused (barge-in off or muted) nothing the mic hears is used', async () => {
  const stt = new WhisperStt({ maxUtteranceSec: 60, timeoutSec: 45 });
  const rec = recorder();
  await stt.start(rec.handlers);
  stt.pause();
  play(0.25, 1500);
  play(0.003, 1000);
  assert.deepEqual(rec.calls, []);
  assert.equal(uploads.length, 0);
  stt.stop();
});

test('normal listening sends a sentence after 1.5 s of quiet, not at a 1 s breath', async () => {
  const stt = new WhisperStt({ maxUtteranceSec: 60, timeoutSec: 45 });
  const rec = recorder();
  await stt.start(rec.handlers);
  play(0.002, 600);
  play(0.05, 900);
  play(0.002, 1000);
  assert.deepEqual(rec.calls, []);
  play(0.05, 300);
  play(0.002, 1600);
  assert.deepEqual(rec.calls, ['speech_end']);
  await vi.waitFor(() => assert.equal(rec.finals.length, 1));
  stt.stop();
});
