import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Hand, Mic, MicOff, PhoneOff, RotateCcw, Settings, X } from 'lucide-react';

import { isCloudSupported } from '@/modules/chat/hooks/voiceMode';
import { CommandModeViewer } from '@/modules/command-mode';
import type { CallPhase, VoiceTurn } from '@/modules/voice-call/callMachine';
import type { BargeInSensitivity } from '@/modules/voice-call/config';
import { sttLabel, ttsLabel } from '@/modules/voice-call/engines';
import { listZhVoices } from '@/modules/voice-call/engines/browserTts';
import { useVoiceCall, type VoiceTurnSender } from '@/modules/voice-call/useVoiceCall';

const PHASE_TEXT: Record<CallPhase, string> = {
  off: '已結束',
  starting: '連線中',
  listening: '聆聽中',
  processing: '處理中',
  speaking: '說話中',
  working: '執行中',
  awaiting_confirm: '等你確認',
  error: '錯誤',
};

const PHASE_DOT: Record<CallPhase, string> = {
  off: 'bg-muted-foreground',
  starting: 'bg-muted-foreground animate-pulse',
  listening: 'bg-emerald-500 animate-pulse',
  processing: 'bg-sky-500 animate-pulse',
  speaking: 'bg-violet-500 animate-pulse',
  working: 'bg-amber-500 animate-pulse',
  awaiting_confirm: 'bg-orange-500',
  error: 'bg-red-500',
};

const WAITING_TEXT: Partial<Record<CallPhase, string>> = {
  processing: '正在想…',
  working: '執行中，可以繼續說…',
  awaiting_confirm: '需要你在畫面上按確認',
};

const TURN_FLAG: Partial<Record<VoiceTurn['status'], string>> = { failed: '失敗', aborted: '已停止' };

const SENSITIVITY_TEXT: Record<BargeInSensitivity, string> = { low: '低（喇叭外放用）', medium: '中', high: '高（戴耳機用）' };

const NOTICE_TONE = { info: 'text-muted-foreground', warn: 'text-amber-600 dark:text-amber-400', error: 'text-red-600 dark:text-red-400' };

const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * call.lastReply 是整通電話所有回覆接起來（只留最後 4000 字），
 * 這裡切出某個時間點之後新增的部分，才能只顯示「這一次」的回覆。
 */
function textAddedSince(anchor: string, now: string): string {
  if (!anchor) return now;
  if (now.startsWith(anchor)) return now.slice(anchor.length);
  for (let cut = 1; cut < anchor.length; cut += 1) {
    if (now.startsWith(anchor.slice(cut))) return now.slice(anchor.length - cut);
  }
  return now;
}

type Props = {
  sessionId: string | null;
  sendTurn: VoiceTurnSender;
  isLoading: boolean;
  onAbort: () => void;
  confirmCloud: () => Promise<boolean>;
  /** The local whisper backend answers. */
  whisperReady: boolean;
  onClose: () => void;
};

