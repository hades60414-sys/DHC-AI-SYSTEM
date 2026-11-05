import type { StartFailure } from '@/modules/voice-call/callMachine';

export type SttHandlers = {
  onPartial: (text: string) => void;
  /** The speaker stopped and the clip is on its way to recognition (whisper only). */
  onSpeechEnd: () => void;
  /** 朗讀中聽到使用者開口（guard 模式確認的）；這句會照常錄完送 onFinal。 */
  onBargeIn: () => void;
  onFinal: (text: string, speechEndAt: number) => void;
  onNoSpeech: () => void;
  onError: (message: string, transient: boolean) => void;
};

/** Thrown by start() so the call can say exactly why it could not begin. */
export class SttStartError extends Error {
  constructor(readonly code: StartFailure, readonly detail?: string) {
    super(detail ?? code);
  }
}

export interface SttEngine {
  start(handlers: SttHandlers): Promise<void>;
  /** Stop hearing (while the speaker plays, or muted) without releasing the device. */
  pause(): void;
  /** 喇叭在念：繼續聽，但只把明顯蓋過回音的人聲當插話。分不出人聲和回音的引擎就當 pause。 */
  guard(): void;
  resume(): void;
  stop(): void;
}

export interface TtsEngine {
  /** Resolves when the text has been spoken or cancelled. */
  /** onAudible fires when sound actually starts, which is what the latency metric measures. */
  speak(text: string, onAudible?: () => void): Promise<void>;
  cancel(): void;
}

export function startErrorFromMedia(error: unknown): SttStartError {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return new SttStartError('mic_denied');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new SttStartError('no_mic');
  if (name === 'NotReadableError') return new SttStartError('mic_busy');
  return new SttStartError('other', `通話無法開始：${(error as Error)?.message || String(error)}`);
}
