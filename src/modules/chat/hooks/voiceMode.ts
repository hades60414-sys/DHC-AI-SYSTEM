// 語音輸入模式：雲端（瀏覽器 Web Speech API）或本機（whisper）。選擇存 localStorage。
export type VoiceMode = 'cloud' | 'local';

export const VOICE_MODE_KEY = 'dhc-voice-mode';
export const CLOUD_CONFIRM_TEXT = '語音會傳到 Google／Apple 辨識，不經過去識別層。要繼續嗎？';

type SpeechCtor = new () => SpeechRecognitionLike;

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export function getSpeechRecognitionCtor(): SpeechCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function isCloudSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

// 10/25 起手機預設本機錄音（直接錄音上傳到我們的 whisper）。舊 key 在手機上存過的 cloud 不算數，
// 只有改版後在這台裝置明確選的（v2 key）才算。
export const VOICE_MODE_KEY_V2 = 'dhc-voice-mode-v2';

/** 手機（觸控為主）或窄螢幕。 */
export function isPhoneLikeDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return coarse || window.innerWidth < 768;
}

/** 不支援 Web Speech 時一律本機；手機預設本機、桌面預設雲端；使用者在這台明確選過的優先。 */
export function readVoiceMode(): VoiceMode {
  if (!isCloudSupported()) return 'local';
  try {
    const chosen = localStorage.getItem(VOICE_MODE_KEY_V2);
    if (chosen === 'cloud' || chosen === 'local') return chosen;
    if (isPhoneLikeDevice()) return 'local';
    return localStorage.getItem(VOICE_MODE_KEY) === 'local' ? 'local' : 'cloud';
  } catch {
    return isPhoneLikeDevice() ? 'local' : 'cloud';
  }
}

// 雲端語音的外傳警告：每台裝置只問第一次，同意後記在 localStorage
export const CLOUD_ACCEPTED_KEY = 'dhc-voice-cloud-accepted';

export function hasAcceptedCloud(): boolean {
  try {
    return localStorage.getItem(CLOUD_ACCEPTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markCloudAccepted(): void {
  try {
    localStorage.setItem(CLOUD_ACCEPTED_KEY, '1');
  } catch {
    /* 隱私模式可能不能寫，忽略（下次會再問） */
  }
}

export function writeVoiceMode(mode: VoiceMode): void {
  try {
    localStorage.setItem(VOICE_MODE_KEY, mode);
    localStorage.setItem(VOICE_MODE_KEY_V2, mode);
  } catch {
    /* 隱私模式可能不能寫，忽略 */
  }
}

const norm = (s: string) => s.toLowerCase();

/**
 * 把一段辨識結果接到已累積文字後面，去掉 Android Chrome「每次都回整句累積」造成的重複：
 * 新段以累積文字（或最後一段）開頭 → 只留新的；新段已包含在尾端 → 不重複加；其餘照接。
 * 比對不分大小寫（"OK" 與 "ok" 視為同一段，採用較新的寫法）。
 */
export function mergeSegment(acc: string, seg: string): string {
  if (!seg) return acc;
  if (!acc) return seg;
  const a = norm(acc);
  const s = norm(seg);
  if (s.startsWith(a)) return seg;
  if (a.endsWith(s)) return acc;
  return acc + seg;
}

/** 由一個 session 的 event.results 重建文字：final 逐段合併（每段只算一次），最後接上 interim（取代，不累加）。 */
export function assembleResults(results: ArrayLike<any>): { final: string; live: string } {
  let final = '';
  let live = '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const t: string = r?.[0]?.transcript ?? '';
    if (r?.isFinal) final = mergeSegment(final, t);
    else live = mergeSegment(live, t);
  }
  return { final, live };
}

/** 連續這麼久沒有新語音就自動停止（等同使用者按停止）。 */
export const SILENCE_STOP_MS = 6000;
