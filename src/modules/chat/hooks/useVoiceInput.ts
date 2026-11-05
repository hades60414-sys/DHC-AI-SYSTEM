import { useCallback, useEffect, useRef, useState } from 'react';

import { transcribeVoice } from '@/shared/api';
import type { VoiceInputState } from '@/shared/types';
import { assembleResults, getSpeechRecognitionCtor, mergeSegment, SILENCE_STOP_MS, type SpeechRecognitionLike, type VoiceMode } from '@/modules/chat/hooks/voiceMode';

// Mobile-safe recording: iOS Safari 18.4+ supports webm/opus; older iOS needs mp4.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function pickMime(): string {
  for (const t of MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* isTypeSupported can throw on some iOS versions */
    }
  }
  return '';
}


const SILENCE_RMS = 0.01;

/** 用 Web Audio 量音量：RMS 低於門檻連續 SILENCE_STOP_MS（從開始或最後一次有聲音算起）就呼叫 onSilence。回傳清理函式。 */
function watchSilence(stream: MediaStream, onSilence: () => void): (() => void) | null {
  const Ctx = typeof window !== 'undefined'
    ? ((window as any).AudioContext || (window as any).webkitAudioContext)
    : undefined;
  if (!Ctx) return null;
  let ctx: AudioContext;
  let analyser: AnalyserNode;
  try {
    ctx = new Ctx();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
  } catch {
    return null;
  }
  const buf = new Float32Array(analyser.fftSize);
  let lastLoud = Date.now();
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    try { void ctx.close(); } catch { /* ignore */ }
  };
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const now = Date.now();
    if (Math.sqrt(sum / buf.length) >= SILENCE_RMS) lastLoud = now;
    else if (now - lastLoud >= SILENCE_STOP_MS) {
      cleanup();
      onSilence();
    }
  }, 200);
  return cleanup;
}

/**
 * Push-to-talk dictation. Records the mic, uploads to /api/voice/transcribe
 * (an OpenAI-compatible speech-to-text backend via the Express proxy), and
 * returns the transcript through onTranscript.
 */
