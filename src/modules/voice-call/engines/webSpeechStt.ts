import { getSpeechRecognitionCtor, type SpeechRecognitionLike } from '@/modules/chat/hooks/voiceMode';
import { startErrorFromMedia, SttStartError, type SttEngine, type SttHandlers } from '@/modules/voice-call/engines/types';

const NO_SPEECH_HINT_MS = 12_000;

/**
 * Browser speech recognition (Chrome/Edge send the audio to Google). Each final result is one utterance; the
 * browser does the endpointing. It always uses the system default microphone.
 */
export class WebSpeechStt implements SttEngine {
  private rec: SpeechRecognitionLike | null = null;
  private handlers: SttHandlers | null = null;
  private stopped = true;
  private paused = false;
  private heardAny = false;
  private quickEnds = 0;
  private lastFinal = '';
  private utteranceTimer: ReturnType<typeof setTimeout> | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: { maxUtteranceSec: number }) {}

  async start(handlers: SttHandlers): Promise<void> {
    if (!getSpeechRecognitionCtor()) throw new SttStartError('unsupported');
    if (!navigator.mediaDevices?.getUserMedia) throw new SttStartError('insecure');
    try {
      // Asked explicitly so a denied mic is reported as such, not as a recognition error later.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      throw startErrorFromMedia(error);
    }
    this.handlers = handlers;
    this.stopped = false;
    this.paused = false;
    this.quickEnds = 0;
    this.hintTimer = setTimeout(() => {
      if (!this.heardAny && !this.stopped) this.handlers?.onNoSpeech();
    }, NO_SPEECH_HINT_MS);
    this.launch();
  }

  private clearUtteranceTimer() {
    if (this.utteranceTimer) clearTimeout(this.utteranceTimer);
    this.utteranceTimer = null;
  }

  private launch() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor || this.stopped || this.paused || this.rec) return;
    const rec = new Ctor();
    rec.lang = 'zh-TW';
    rec.continuous = true;
    rec.interimResults = true;
    this.lastFinal = '';
    const startedAt = Date.now();
    let gotResult = false;

    rec.onresult = (event) => {
      if (this.rec !== rec || this.paused) return;
      gotResult = true;
      this.heardAny = true;
      let live = '';
      for (let i = event.resultIndex ?? 0; i < event.results.length; i++) {
        const result = event.results[i];
        const text: string = result?.[0]?.transcript ?? '';
        if (!result?.isFinal) {
          live += text;
          continue;
        }
        // Android Chrome repeats the whole session so far in every final result.
        const fresh = this.lastFinal && text.startsWith(this.lastFinal) ? text.slice(this.lastFinal.length) : text;
        this.lastFinal = text;
        this.clearUtteranceTimer();
        if (fresh.trim()) this.handlers?.onFinal(fresh.trim(), Date.now());
      }
      this.handlers?.onPartial(live);
      if (live && !this.utteranceTimer) {
        this.utteranceTimer = setTimeout(() => {
          this.utteranceTimer = null;
          this.rec?.stop();
        }, this.opts.maxUtteranceSec * 1000);
      }
    };
    rec.onerror = (event) => {
      const code = event?.error as string | undefined;
      if (code === 'aborted' || code === 'no-speech') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.stopped = true;
        this.handlers?.onError('麥克風或雲端辨識權限被拒絕，請到瀏覽器設定允許。', false);
      } else if (code === 'audio-capture') {
        this.stopped = true;
        this.handlers?.onError('收不到麥克風的聲音，請確認麥克風。', false);
      } else if (code === 'network') {
        this.handlers?.onError('雲端辨識連不上（網路問題）', true);
      } else {
        this.handlers?.onError(`雲端辨識失敗：${code || '未知錯誤'}`, true);
      }
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      this.clearUtteranceTimer();
      if (this.stopped || this.paused) return;
      // The browser ends a session on its own after silence; keep listening, but not in a tight loop.
      this.quickEnds = gotResult || Date.now() - startedAt > 1500 ? 0 : this.quickEnds + 1;
      if (this.quickEnds >= 5) {
        this.quickEnds = 0;
        this.handlers?.onError('雲端辨識一直中斷', true);
        return;
      }
      setTimeout(() => this.launch(), 200);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch (error) {
      this.rec = null;
      this.handlers?.onError(`雲端辨識無法啟動：${(error as Error)?.message || error}`, true);
    }
  }

  pause(): void {
    this.paused = true;
    this.clearUtteranceTimer();
    const rec = this.rec;
    this.rec = null;
    rec?.abort();
  }

  /** 雲端辨識拿不到音量，分不出使用者和喇叭回音，所以朗讀時照舊關麥克風；插話只能按鈕。 */
  guard(): void {
    this.pause();
  }

  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    this.clearUtteranceTimer();
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = null;
    const rec = this.rec;
    this.rec = null;
    rec?.abort();
  }
}
