import type { TtsEngine } from '@/modules/voice-call/engines/types';

// Chrome stops long utterances after ~15 s, so text is spoken in short pieces.
const MAX_CHUNK = 120;

export function splitForSpeech(text: string, max = MAX_CHUNK): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf('，'), window.lastIndexOf('、'), window.lastIndexOf(','), window.lastIndexOf(' '));
    const at = cut > max / 3 ? cut + 1 : max;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export function isBrowserTtsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

export function listZhVoices(): SpeechSynthesisVoice[] {
  if (!isBrowserTtsSupported()) return [];
  return window.speechSynthesis.getVoices().filter((voice) => /^zh|cmn/i.test(voice.lang));
}

function pickVoice(voiceName?: string): SpeechSynthesisVoice | null {
  const voices = isBrowserTtsSupported() ? window.speechSynthesis.getVoices() : [];
  if (voiceName) {
    const named = voices.find((voice) => voice.name === voiceName);
    if (named) return named;
  }
  const taiwan = voices.filter((voice) => /zh[-_]TW/i.test(voice.lang) || /Taiwan|臺灣|台灣|Hanhan/i.test(voice.name));
  // Local voices first: an online voice (Chrome's Google ones) sends the reply text off the machine.
  return taiwan.find((voice) => voice.localService) ?? taiwan[0] ?? voices.find((voice) => /^zh/i.test(voice.lang)) ?? null;
}

/** The browser's own voices (Windows ships Microsoft Hanhan zh-TW; Chrome adds Google's online ones). */
export class BrowserTts implements TtsEngine {
  private generation = 0;

  constructor(private readonly opts: { voiceName?: string; rate: number }) {
    // Voices load asynchronously; touching the list starts that.
    if (isBrowserTtsSupported()) window.speechSynthesis.getVoices();
  }

  async speak(text: string, onAudible?: () => void): Promise<void> {
    if (!isBrowserTtsSupported()) throw new Error('這個瀏覽器不支援朗讀');
    const generation = this.generation;
    for (const piece of splitForSpeech(text)) {
      if (generation !== this.generation) return;
      await new Promise<void>((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(piece);
        const voice = pickVoice(this.opts.voiceName);
        if (voice) utterance.voice = voice;
        utterance.lang = voice?.lang || 'zh-TW';
        utterance.rate = this.opts.rate;
        utterance.onstart = () => onAudible?.();
        utterance.onend = () => resolve();
        utterance.onerror = (event) => {
          const code = (event as SpeechSynthesisErrorEvent).error;
          if (code === 'interrupted' || code === 'canceled') resolve();
          else reject(new Error(code === 'not-allowed' ? '瀏覽器擋下自動朗讀，請在頁面上點一下' : `朗讀錯誤 ${code}`));
        };
        window.speechSynthesis.speak(utterance);
      });
    }
  }

  cancel(): void {
    this.generation += 1;
    if (isBrowserTtsSupported()) window.speechSynthesis.cancel();
  }
}
