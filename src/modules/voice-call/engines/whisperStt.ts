import { transcribeVoice } from '@/shared/api';
import { startErrorFromMedia, SttStartError, type SttEngine, type SttHandlers } from '@/modules/voice-call/engines/types';
import { VoiceActivityDetector, type BargeInSensitivity } from '@/modules/voice-call/engines/vad';
import { encodeWav } from '@/modules/voice-call/engines/wav';

const FRAME_SAMPLES = 2048;
// 收音從觸發點往前補 0.3 秒：插話時門檻較高，第一個字的子音常在門檻以下，不補就會被吃掉。
const PREROLL_MS = 300;
const MIN_CLIP_MS = 400;
const NO_SPEECH_HINT_MS = 12_000;

// whisper writes these on silence or noise; they are never something the user said.
const HALLUCINATION = /^(謝謝(大家|你們)?(的)?(觀看|收看|收聽|觀賞)|請不吝點贊|字幕(由|製作|提供)|訂閱|明鏡與點點|thank you for watching|thanks for watching|you$)/i;

export function isHallucination(text: string): boolean {
  return HALLUCINATION.test(text.replace(/[\s。，！？.!?、]/g, ''));
}

type Clip = { chunks: Float32Array[]; startedAt: number; confirmed: boolean };

/**
 * Local whisper through /api/voice/transcribe. Raw microphone samples go through VoiceActivityDetector; each
 * utterance is sent as a 16 kHz WAV that starts PREROLL_MS before the detector fired. While the speaker plays
 * (guard), the detector keeps listening with an echo-relative threshold so the user can talk over the reply.
 */
export class WhisperStt implements SttEngine {
  private handlers: SttHandlers | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private processor: ScriptProcessorNode | null = null;
  private vad: VoiceActivityDetector;
  private ring: Float32Array[] = [];
  private prerollFrames = 8;
  private sampleRate = 48_000;
  private clip: Clip | null = null;
  private paused = false;
  private stopped = true;
  private heardAny = false;
  private startedAt = 0;
  private hinted = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: { deviceId?: string; maxUtteranceSec: number; timeoutSec: number; bargeInSensitivity?: BargeInSensitivity }) {
    this.vad = new VoiceActivityDetector(opts.bargeInSensitivity);
  }

  async start(handlers: SttHandlers): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new SttStartError('insecure');
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) throw new SttStartError('unsupported', '這個瀏覽器不支援 Web Audio。');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(this.opts.deviceId ? { deviceId: { exact: this.opts.deviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw startErrorFromMedia(error);
    }
    this.handlers = handlers;
    this.stopped = false;
    this.paused = false;
    this.startedAt = Date.now();
    const ctx = new Ctx();
    this.ctx = ctx;
    // iOS 在 await 之後建立的 AudioContext 可能是 suspended。
    void ctx.resume?.().catch(() => undefined);
    this.sampleRate = ctx.sampleRate;
    this.prerollFrames = Math.ceil((PREROLL_MS / 1000) * ctx.sampleRate / FRAME_SAMPLES) + 1;
    const source = ctx.createMediaStreamSource(this.stream);
    const processor = ctx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
    // ScriptProcessor 要接到輸出才會跑；中間放靜音，不讓麥克風聲音從喇叭出來。
    const mute = ctx.createGain();
    mute.gain.value = 0;
    processor.onaudioprocess = (event) => this.onAudio(new Float32Array(event.inputBuffer.getChannelData(0)), Date.now());
    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);
    this.nodes = [source, processor, mute];
    this.processor = processor;
  }

  private onAudio(samples: Float32Array, now: number) {
    if (this.stopped) return;
    if (!this.heardAny && !this.hinted && now - this.startedAt > NO_SPEECH_HINT_MS) {
      this.hinted = true;
      this.handlers?.onNoSpeech();
    }
    if (this.paused) return;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);

    this.ring.push(samples);
    if (this.ring.length > this.prerollFrames) this.ring.shift();
    this.clip?.chunks.push(samples);

    const event = this.vad.feed(rms, now);
    switch (event?.type) {
      case 'onset':
        this.clip = { chunks: [...this.ring], startedAt: now, confirmed: false };
        break;
      case 'confirm':
        if (this.clip) this.clip.confirmed = true;
        this.heardAny = true;
        if (event.bargeIn) this.handlers?.onBargeIn();
        break;
      case 'discard':
        this.clip = null;
        break;
      case 'end':
        this.finishClip(event.speechEndAt);
        return;
      default:
        break;
    }
    if (this.clip?.confirmed && now - this.clip.startedAt >= this.opts.maxUtteranceSec * 1000) {
      this.vad.reset();
      this.finishClip(now);
    }
  }

  private finishClip(speechEndAt: number) {
    const clip = this.clip;
    this.clip = null;
    if (!clip) return;
    const duration = speechEndAt - clip.startedAt;
    if (duration < MIN_CLIP_MS) return;
    this.handlers?.onSpeechEnd();
    const blob = encodeWav(clip.chunks, this.sampleRate);
    // One clip at a time, so utterances come back in the order they were said.
    this.queue = this.queue.then(() => this.transcribe(blob, speechEndAt, duration));
  }

  private async transcribe(blob: Blob, speechEndAt: number, durationMs: number) {
    if (this.stopped) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), this.opts.timeoutSec * 1000);
      });
      const res = await Promise.race([transcribeVoice(blob, 'call.wav', 'call', durationMs), timeout]);
      if (!res.ok) {
        this.handlers?.onError(`本機辨識失敗（${res.status}）`, res.status >= 500 || res.status === 408);
        return;
      }
      const data = await res.json();
      const text = String(data?.text || '').trim();
      if (this.stopped) return;
      if (text && !isHallucination(text)) this.handlers?.onFinal(text, speechEndAt);
      else this.handlers?.onFinal('', speechEndAt);
    } catch (error) {
      if (this.stopped) return;
      const timedOut = (error as Error)?.message === 'timeout';
      this.handlers?.onError(timedOut ? `本機辨識逾時（超過 ${this.opts.timeoutSec} 秒）` : `本機辨識連不上：${(error as Error)?.message || error}`, true);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  pause(): void {
    this.paused = true;
    this.clip = null;
    this.ring = [];
    this.vad.reset();
    this.vad.setMode('listen', Date.now());
  }

  guard(): void {
    if (this.stopped) return;
    if (this.paused) {
      this.paused = false;
      this.ring = [];
    }
    this.vad.setMode('guard', Date.now());
  }

  resume(): void {
    if (this.stopped) return;
    if (this.paused) this.ring = [];
    this.paused = false;
    this.vad.setMode('listen', Date.now());
  }

  stop(): void {
    this.stopped = true;
    this.clip = null;
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor = null;
    this.nodes.forEach((node) => node.disconnect());
    this.nodes = [];
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    try {
      void this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = null;
  }
}
