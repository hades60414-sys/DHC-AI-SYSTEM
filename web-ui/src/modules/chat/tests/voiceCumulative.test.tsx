import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { assembleResults, mergeSegment } from '@/modules/chat/hooks/voiceMode';
import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';

vi.mock('@/shared/api', () => ({ transcribeVoice: vi.fn(), api: {} }));

class Fake {
  static all: Fake[] = [];
  lang = ''; continuous = false; interimResults = false;
  onresult: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() { Fake.all.push(this); }
  start() { this.started = true; }
  stop() { this.onend?.(); }
  abort() {}
}
const cur = () => Fake.all[Fake.all.length - 1];
const seg = (transcript: string, isFinal: boolean) => Object.assign([{ transcript }], { isFinal });
const emit = (rec: Fake, segs: Array<[string, boolean]>, resultIndex = 0) =>
  act(() => { rec.onresult?.({ resultIndex, results: segs.map(([t, f]) => seg(t, f)) }); });

beforeEach(() => {
  Fake.all = [];
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) }, configurable: true,
  });
  (window as any).webkitSpeechRecognition = Fake;
});
afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  delete (window as any).webkitSpeechRecognition;
});

async function setup() {
  const onTranscript = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => useVoiceInput(onTranscript, onError, { mode: 'cloud', confirmCloud: () => Promise.resolve(true) }));
  await act(async () => { hook.result.current.toggle(); });
  return { ...hook, onTranscript, onError };
}

test('mergeSegment：累積、大小寫差異、重複尾段', () => {
  assert.equal(mergeSegment('', '你好'), '你好');
  assert.equal(mergeSegment('我覺得OK', '我覺得ok但是'), '我覺得ok但是');
  assert.equal(mergeSegment('你好嗎', '嗎'), '你好嗎');
  assert.equal(mergeSegment('你好', '再見'), '你好再見');
});

test('assembleResults：interim 取代、final 只算一次', () => {
  const r = [seg('甲', true), seg('乙', false), seg('乙丙', false)];
  assert.deepEqual(assembleResults(r), { final: '甲', live: '乙丙' });
});

test('Android 累積式 final：結果只有最後一句，不重複', async () => {
  const { result, onTranscript } = await setup();
  const rec = cur();
  emit(rec, [['我測試完錄音功能我覺得OK', true]]);
  emit(rec, [['我測試完錄音功能我覺得OK', true], ['我測試完錄音功能我覺得ok但是他只要一停下', true]], 1);
  emit(rec, [
    ['我測試完錄音功能我覺得OK', true],
    ['我測試完錄音功能我覺得ok但是他只要一停下', true],
    ['我測試完錄音功能我覺得ok但是他只要一停下就會直接停止', false],
  ], 2);
  assert.equal(result.current.interim, '我測試完錄音功能我覺得ok但是他只要一停下就會直接停止');
  emit(rec, [
    ['我測試完錄音功能我覺得OK', true],
    ['我測試完錄音功能我覺得ok但是他只要一停下', true],
    ['我測試完錄音功能我覺得ok但是他只要一停下就會直接停止', true],
  ], 2);
  await act(async () => { result.current.toggle(); });
  assert.deepEqual(onTranscript.mock.calls, [['我測試完錄音功能我覺得ok但是他只要一停下就會直接停止', false]]);
});

test('停頓 onend 後自動重啟；新 session 含舊文字也只出現一次；點擊才結束', async () => {
  const { result, onTranscript } = await setup();
  const r1 = cur();
  emit(r1, [['我測試完', true]]);
  act(() => { r1.onend?.(); }); // 瀏覽器因靜音自己結束
  assert.equal(Fake.all.length, 2);
  assert.equal(cur().started, true);
  assert.equal(result.current.state, 'recording');
  assert.equal(onTranscript.mock.calls.length, 0);
  const r2 = cur();
  emit(r2, [['我測試完錄音功能', true]]); // 新 session 重述舊文字
  act(() => { r2.onend?.(); });
  const r3 = cur();
  assert.equal(Fake.all.length, 3);
  emit(r3, [['但是不要停', true]]);
  await act(async () => { result.current.toggle(); });
  assert.equal(Fake.all.length, 3); // 使用者停止不再重啟
  assert.deepEqual(onTranscript.mock.calls, [['我測試完錄音功能但是不要停', false]]);
  assert.equal(result.current.state, 'idle');
});

