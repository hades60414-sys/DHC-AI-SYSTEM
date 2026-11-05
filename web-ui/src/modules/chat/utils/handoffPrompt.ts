import { api } from '@/shared/api';

/**
 * DHC CLI 10/24 長對話交接: past LONG_CONTEXT_TOKENS, once a turn has just finished in the open view, the page asks the
 * server whether the last reply is a natural stopping point and then offers to continue in a new conversation. The
 * offer shows when the judge says 'now', or always from FORCE_TOKENS on; 「暫緩」 hides it until the conversation has
 * grown another SNOOZE_STEP_TOKENS. Opening an old long conversation never asks, only a turn ending while it is open.
 */
export const HANDOFF_FORCE_TOKENS = 280_000;
export const HANDOFF_SNOOZE_STEP_TOKENS = 50_000;
const MAX_ASSISTANT = 1500;
const MAX_USER = 600;

export type HandoffMomentAnswer = { choice: 'now' | 'later'; off: boolean };

const snoozeKey = (sessionId: string) => `dhc.handoffSnooze:${sessionId}`;

/** The `used` count when the user snoozed this conversation, or null. */
export function readHandoffSnooze(sessionId: string): number | null {
  try {
    const stored = Number(localStorage.getItem(snoozeKey(sessionId)));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

export function writeHandoffSnooze(sessionId: string, used: number): void {
  try {
    localStorage.setItem(snoozeKey(sessionId), String(Math.round(used)));
  } catch {
    // Without storage the card simply comes back after the next turn.
  }
}

/** Snoozed until `used` is another step above the count at snooze time. */
export const isHandoffSnoozed = (used: number, snoozedAt: number | null): boolean =>
  snoozedAt !== null && used < snoozedAt + HANDOFF_SNOOZE_STEP_TOKENS;

/** Whether to ask the judge now: a long conversation, idle, a turn just ended in this view, not snoozed, no card yet. */
export const shouldAskHandoffMoment = (input: {
  used: number;
  longTokens: number;
  isProcessing: boolean;
  turnJustCompleted: boolean;
  snoozedAt: number | null;
  cardVisible: boolean;
}): boolean =>
  input.turnJustCompleted
  && !input.isProcessing
  && !input.cardVisible
  && input.used >= input.longTokens
  && !isHandoffSnoozed(input.used, input.snoozedAt);

/** The card shows for 'now', or whatever the judge said once the conversation is past FORCE_TOKENS; never when off. */
export const shouldShowHandoff = (answer: HandoffMomentAnswer, used: number): boolean =>
  !answer.off && (answer.choice === 'now' || used >= HANDOFF_FORCE_TOKENS);

type TextMessage = { type: string; content?: unknown; isToolUse?: boolean; isThinking?: boolean };

/** The user's last message and the tail of the assistant's last text reply, as the judge wants them. */
export function lastTurnTexts(messages: TextMessage[]): { lastUser: string; lastAssistant: string } {
  let lastUser = '';
  let lastAssistant = '';
  for (let i = messages.length - 1; i >= 0 && !lastUser; i -= 1) {
    const message = messages[i];
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    if (!text || message.isToolUse || message.isThinking) continue;
    if (message.type === 'user') lastUser = text.slice(0, MAX_USER);
    else if (message.type === 'assistant' && !lastAssistant) lastAssistant = text.slice(-MAX_ASSISTANT);
  }
  return { lastUser, lastAssistant };
}

/** Never throws; a failed or unreadable answer counts as off so nothing is shown. */
export async function fetchHandoffMoment(
  body: { lastUser: string; lastAssistant: string },
  signal?: AbortSignal,
): Promise<HandoffMomentAnswer> {
  try {
    const response = await api.providers.handoffMoment(body, signal);
    const data = (await response.json()) as { choice?: unknown; off?: unknown };
    if (!response.ok) return { choice: 'later', off: true };
    return { choice: data.choice === 'now' ? 'now' : 'later', off: data.off === true };
  } catch {
    return { choice: 'later', off: true };
  }
}

export type HandoffOutcome = { ok: true; newSessionId: string } | { ok: false; message: string };

/** Asks the server to hand the conversation over (about a minute); a failure comes back as readable text. */
export async function requestHandoff(
  sessionId: string,
  body: { permissionMode?: string; toolsSettings?: unknown; skipPermissions?: boolean },
): Promise<HandoffOutcome> {
  try {
    const response = await api.providers.handoffSession(sessionId, body);
    // The server answers 200 at once and the outcome later, so a failure is {success:false,error} under 200.
    const payload = (await response.json().catch(() => null)) as
      | { data?: { newSessionId?: unknown }; error?: { message?: unknown } }
      | null;
    if (response.status === 404) return { ok: false, message: '要等系統重啟後才能交接。' };
    const newSessionId = payload?.data?.newSessionId;
    if (response.ok && typeof newSessionId === 'string' && newSessionId) return { ok: true, newSessionId };
    const message = typeof payload?.error?.message === 'string' && payload.error.message
      ? payload.error.message
      : `交接沒有成功（HTTP ${response.status}），稍後再試一次。`;
    return { ok: false, message };
  } catch {
    return { ok: false, message: '連不到伺服器，稍後再試一次。' };
  }
}
