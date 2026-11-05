import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import VoiceInputButton from '@/modules/chat/composer/VoiceInputButton';
import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { hasAcceptedCloud, markCloudAccepted, readVoiceMode, VOICE_MODE_KEY, writeVoiceMode } from '@/modules/chat/hooks/voiceMode';

vi.mock('@/shared/api', () => ({ transcribeVoice: vi.fn(), api: {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() { FakeRecognition.last = this; }
  start() { this.started = true; }
  stop() { this.onend?.(); }
  abort() {}
}

let getUserMedia: ReturnType<typeof vi.fn>;
let trackStop: ReturnType<typeof vi.fn>;

function stubMediaDevices(impl?: () => Promise<unknown>) {
  trackStop = vi.fn();
  getUserMedia = vi.fn(impl ?? (() => Promise.resolve({ getTracks: () => [{ stop: trackStop }] })));
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  FakeRecognition.last = null;
  stubMediaDevices();
});
afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  delete (globalThis as any).MediaRecorder;
  delete (window as any).SpeechRecognition;
  delete (window as any).webkitSpeechRecognition;
});

test('不支援 Web Speech：一律本機，即使 localStorage 存了 cloud', () => {
  localStorage.setItem(VOICE_MODE_KEY, 'cloud');
  assert.equal(readVoiceMode(), 'local');
});

test('支援 Web Speech：預設雲端，選擇會存 localStorage', () => {
  (window as any).webkitSpeechRecognition = FakeRecognition;
  assert.equal(readVoiceMode(), 'cloud');
  writeVoiceMode('local');
  assert.equal(localStorage.getItem(VOICE_MODE_KEY), 'local');
  assert.equal(readVoiceMode(), 'local');
});

test('按麥克風直接開始錄音、不跳選單；旁邊 ⌃ 才開 雲端／本機／語音對話，目前方式打勾', () => {
  const onToggle = vi.fn();
  const onStartWith = vi.fn();
  const onCall = vi.fn();
  render(<VoiceInputButton state="idle" mode="local" onToggle={onToggle} onStartWith={onStartWith} onCall={onCall} />);
  fireEvent.click(screen.getByLabelText('voice.input'));
  assert.equal(onToggle.mock.calls.length, 1);
  assert.equal(screen.queryByTestId('voice-menu'), null);
  fireEvent.click(screen.getByTestId('voice-more'));
  const items = Array.from(screen.getByTestId('voice-menu').querySelectorAll('button')).map((b) => b.dataset.testid);
  assert.deepEqual(items, ['voice-menu-cloud', 'voice-menu-local', 'voice-menu-call']);
  assert.equal(screen.getByTestId('voice-menu-local').getAttribute('aria-checked'), 'true');
  assert.equal(screen.getByTestId('voice-menu-cloud').getAttribute('aria-checked'), 'false');
  fireEvent.click(screen.getByTestId('voice-menu-cloud'));
  assert.deepEqual(onStartWith.mock.calls, [['cloud']]);
  assert.equal(screen.queryByTestId('voice-menu'), null);
  fireEvent.contextMenu(screen.getByLabelText('voice.input'));
  fireEvent.click(screen.getByTestId('voice-menu-call'));
  assert.equal(onCall.mock.calls.length, 1);
  assert.equal(onToggle.mock.calls.length, 1);
});

test('手機上 ⌃ 觸控區至少 40px 高，選單被平移回畫面內', () => {
  const widthBefore = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
  const rectOf = (left: number, width: number) => ({ left, right: left + width, width, top: 700, bottom: 740, height: 40, x: left, y: 700, toJSON: () => ({}) });
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    // 選單在 style.left（中心點）減半寬的位置；寬 232
    return this.dataset.testid === 'voice-menu' ? rectOf(parseFloat(this.style.left) - 116, 232) : rectOf(20, 28);
  } as never);
  try {
    render(<VoiceInputButton state="idle" mode="local" onToggle={() => {}} onCall={() => {}} />);
    const more = screen.getByTestId('voice-more');
    assert.ok(more.className.includes('!h-10'));
    fireEvent.click(more);
    const menu = screen.getByTestId('voice-menu');
    assert.ok(parseFloat(menu.style.left) - 116 >= 8, 'left edge inside the screen');
  } finally {
    spy.mockRestore();
    Object.defineProperty(window, 'innerWidth', { value: widthBefore, configurable: true });
  }
});