export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void,
  onError?: (msg: string) => void,
  opts?: { mode?: VoiceMode; confirmCloud?: () => Promise<boolean> },
) {
  const [state, setState] = useState<VoiceInputState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const silenceCleanupRef = useRef<(() => void) | null>(null);
  const startingRef = useRef(false);
  // Whether the in-progress stop should auto-send the transcript (vs just fill the box).
  const sendRef = useRef(false);
  // 雲端模式（Web Speech）
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  // 使用者已按停止（只有這個或致命錯誤才真的結束；其餘 onend 會自動重啟）
  const userStoppedRef = useRef(false);
  const [interim, setInterim] = useState('');
  const mode = opts?.mode ?? 'local';
  const confirmCloud = opts?.confirmCloud;

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Stop the mic if the component unmounts mid-recording.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      silenceCleanupRef.current?.();
      startingRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      recogRef.current?.abort();
      recogRef.current = null;
    };
  }, []);

  const startCloud = useCallback(async () => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor || recogRef.current || startingRef.current) return;
    startingRef.current = true;
    // 每台裝置第一次要確認（之後記住）；取消就不錄
    const ok = await confirmCloud?.();
    startingRef.current = false;
    if (!ok || cancelledRef.current) return;
    userStoppedRef.current = false;
    // committed：之前各段（含自動重啟前）已確定的文字；sessionFinal：目前這一段的 final
    let committed = '';
    let sessionFinal = '';
    let sessionLive = '';
    let failed = false;
    let fatal = false;
    let quickEnds = 0;
    let lastText = '';
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const clearSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = null;
    };
    // 6 秒內文字沒有任何變化（含自動重啟期間）就當使用者按停止
    const armSilence = () => {
      clearSilence();
      silenceTimer = setTimeout(() => {
        silenceTimer = null;
        if (userStoppedRef.current || !recogRef.current) return;
        userStoppedRef.current = true;
        recogRef.current.stop();
      }, SILENCE_STOP_MS);
    };
    const FATAL = ['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported', 'bad-grammar'];

    const launch = () => {
      const rec = new Ctor();
      rec.lang = 'zh-TW';
      rec.continuous = true;
      rec.interimResults = true;
      sessionFinal = '';
      sessionLive = '';
      let gotResult = false;
      const startedAt = Date.now();
      rec.onresult = (e) => {
        gotResult = true;
        // 每次由整個 results 重建（idempotent）：final 只算一次、interim 取代；
        // Android 每段回整句累積時，由 mergeSegment 去重
        const { final, live } = assembleResults(e.results);
        sessionFinal = final;
        sessionLive = live;
        const shown = mergeSegment(mergeSegment(committed, final), live);
        if (shown !== lastText) {
          lastText = shown;
          armSilence();
        }
        setInterim(shown);
      };
      rec.onerror = (e) => {
        failed = true;
        if (e?.error && FATAL.includes(e.error)) fatal = true;
        if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') onError?.('麥克風權限被拒絕，請到瀏覽器設定允許');
        else if (e?.error !== 'aborted' && e?.error !== 'no-speech') onError?.(`雲端辨識失敗：${e?.error || '未知錯誤'}`);
      };
      rec.onend = () => {
        // 結束時還沒定稿的 interim 也算進去，避免最後幾個字被吃掉
        committed = mergeSegment(committed, mergeSegment(sessionFinal, sessionLive));
        sessionFinal = '';
        sessionLive = '';
        if (cancelledRef.current) { clearSilence(); recogRef.current = null; return; }
        // 使用者沒按停止：瀏覽器（Android Chrome）靜音就自己結束，自動重啟繼續聽
        if (!userStoppedRef.current && !fatal) {
          quickEnds = gotResult || Date.now() - startedAt > 1500 ? 0 : quickEnds + 1;
          if (quickEnds < 5) {
            try {
              launch();
              return;
            } catch {
              /* 重啟失敗就當結束 */
            }
          }
        }
        clearSilence();
        recogRef.current = null;
        const shouldSend = sendRef.current;
        sendRef.current = false;
        userStoppedRef.current = false;
        setInterim('');
        setState('idle');
        const text = committed.trim();
        if (text) onTranscript(text, shouldSend);
        else if (!failed) onError?.('沒有偵測到語音');
      };
      recogRef.current = rec;
      rec.start();
    };
    try {
      launch();
      armSilence();
      setState('recording');
    } catch (e) {
      clearSilence();
      recogRef.current = null;
      onError?.(`雲端辨識無法啟動：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [onTranscript, onError, confirmCloud]);

  const start = useCallback(async () => {
    if (startingRef.current || recogRef.current || (recorderRef.current && recorderRef.current.state !== 'inactive')) return;
    startingRef.current = true;
    let useCloud = false;
    try {
      // 先明確要麥克風權限（要在點擊手勢內呼叫，手機才會跳權限視窗）；沒有 mediaDevices 多半是非 https
      if (!navigator.mediaDevices?.getUserMedia) {
        onError?.('無法使用麥克風：請用 https 網址開啟（目前連線不安全或瀏覽器不支援）');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (mode === 'cloud' && getSpeechRecognitionCtor()) {
        // 雲端辨識由瀏覽器自己收音，權限取得後就把這路釋放
        stream.getTracks().forEach((t) => t.stop());
        useCloud = true;
        return;
      }
      // 本機錄音；若是雲端模式但瀏覽器沒有 SpeechRecognition（iOS 主畫面 App、部分 Android），自動改本機並明說
      if (mode === 'cloud') onError?.('這個瀏覽器不支援雲端語音，已改用本機辨識');
      if (typeof MediaRecorder === 'undefined') {
        stream.getTracks().forEach((t) => t.stop());
        onError?.('這個瀏覽器不支援錄音（缺少 MediaRecorder），請改用較新的瀏覽器');
        return;
      }
      streamRef.current = stream;
      const mimeType = pickMime();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        silenceCleanupRef.current?.();
        stopTracks();
        if (cancelledRef.current) return;
        // Capture and clear the send intent for this stop before any async work.
        const shouldSend = sendRef.current;
        sendRef.current = false;
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size < 800) {
          setState('idle');
          onError?.('錄音太短');
          return;
        }
        setState('transcribing');
        try {
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const res = await transcribeVoice(blob, `recording.${ext}`);
          if (!res.ok) throw new Error(`transcribe ${res.status}`);
          const data = await res.json();
          if (cancelledRef.current) return;
          const text = String(data?.text || '').trim();
          if (text) onTranscript(text, shouldSend);
          else onError?.('沒有偵測到語音');
        } catch (e) {
          if (!cancelledRef.current) {
            onError?.(`語音轉文字失敗：${e instanceof Error ? e.message : String(e)}`);
          }
        } finally {
          if (!cancelledRef.current) setState('idle');
        }
      };

      rec.start();
      setState('recording');
      silenceCleanupRef.current = watchSilence(stream, () => {
        if (rec.state !== 'inactive') {
          sendRef.current = false;
          rec.stop();
        }
      });
    } catch (e) {
      recorderRef.current = null;
      stopTracks();
      if (cancelledRef.current) return;
      const err = e as { name?: string; message?: string };
      let msg = `錄音無法啟動：${err?.message || e}`;
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') msg = '麥克風權限被拒絕，請到瀏覽器設定允許';
      else if (err?.name === 'NotFoundError') msg = '找不到麥克風';
      else if (err?.name === 'NotReadableError') msg = '麥克風被其他程式佔用，無法啟動';
      onError?.(msg);
      setState('idle');
    } finally {
      startingRef.current = false;
      if (useCloud) void startCloud();
    }
  }, [onTranscript, onError, mode, startCloud]);

  // Stop recording. Pass { send: true } to auto-send the transcript once it's ready.
  // Guard on the recorder's own state (not React state) so a double tap, or the mic
  // and Send buttons both firing, can't call stop() on an already-inactive recorder.
  const stop = useCallback((opts?: { send?: boolean }) => {
    if (recogRef.current) {
      sendRef.current = opts?.send ?? false;
      userStoppedRef.current = true;
      recogRef.current.stop();
      return;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      sendRef.current = opts?.send ?? false;
      rec.stop();
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'idle') start();
  }, [state, start, stop]);

  return { state, toggle, stop, interim };
}
