import { api } from '@/shared/api';
import { readActiveSettingsProfileId } from '@/shared/userSettings';

/**
 * DHC CLI 10/24 開對話建議模型: on a new conversation's first send with an Opus model, a Haiku judge on the
 * server says whether Sonnet is enough. 'suggest' sends as before and offers a switch; 'auto' waits for the
 * advice (at most ADVICE_WAIT_MS) and sends the first message with Sonnet when the judge says so.
 * The mode belongs to this browser's settings profile.
 */
export type ModelAdviceMode = 'suggest' | 'auto' | 'off';
export const MODEL_ADVICE_MODES: ModelAdviceMode[] = ['suggest', 'auto', 'off'];
export const ADVICE_WAIT_MS = 6000;
export const SONNET_MODEL = 'sonnet';

/** What the chip under the composer offers, for one session. `from` is the Opus model the user had picked. */
export type ModelAdviceChip = { sessionId: string; kind: 'suggest' | 'auto'; from: string };

const modeKey = () => {
  const profileId = readActiveSettingsProfileId();
  return profileId ? `dhc.modelAdvice:p:${profileId}` : 'dhc.modelAdvice';
};

export function readModelAdviceMode(): ModelAdviceMode {
  try {
    // 10/31: the user wants the switch made for them, so 'suggest' (asking first) now reads as 'auto'.
    return localStorage.getItem(modeKey()) === 'off' ? 'off' : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeModelAdviceMode(mode: ModelAdviceMode): void {
  try {
    localStorage.setItem(modeKey(), mode);
  } catch {
    // Without storage the default ('auto') stays.
  }
}

export const isOpusModel = (model: string): boolean => /opus/i.test(model);

/** 'sonnet' only when the server says so in time; anything else, including errors, is 'opus'. */
export async function fetchModelAdvice(
  body: { text: string; projectPath: string; hasAttachment: boolean },
  waitMs = ADVICE_WAIT_MS,
): Promise<'sonnet' | 'opus'> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), waitMs);
  try {
    const response = await api.providers.modelAdvice(body, stop.signal);
    const data = (await response.json()) as { advice?: unknown };
    return response.ok && data.advice === 'sonnet' ? 'sonnet' : 'opus';
  } catch {
    return 'opus';
  } finally {
    clearTimeout(timer);
  }
}
