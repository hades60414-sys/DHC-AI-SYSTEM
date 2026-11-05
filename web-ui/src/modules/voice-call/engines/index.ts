import type { VoiceCallConfig } from '@/modules/voice-call/config';
import { BrowserTts } from '@/modules/voice-call/engines/browserTts';
import { ServerTts } from '@/modules/voice-call/engines/serverTts';
import type { SttEngine, TtsEngine } from '@/modules/voice-call/engines/types';
import { WebSpeechStt } from '@/modules/voice-call/engines/webSpeechStt';
import { WhisperStt } from '@/modules/voice-call/engines/whisperStt';

export type EngineFactory = {
  stt: (config: VoiceCallConfig) => SttEngine;
  tts: (config: VoiceCallConfig) => TtsEngine;
};

export const defaultEngines: EngineFactory = {
  stt: (config) => (config.stt === 'webspeech'
    ? new WebSpeechStt({ maxUtteranceSec: config.maxUtteranceSec })
    : new WhisperStt({ deviceId: config.deviceId, maxUtteranceSec: config.maxUtteranceSec, timeoutSec: config.sttTimeoutSec, bargeInSensitivity: config.bargeInSensitivity })),
  tts: (config) => (config.tts === 'server' ? new ServerTts() : new BrowserTts({ voiceName: config.voiceName, rate: config.rate })),
};

export function sttLabel(config: VoiceCallConfig, fastWhisper: boolean): string {
  if (config.stt === 'webspeech') return 'Google 雲端（不經去識別層）';
  return fastWhisper ? '本機 whisper（快速）' : '本機 whisper';
}

export function ttsLabel(config: VoiceCallConfig): string {
  if (config.tts === 'server') return '伺服器語音合成';
  return `瀏覽器內建語音${config.voiceName ? `（${config.voiceName}）` : ''}`;
}

export type { SttEngine, SttHandlers, TtsEngine } from '@/modules/voice-call/engines/types';
export { SttStartError } from '@/modules/voice-call/engines/types';