test('只有本機、沒有語音對話就不出 ⌃；錄音中按麥克風直接結束', () => {
  const onToggle = vi.fn();
  const { rerender } = render(<VoiceInputButton state="idle" mode="local" onToggle={onToggle} />);
  assert.equal(screen.queryByTestId('voice-more'), null);
  rerender(<VoiceInputButton state="recording" mode="local" onToggle={onToggle} onCall={() => {}} />);
  assert.equal(screen.queryByTestId('voice-more'), null);
  fireEvent.click(screen.getByLabelText('voice.stopRecording'));
  assert.equal(onToggle.mock.calls.length, 1);
  assert.equal(screen.queryByTestId('voice-menu'), null);
});

test('雲端模式取消確認：不開始錄音', async () => {
  (window as any).webkitSpeechRecognition = FakeRecognition;
  const confirmCloud = vi.fn().mockResolvedValue(false);
  const { result } = renderHook(() => useVoiceInput(() => {}, () => {}, { mode: 'cloud', confirmCloud }));
  await act(async () => { result.current.toggle(); });
  assert.equal(confirmCloud.mock.calls.length, 1);
  assert.equal(FakeRecognition.last, null);
  assert.equal(result.current.state, 'idle');
});

test('雲端模式確定後以 zh-TW 錄音，即時文字顯示，停止後填入', async () => {
  (window as any).webkitSpeechRecognition = FakeRecognition;
  const onTranscript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput(onTranscript, () => {}, { mode: 'cloud', confirmCloud: () => Promise.resolve(true) }),
  );
  await act(async () => { result.current.toggle(); });
  const rec = FakeRecognition.last!;
  assert.equal(rec.lang, 'zh-TW');
  assert.equal(rec.interimResults, true);
  assert.equal(result.current.state, 'recording');
  act(() => {
    rec.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: '你好' }], { isFinal: false })] });
  });
  assert.equal(result.current.interim, '你好');
  act(() => {
    rec.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: '你好嗎' }], { isFinal: true })] });
  });
  await act(async () => { result.current.toggle(); });
  assert.deepEqual(onTranscript.mock.calls[0], ['你好嗎', false]);
  assert.equal(result.current.state, 'idle');
});

test('雲端模式：先明確要麥克風權限（audio:true），拿到後立刻釋放，再開始辨識', async () => {
  (window as any).webkitSpeechRecognition = FakeRecognition;
  const { result } = renderHook(() =>
    useVoiceInput(() => {}, () => {}, { mode: 'cloud', confirmCloud: () => Promise.resolve(true) }),
  );
  await act(async () => { result.current.toggle(); });
  assert.deepEqual(getUserMedia.mock.calls[0], [{ audio: true }]);
  assert.equal(trackStop.mock.calls.length, 1);
  assert.equal(FakeRecognition.last?.started, true);
  assert.equal(result.current.state, 'recording');
});

test('權限被拒絕：顯示中文錯誤，不開始辨識', async () => {
  (window as any).webkitSpeechRecognition = FakeRecognition;
  stubMediaDevices(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })));
  const onError = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput(() => {}, onError, { mode: 'cloud', confirmCloud: () => Promise.resolve(true) }),
  );
  await act(async () => { result.current.toggle(); });
  assert.deepEqual(onError.mock.calls[0], ['麥克風權限被拒絕，請到瀏覽器設定允許']);
  assert.equal(FakeRecognition.last, null);
  assert.equal(result.current.state, 'idle');
});

