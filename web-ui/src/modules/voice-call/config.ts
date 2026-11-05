import { readVoiceMode } from '@/modules/chat/hooks/voiceMode';
import type { BargeInSensitivity } from '@/modules/voice-call/engines/vad';

export type { BargeInSensitivity } from '@/modules/voice-call/engines/vad';

export type SttEngineName = 'webspeech' | 'whisper';
export type TtsEngineName = 'browser' | 'server';

export type VoiceCallConfig = {
  stt: SttEngineName;
  tts: TtsEngineName;
  voiceName?: string;
  rate: number;
  deviceId?: string;
  maxCallMinutes: number;
  maxUtteranceSec: number;
  idleEndMinutes: number;
  sttTimeoutSec: number;
  maxRetries: number;
  maxSpokenChars: number;
  /** 朗讀中一開口就停（只有本機 whisper 辨識支援）。 */
  bargeIn: boolean;
  /** 插話靈敏度：high 比較容易打斷，但喇叭外放時也比較容易被自己的回音打斷。 */
  bargeInSensitivity: BargeInSensitivity;
};

export const VOICE_CALL_CONFIG_KEY = 'dhc-voice-call-config';

export function defaultVoiceCallConfig(): VoiceCallConfig {
  return {
    stt: readVoiceMode() === 'cloud' ? 'webspeech' : 'whisper',
    tts: 'browser',
    rate: 1.1,
    maxCallMinutes: 30,
    maxUtteranceSec: 60,
    idleEndMinutes: 5,
    sttTimeoutSec: 45,
    maxRetries: 2,
    maxSpokenChars: 600,
    bargeIn: true,
    bargeInSensitivity: 'medium',
  };
}

const num = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

/** localStorage is user-editable, so every field is re-validated and clamped. */
export function readVoiceCallConfig(): VoiceCallConfig {
  const base = defaultVoiceCallConfig();
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(VOICE_CALL_CONFIG_KEY) || '{}');
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    /* 壞掉的設定就用預設 */
  }
  return {
    stt: raw.stt === 'webspeech' || raw.stt === 'whisper' ? raw.stt : base.stt,
    tts: raw.tts === 'browser' || raw.tts === 'server' ? raw.tts : base.tts,
    voiceName: str(raw.voiceName),
    rate: num(raw.rate, base.rate, 0.5, 2),
    deviceId: str(raw.deviceId),
    maxCallMinutes: num(raw.maxCallMinutes, base.maxCallMinutes, 1, 240),
    maxUtteranceSec: num(raw.maxUtteranceSec, base.maxUtteranceSec, 5, 300),
    idleEndMinutes: num(raw.idleEndMinutes, base.idleEndMinutes, 1, 120),
    sttTimeoutSec: num(raw.sttTimeoutSec, base.sttTimeoutSec, 5, 300),
    maxRetries: num(raw.maxRetries, base.maxRetries, 0, 10),
    maxSpokenChars: num(raw.maxSpokenChars, base.maxSpokenChars, 50, 5000),
    bargeIn: typeof raw.bargeIn === 'boolean' ? raw.bargeIn : base.bargeIn,
    bargeInSensitivity: raw.bargeInSensitivity === 'low' || raw.bargeInSensitivity === 'medium' || raw.bargeInSensitivity === 'high' ? raw.bargeInSensitivity : base.bargeInSensitivity,
  };
}

export function writeVoiceCallConfig(patch: Partial<VoiceCallConfig>): VoiceCallConfig {
  const next = { ...readVoiceCallConfig(), ...patch };
  try {
    localStorage.setItem(VOICE_CALL_CONFIG_KEY, JSON.stringify(next));
  } catch {
    /* 隱私模式不能寫就只在這次有效 */
  }
  return next;
}

export const VOICE_SYSTEM_NOTE = '使用者正在用語音交談，輸入是語音辨識結果，可能有錯字。日期、金額、人名、帳號、檔名或關鍵指令有歧義時，先簡短複述並確認再動手。回覆口語、簡短，先講結論；長內容放在文字裡並說『細節在畫面上』。不要說任務完成，除非工具結果確實成功。';