/** Rendered by chat's ChatComposer above the input while a call is open. */
export default function VoiceCallPanel({ sessionId, sendTurn, isLoading, onAbort, confirmCloud, whisperReady, onClose }: Props) {
  const call = useVoiceCall({ sessionId, isLoading, sendTurn, abort: onAbort, confirmCloud });
  const { phase, config } = call;
  const { lifecycle, notice, partial, lastReply, muted, startedAt, turns } = call.call;
  const [now, setNow] = useState(() => Date.now());
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => listZhVoices());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const startRef = useRef(call.start);
  startRef.current = call.start;
  const replyRef = useRef<HTMLDivElement>(null);
  const live = lifecycle === 'starting' || lifecycle === 'live';

  const latestTurn = turns[turns.length - 1];
  const latestId = latestTurn?.id ?? null;
  const [anchor, setAnchor] = useState<{ id: string | null; text: string }>({ id: null, text: '' });
  if (anchor.id !== latestId) setAnchor({ id: latestId, text: lastReply });
  const reply = anchor.id === latestId ? textAddedSince(anchor.text, lastReply).trim() : '';
  const heard = partial || latestTurn?.transcript || '';

  useEffect(() => {
    startRef.current();
  }, []);

  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  useEffect(() => {
    if (lifecycle !== 'live' || config.stt !== 'whisper' || !navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices.enumerateDevices().then((devices) => setMics(devices.filter((d) => d.kind === 'audioinput')));
  }, [lifecycle, config.stt]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return undefined;
    const update = () => setVoices(listZhVoices());
    window.speechSynthesis.addEventListener?.('voiceschanged', update);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', update);
  }, []);

  // 回覆從頭看（先講結論），換下一句時捲回最上面。
  useLayoutEffect(() => {
    if (replyRef.current) replyRef.current.scrollTop = 0;
  }, [latestId]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tag = (event.target as HTMLElement).tagName;
    if (event.key === ' ' && tag !== 'SELECT' && tag !== 'INPUT' && tag !== 'BUTTON') {
      event.preventDefault();
      call.bargeIn();
    }
  };

  const bigButton = 'inline-flex h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-40 sm:h-11 sm:flex-row sm:gap-1.5';
  const select = 'rounded-md border border-border bg-background px-2 py-1.5 text-sm';
  const waiting = WAITING_TEXT[phase] ?? (live ? (latestTurn ? '等回覆…' : '請說話，說完會自動送出') : '');

  return (
    <div
      role="region"
      aria-label="語音通話"
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="voice-call-panel"
      className="mx-auto mb-2 flex max-w-[54.25rem] flex-col gap-2 rounded-xl border border-border/60 bg-card/95 p-3 text-sm shadow-lg outline-none backdrop-blur-md focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${PHASE_DOT[phase]}`} />
          <span data-testid="voice-call-phase">{PHASE_TEXT[phase]}</span>
          {muted && live && <span className="text-amber-600 dark:text-amber-400">．已靜音</span>}
        </span>
        {startedAt !== null && live && <span className="tabular-nums text-xs text-muted-foreground/70">{clock(now - startedAt)}</span>}
        <button
          type="button"
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
          aria-label="通話設定"
          className={`ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-muted ${settingsOpen ? 'bg-muted text-foreground' : ''}`}
        >
          <Settings className="h-4 w-4" />
        </button>
        {!live && (
          <button type="button" onClick={onClose} aria-label="關閉通話面板" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {notice && <p data-testid="voice-call-notice" className={NOTICE_TONE[notice.tone]}>{notice.text}</p>}

      {heard && (
        <p data-testid="voice-call-heard" className={`line-clamp-2 text-muted-foreground ${partial ? 'italic' : ''}`}>
          <span className="mr-1 text-xs">你</span>{heard}
          {!partial && latestTurn && TURN_FLAG[latestTurn.status] && (
            <span className="ml-1.5 rounded bg-red-100 px-1 text-xs text-red-800 dark:bg-red-900/40 dark:text-red-300">{TURN_FLAG[latestTurn.status]}</span>
          )}
        </p>
      )}

      <div
        ref={replyRef}
        data-testid="voice-call-reply"
        aria-live="polite"
        aria-label="AI 回覆"
        className="max-h-[40vh] min-h-[3.5rem] overflow-y-auto overscroll-contain rounded-lg bg-muted/40 px-3 py-2 sm:max-h-64"
      >
        {reply ? (
          <p className="whitespace-pre-wrap text-lg leading-relaxed text-foreground sm:text-base">{reply}</p>
        ) : (
          <p className="text-base text-muted-foreground">{waiting}</p>
        )}
      </div>

      <CommandModeViewer live={live} className="!mt-0" />

      {live ? (
        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={call.toggleMute} aria-pressed={muted} className={`${bigButton} ${muted ? 'bg-amber-500 text-white hover:bg-amber-600' : 'border border-border bg-background hover:bg-muted'}`}>
            {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}{muted ? '取消靜音' : '靜音'}
          </button>
          <button type="button" onClick={call.bargeIn} disabled={phase !== 'speaking'} title="停止朗讀，換你說（空白鍵）" className={`${bigButton} border border-border bg-background hover:bg-muted`}>
            <Hand className="h-5 w-5" />插話
          </button>
          <button type="button" onClick={() => { call.end(); onClose(); }} className={`${bigButton} bg-red-600 text-white hover:bg-red-700`}>
            <PhoneOff className="h-5 w-5" />掛斷
          </button>
        </div>
      ) : (
        <button type="button" onClick={call.start} className={`${bigButton} border border-border bg-background hover:bg-muted`}>
          <RotateCcw className="h-5 w-5" />重新開始
        </button>
      )}

      {settingsOpen && (
        <div data-testid="voice-call-settings" className="grid gap-2 border-t border-border/60 pt-2 text-muted-foreground sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            辨識
            <select value={config.stt} onChange={(event) => call.setConfig({ stt: event.target.value as 'webspeech' | 'whisper' })} className={select}>
              {isCloudSupported() && <option value="webspeech">Google 雲端（較快，不經去識別層）</option>}
              {whisperReady && <option value="whisper">{call.fastWhisper ? '本機 whisper（快速）' : '本機 whisper'}</option>}
            </select>
          </label>
          {config.stt === 'whisper' && (
            <label className="flex flex-col gap-1">
              麥克風
              <select value={config.deviceId ?? ''} onChange={(event) => call.setConfig({ deviceId: event.target.value || undefined })} className={select}>
                <option value="">系統預設</option>
                {mics.map((mic, index) => (
                  <option key={mic.deviceId || index} value={mic.deviceId}>{mic.label || `麥克風 ${index + 1}`}</option>
                ))}
              </select>
            </label>
          )}
          {config.tts === 'browser' && voices.length > 0 && (
            <label className="flex flex-col gap-1">
              語音
              <select value={config.voiceName ?? ''} onChange={(event) => call.setConfig({ voiceName: event.target.value || undefined })} className={select}>
                <option value="">自動（臺灣語音優先）</option>
                {voices.map((voice) => (
                  <option key={voice.name} value={voice.name}>{voice.name}{voice.localService ? '' : '（線上）'}</option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1">
            語速 {config.rate.toFixed(1)}×
            <input type="range" min={0.5} max={2} step={0.1} value={config.rate} onChange={(event) => call.setConfig({ rate: Number(event.target.value) })} className="h-8" />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={config.bargeIn} onChange={(event) => call.setConfig({ bargeIn: event.target.checked })} className="h-5 w-5" />
            開口就打斷朗讀{config.stt !== 'whisper' && '（只有本機辨識支援）'}
          </label>
          {config.bargeIn && (
            <label className="flex flex-col gap-1">
              插話靈敏度
              <select value={config.bargeInSensitivity} onChange={(event) => call.setConfig({ bargeInSensitivity: event.target.value as BargeInSensitivity })} className={select}>
                {(Object.keys(SENSITIVITY_TEXT) as BargeInSensitivity[]).map((level) => (
                  <option key={level} value={level}>{SENSITIVITY_TEXT[level]}</option>
                ))}
              </select>
            </label>
          )}
          <p className="text-xs sm:col-span-2">錄音不存檔。辨識：{sttLabel(config, call.fastWhisper)}；朗讀：{ttsLabel(config)}。</p>
        </div>
      )}
    </div>
  );
}
