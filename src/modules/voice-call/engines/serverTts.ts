import { synthesizeVoice } from '@/shared/api';
import type { TtsEngine } from '@/modules/voice-call/engines/types';

/** The configured /audio/speech backend. Only useful when one exists; the bundled whisper.cpp has none. */
export class ServerTts implements TtsEngine {
  private controller: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private finish: (() => void) | null = null;

  async speak(text: string, onAudible?: () => void): Promise<void> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    let response: Response;
    try {
      response = await synthesizeVoice(text, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      throw new Error(`語音合成連不上：${(error as Error)?.message || error}`);
    }
    if (!response.ok) throw new Error(`語音合成失敗（${response.status}）`);
    const url = URL.createObjectURL(await response.blob());
    if (controller.signal.aborted) {
      URL.revokeObjectURL(url);
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const audio = new Audio(url);
        this.audio = audio;
        this.finish = resolve;
        audio.onplaying = () => onAudible?.();
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error('音訊播放失敗'));
        audio.play().catch(reject);
      });
    } finally {
      URL.revokeObjectURL(url);
      this.audio = null;
      this.finish = null;
    }
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.audio?.pause();
    this.finish?.();
  }
}