test('沒有 mediaDevices（非 https）：顯示中文錯誤，不靜默失敗', async () => {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  const onError = vi.fn();
  const { result } = renderHook(() => useVoiceInput(() => {}, onError, { mode: 'local' }));
  await act(async () => { result.current.toggle(); });
  assert.match(String(onError.mock.calls[0][0]), /https/);
  assert.equal(result.current.state, 'idle');
});

test('雲端模式但瀏覽器沒有 SpeechRecognition：提示並自動改本機錄音', async () => {
  const recStart = vi.fn();
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: unknown = null;
    onstop: unknown = null;
    start() { this.state = 'recording'; recStart(); }
    stop() { this.state = 'inactive'; }
  }
  (globalThis as any).MediaRecorder = FakeRecorder;
  const onError = vi.fn();
  const confirmCloud = vi.fn().mockResolvedValue(true);
  const { result } = renderHook(() => useVoiceInput(() => {}, onError, { mode: 'cloud', confirmCloud }));
  await act(async () => { result.current.toggle(); });
  assert.deepEqual(onError.mock.calls[0], ['這個瀏覽器不支援雲端語音，已改用本機辨識']);
  assert.equal(confirmCloud.mock.calls.length, 0);
  assert.equal(recStart.mock.calls.length, 1);
  assert.equal(result.current.state, 'recording');
});

test('雲端外傳警告只問第一次：同意後記在 localStorage', () => {
  assert.equal(hasAcceptedCloud(), false);
  markCloudAccepted();
  assert.equal(hasAcceptedCloud(), true);
});

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
}

test('手機預設本機：舊 key 存的 cloud 不算，改版後明確選 cloud 才算；桌面預設不變', () => {
  (window as any).webkitSpeechRecognition = FakeRecognition;
  setWidth(390);
  try {
    localStorage.setItem(VOICE_MODE_KEY, 'cloud');
    assert.equal(readVoiceMode(), 'local');
    writeVoiceMode('cloud');
    assert.equal(readVoiceMode(), 'cloud');
  } finally {
    setWidth(1024);
  }
  localStorage.clear();
  assert.equal(readVoiceMode(), 'cloud');
});

test('本機模式缺 MediaRecorder：顯示中文錯誤，並釋放麥克風', async () => {
  delete (globalThis as any).MediaRecorder;
  const onError = vi.fn();
  const { result } = renderHook(() => useVoiceInput(() => {}, onError, { mode: 'local' }));
  await act(async () => { result.current.toggle(); });
  assert.match(String(onError.mock.calls[0][0]), /MediaRecorder/);
  assert.equal(trackStop.mock.calls.length, 1);
  assert.equal(result.current.state, 'idle');
});

test('本機錄音啟動丟例外：顯示中文錯誤', async () => {
  class Boom { static isTypeSupported() { return true; } constructor() { throw new Error('boom'); } }
  (globalThis as any).MediaRecorder = Boom;
  const onError = vi.fn();
  const { result } = renderHook(() => useVoiceInput(() => {}, onError, { mode: 'local' }));
  await act(async () => { result.current.toggle(); });
  assert.match(String(onError.mock.calls[0][0]), /錄音無法啟動：boom/);
});

test('手機：錄音中與辨識中顯示狀態文字', () => {
  setWidth(390);
  try {
    const { rerender } = render(<VoiceInputButton state="recording" mode="local" onToggle={() => {}} />);
    assert.equal(screen.getByTestId('voice-status').textContent, '錄音中，再按一次結束');
    rerender(<VoiceInputButton state="transcribing" mode="local" onToggle={() => {}} />);
    assert.match(screen.getByTestId('voice-status').textContent ?? '', /辨識中…/);
    rerender(<VoiceInputButton state="idle" mode="local" onToggle={() => {}} />);
    assert.equal(screen.queryByTestId('voice-status'), null);
  } finally {
    setWidth(1024);
  }
});
