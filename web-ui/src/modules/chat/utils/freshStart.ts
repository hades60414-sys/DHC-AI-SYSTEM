/**
 * DHC CLI 10/31 閒置換新對話: a long Claude conversation left alone for over an hour has a cold prompt cache, so the
 * next message re-reads (and re-writes) the whole context. That message goes to a new conversation in the same
 * project instead, with a short pointer back, unless it reads as a follow-up. Measured on 10/24–10/31: about a
 * fifth of all usage came from such turns (measured by the context-reset evaluation script).
 */
export const FRESH_MIN_TOKENS = 150_000;
export const FRESH_IDLE_MS = 60 * 60 * 1000;

// Words that tie the message to what was said before; such a message stays in its conversation.
const FOLLOW_UP = /剛剛|剛才|上面|上一|前面|那個|那些|這個|這些|再改|再算|再做|再試|繼續|接著|延續|同一|同樣|沿用|照舊|原本|上述|前述|改成|換成|重新|第[一二三四五六七八九十\d]+[項個點筆張]|為什麼|為何|不符|它|他們|其中/;
// Only a message long enough to carry its own context counts as a new question; short ones lean on the chat.
const STANDALONE_MIN_LENGTH = 20;

export type FreshStartCheck = {
  provider: string;
  used: number;
  lastActivity: string | number | Date | null | undefined;
  now: number;
  text: string;
  hasAttachments: boolean;
  busy: boolean;
};

export function shouldStartFresh({ provider, used, lastActivity, now, text, hasAttachments, busy }: FreshStartCheck): boolean {
  if (provider !== 'claude' || busy || hasAttachments || used < FRESH_MIN_TOKENS) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.length < STANDALONE_MIN_LENGTH || FOLLOW_UP.test(trimmed)) return false;
  const last = lastActivity == null ? NaN : new Date(lastActivity).getTime();
  return Number.isFinite(last) && now - last > FRESH_IDLE_MS;
}

// 11/01: the pointer goes after the message, behind a marker, so the sidebar title comes from the message itself
// and the bubble shows only what the user typed (the user asked for the switch to stay out of sight).
const NOTE_MARK = '<!-- dhc:fresh-start -->';
const NOTE_TAIL = /\s*<!-- dhc:fresh-start -->[\s\S]*$/;

/** First message of the new conversation: the message, then a hidden pointer and the previous answer (clipped). */
export function freshStartPrompt(fromSessionId: string, previousAnswer: string, text: string): string {
  const answer = previousAnswer.trim();
  const clipped = answer.length > 600 ? `${answer.slice(0, 600)}…` : answer;
  return [
    text.trim(),
    '',
    NOTE_MARK,
    `（背景備註，畫面上不顯示：舊對話 ${fromSessionId} 很長又閒置超過 1 小時，這則新問題改開在新對話省額度。照常回答，不必提換對話；需要前情再說。）`,
    ...(clipped ? [`上一則回覆摘錄：${clipped}`] : []),
  ].join('\n');
}

/** The message as the user typed it: drops the hidden pointer of a fresh start. */
export function stripFreshStartNote(text: string): string {
  return text.replace(NOTE_TAIL, '');
}

// Record of the hand-over, so the new conversation can show where it came from. `pending` lives only until the new
// id is known; the bound link is also kept in localStorage under that id, so a reload keeps the way back.
let pending: { projectId: string; fromSessionId: string; text: string } | null = null;
let bound: { sessionId: string; fromSessionId: string; text: string } | null = null;

const STORE_PREFIX = 'dhc.freshStart.';

function storeLink(sessionId: string, link: { fromSessionId: string; text: string } | null): void {
  try {
    if (link) localStorage.setItem(STORE_PREFIX + sessionId, JSON.stringify(link));
    else localStorage.removeItem(STORE_PREFIX + sessionId);
  } catch { /* storage unavailable: the link just lives for this page */ }
}

function loadLink(sessionId: string): { fromSessionId: string; text: string } | null {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + sessionId);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.fromSessionId === 'string' && typeof parsed.text === 'string'
      ? { fromSessionId: parsed.fromSessionId, text: parsed.text }
      : null;
  } catch {
    return null;
  }
}

export function markFreshStart(projectId: string, fromSessionId: string, text: string): void {
  pending = { projectId, fromSessionId, text };
  bound = null;
}

/** Called once the new conversation has its id. */
export function bindFreshStart(projectId: string | undefined, sessionId: string | null | undefined): void {
  if (!pending || !sessionId || pending.projectId !== projectId || sessionId === pending.fromSessionId) return;
  bound = { sessionId, fromSessionId: pending.fromSessionId, text: pending.text };
  storeLink(sessionId, { fromSessionId: pending.fromSessionId, text: pending.text });
  pending = null;
}

export function freshStartFor(sessionId: string | null | undefined): { fromSessionId: string; text: string } | null {
  if (!sessionId) return null;
  if (bound && bound.sessionId === sessionId) return { fromSessionId: bound.fromSessionId, text: bound.text };
  return loadLink(sessionId);
}

export function clearFreshStart(): void {
  pending = null;
  bound = null;
}