test('致命錯誤（not-allowed）不重啟，避免無限迴圈', async () => {
  const { result, onError } = await setup();
  const rec = cur();
  act(() => { rec.onerror?.({ error: 'not-allowed' }); rec.onend?.(); });
  assert.equal(Fake.all.length, 1);
  assert.equal(result.current.state, 'idle');
  assert.equal(onError.mock.calls.length, 1);
});

test('連續立刻結束且沒結果：最多重啟數次後放棄', async () => {
  const { result } = await setup();
  for (let i = 0; i < 20 && result.current.state === 'recording'; i++) act(() => { cur().onend?.(); });
  assert.equal(result.current.state, 'idle');
  assert.ok(Fake.all.length <= 6);
});

// ---- 6 秒靜音自動停止 ----
test('雲端：停 5 秒再說 → 繼續；停 6 秒 → 只停一次並填入文字', async () => {
  vi.useFakeTimers();
  try {
    const { result, onTranscript } = await setup();
    const rec = cur();
    emit(rec, [['你好', true]]);
    act(() => { vi.advanceTimersByTime(5000); });
    assert.equal(result.current.state, 'recording');
    emit(rec, [['你好', true], ['再說一句', false]]); // 5 秒後又有新語音，計時重來
    act(() => { vi.advanceTimersByTime(5000); });
    assert.equal(result.current.state, 'recording');
    act(() => { rec.onend?.(); }); // 自動重啟後計時不重置
    assert.equal(Fake.all.length, 2);
    act(() => { vi.advanceTimersByTime(1000); });
    assert.equal(result.current.state, 'idle');
    assert.deepEqual(onTranscript.mock.calls, [['你好再說一句', false]]);
    act(() => { vi.advanceTimersByTime(20000); });
    assert.equal(onTranscript.mock.calls.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test('本機：靜音 5 秒再說 → 繼續；靜音 6 秒 → 停止並轉文字一次', async () => {
  vi.useFakeTimers();
  let level = 0;
  const stops = vi.fn();
  class FakeAnalyser {
    fftSize = 0;
    getFloatTimeDomainData(b: Float32Array) { b.fill(level); }
  }
  class FakeCtx {
    createAnalyser() { return new FakeAnalyser(); }
    createMediaStreamSource() { return { connect() {} }; }
    close() { return Promise.resolve(); }
  }
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm';
    ondataavailable: ((e: any) => void) | null = null;
    onstop: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() {
      stops(); this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array(2000)]) });
      void this.onstop?.();
    }
  }
  const api = await import('@/shared/api');
  (api.transcribeVoice as any).mockResolvedValue({ ok: true, json: () => Promise.resolve({ text: '哈囉' }) });
  (globalThis as any).MediaRecorder = FakeRecorder;
  (window as any).AudioContext = FakeCtx;
  try {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript, () => {}, { mode: 'local' }));
    await act(async () => { result.current.toggle(); });
    assert.equal(result.current.state, 'recording');
    level = 0.2; // 說話
    act(() => { vi.advanceTimersByTime(1000); });
    level = 0;
    act(() => { vi.advanceTimersByTime(5000); });
    assert.equal(stops.mock.calls.length, 0);
    level = 0.2; // 5 秒後又說話
    act(() => { vi.advanceTimersByTime(400); });
    level = 0;
    act(() => { vi.advanceTimersByTime(5800); });
    assert.equal(stops.mock.calls.length, 0);
    await act(async () => { vi.advanceTimersByTime(400); });
    assert.equal(stops.mock.calls.length, 1);
    await act(async () => { vi.advanceTimersByTime(20000); });
    assert.equal(stops.mock.calls.length, 1);
    assert.deepEqual(onTranscript.mock.calls, [['哈囉', false]]);
  } finally {
    delete (window as any).AudioContext;
    delete (globalThis as any).MediaRecorder;
    vi.useRealTimers();
  }
});
