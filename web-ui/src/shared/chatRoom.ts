import { useEffect, useSyncExternalStore } from 'react';

import { api, authenticatedFetch } from '@/shared/api';

/**
 * DHC CLI 10/16 聊天室＋便利貼. People talk in rooms: 動態 (the lobby everyone reads, where Co-Work invitations
 * show up again as posts), private chats between two people, and one room beside each session or whiteboard.
 * A sticky note sits on a session's transcript or on a whiteboard. Both carry references — @person, @@session,
 * @@whiteboard — that open the person's private chat or jump to the session/board, and a mention of you lights
 * a soft red dot on that session (or on the whiteboard icons) until you look.
 *
 * Storage is the site-wide user_preferences, like the Co-Work records: one key per room (`dhc.chat:<roomId>`, so
 * two rooms never overwrite each other), one for the notes (`dhc.notes`) and one per person for what they have
 * seen (`dhc.chatSeen:<projectId>`). Every save re-reads the server's copy first and merges by id.
 */
export type RefKind = 'person' | 'session' | 'board';
/** A mention or a shared item. `label` is the name when it was made, so it shows without loading anything. */
export type ChatRef = { kind: RefKind; id: string; label: string };
/** DHC CLI: an uploaded file in a message. Only the reference lives here; `stored` is the name under ~/.cloudcli/assets. */
export type ChatFile = { name: string; stored: string; size: number; type: string };
export type ChatMessage = {
  id: string;
  by: string;
  text: string;
  at: string;
  refs: ChatRef[];
  /** A session or whiteboard dragged into the room: shown as a card that jumps there. */
  share?: ChatRef;
  /** Pictures and files sent with the message (references only, never the bytes). */
  files?: ChatFile[];
  /** emoji → the people who reacted. */
  reactions?: Record<string, string[]>;
  /** 團隊小助理's answer: the id of the message that called it. */
  replyTo?: string;
  /** 團隊小助理 could not answer this time; the page offers 重試. */
  failed?: boolean;
  /** 11/01: this message's save failed. It is kept on this device until 重試 gets it through; never stored on the server. */
  unsent?: boolean;
};
export type NoteTarget = { kind: 'session' | 'board'; id: string; title: string };
export type StickyNote = {
  id: string;
  target: NoteTarget;
  by: string;
  text: string;
  refs: ChatRef[];
  color: NoteColor;
  /** On a session: the transcript anchor it hangs from, how far below it, and how far across (0–1). */
  anchor?: string;
  dy?: number;
  xFrac?: number;
  /** On a whiteboard: its place in scene coordinates. */
  x?: number;
  y?: number;
  w: number;
  h: number;
  at: string;
  updatedAt: string;
};
export type NoteColor = 'yellow' | 'pink' | 'blue' | 'green' | 'purple';
export const NOTE_COLORS: NoteColor[] = ['yellow', 'pink', 'blue', 'green', 'purple'];

export const LOBBY = 'lobby';
const ROOM_PREFIX = 'dhc.chat:';
const NOTES_KEY = 'dhc.notes';
const SEEN_PREFIX = 'dhc.chatSeen:';
const MAX_MESSAGES = 300;
const MAX_TEXT = 4000;
/** While the chat panel is open the room refreshes every few seconds; otherwise once a minute for the red dots. */
const POLL_OPEN_MS = 5_000;
const POLL_CLOSED_MS = 60_000;

export const roomOfSession = (sessionId: string) => `s:${sessionId}`;
export const roomOfBoard = (boardId: string) => `b:${boardId}`;
export const dmRoom = (a: string, b: string) => `dm:${[a, b].sort().join('~')}`;
export const dmPeer = (roomId: string, me: string) => {
  if (!roomId.startsWith('dm:')) return null;
  const pair = roomId.slice(3).split('~');
  return pair.length === 2 && pair.includes(me) ? (pair[0] === me ? pair[1] : pair[0]) : null;
};
export const newChatId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ---- 團隊小助理: a fixed member of every room; the server answers and writes the reply into the room ----
export const ASSISTANT_ID = 'dhc-assistant';
export const ASSISTANT_NAME = '團隊小助理';
export const ASSISTANT_MENTION = `@${ASSISTANT_NAME}`;
/** Every way to call it, newest first: messages from before the 10/24 rename (@團隊小助手) still count, so they can be retried. */
export const ASSISTANT_MENTIONS = [ASSISTANT_MENTION, '@團隊小助手', '@小助理'];
/** 10/24 roles (files in ~/.cloudcli/assistant/roles): @覆核 @審查 @值班 call the assistant in a named role.
 * 10/25: only the fallback now; once GET /api/assistant/bots answers, its list (team roles and own bots) is used. */
export const ROLE_MENTIONS = ['@覆核', '@審查', '@值班'];
let callMentions: string[] = ROLE_MENTIONS;
/**
 * 10/25: where a mention counts as a call. Not right after an ASCII letter, digit or one of ._%+- (an email such as
 * x@算帳.com) or after @ (@@ quotes a chat); after Chinese, a space, punctuation or at the start it does, so 請@覆核
 * calls. -1 when it never does. Same rule as mentionAt in the server's assistant.service.ts.
 */
export function mentionAt(text: string, mention: string): number {
  for (let at = text.indexOf(mention); at >= 0; at = text.indexOf(mention, at + 1)) {
    if (!/[A-Za-z0-9._%+\-@]/.test(at === 0 ? '' : text[at - 1])) return at;
  }
  return -1;
}
export const mentionsAssistant = (text: string) => [...ASSISTANT_MENTIONS, ...callMentions].some((mention) => mentionAt(text, mention) >= 0);
const ASSISTANT_POLL_MS = 3_000;

/** A message that calls the assistant: it mentions it, or it is said in your private chat with it. */
export const callsAssistant = (roomId: string, text: string, person: string) => (
  mentionsAssistant(text) || dmPeer(roomId, person) === ASSISTANT_ID
);

/** `@ALL` in 動態 makes a post an announcement to everyone but 團隊小助理; it stays pinned until each person presses 已讀. */
export const isAnnouncement = (roomId: string, message: ChatMessage) => (
  roomId === LOBBY && message.by !== ASSISTANT_ID && /@ALL(?![A-Za-z0-9_])/i.test(message.text)
);
export const announcementKey = (id: string) => `ann:${id}`;
export const announcementUnread = (seen: Record<string, string>, person: string | null, message: ChatMessage) => (
  !!person && message.by !== person && !seen[announcementKey(message.id)]
);

/** Resolves once every queued chat save has reached the server. */
export const flushChatWrites = (): Promise<void> => writeChain;

const NO_RUNNING: string[] = [];
let assistantRunning: Record<string, string[]> = {};
/** 10/21: what the running answer is doing right now (「在資料庫主機跑指令」), shown on the 思考中 line. */
let assistantStep: Record<string, string> = {};
/** 11/02 (MausBot NowStep): the newest few steps of the latest running answer, with how each went. */
export type TrailStep = { label: string; state: 'now' | 'done' | 'failed' | 'empty' };
const NO_TRAIL: TrailStep[] = [];
const TRAIL_STATES = ['now', 'done', 'failed', 'empty'];
let assistantTrail: Record<string, TrailStep[]> = {};
const setAssistantRunning = (roomId: string, list: string[]) => {
  const before = assistantRunning[roomId] ?? NO_RUNNING;
  if (before.length === list.length && before.every((at, index) => at === list[index])) return;
  assistantRunning = { ...assistantRunning, [roomId]: list };
  notify();
  // The reply is in the room once nothing is running any more.
  if (before.length > 0 && list.length === 0) {
    void loadChat();
    void loadAssistantCards(roomId);
  }
};

async function pollAssistant(roomId: string): Promise<void> {
  try {
    const response = await authenticatedFetch(`/api/assistant/status?roomId=${encodeURIComponent(roomId)}`);
    if (!response.ok) return;
    const payload = (await response.json()) as { data?: { running?: unknown } };
    const list = Array.isArray(payload.data?.running) ? payload.data.running.filter((at): at is string => typeof at === 'string') : [];
    const steps = (payload.data as { steps?: unknown } | undefined)?.steps;
    const step = steps && typeof steps === 'object' ? Object.values(steps as Record<string, unknown>).filter((value): value is string => typeof value === 'string').at(-1) ?? '' : '';
    if ((assistantStep[roomId] ?? '') !== step) {
      assistantStep = { ...assistantStep, [roomId]: step };
      notify();
    }
    const rawTrail = (payload.data as { trail?: unknown } | undefined)?.trail;
    const latest = rawTrail && typeof rawTrail === 'object' ? Object.entries(rawTrail as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).at(-1)?.[1] : undefined;
    const trail = Array.isArray(latest)
      ? latest.filter((item): item is TrailStep => !!item && typeof item.label === 'string' && TRAIL_STATES.includes(item.state)).slice(-5)
      : NO_TRAIL;
    const beforeTrail = assistantTrail[roomId] ?? NO_TRAIL;
    if (beforeTrail.length !== trail.length || beforeTrail.some((item, index) => item.label !== trail[index].label || item.state !== trail[index].state)) {
      assistantTrail = { ...assistantTrail, [roomId]: trail.length ? trail : NO_TRAIL };
      notify();
    }
    setAssistantRunning(roomId, list);
  } catch {
    // Offline for a moment; the next poll tries again.
  }
}

/** 10/25: a call that met 忙線 (429): shown as a line in the room instead of alert(); `auto` while one retry is due. */
export type AssistantBusy = { message: ChatMessage; person: string; aboutRoom?: string; auto: boolean };
export const BUSY_RETRY_MS = 30_000;
let assistantBusy: Record<string, AssistantBusy | null> = {};
const setAssistantBusy = (roomId: string, busy: AssistantBusy | null) => {
  if ((assistantBusy[roomId] ?? null) === busy) return;
  assistantBusy = { ...assistantBusy, [roomId]: busy };
  notify();
};
export const useAssistantBusy = (roomId: string | null): AssistantBusy | null => useSyncExternalStore(subscribe, () => (roomId ? assistantBusy[roomId] ?? null : null), () => null);
/** 重試 on the busy line: asks again about the same message. */
export function retryBusy(roomId: string): void {
  const busy = assistantBusy[roomId];
  if (busy) void askAssistant(roomId, busy.message, busy.person, busy.aboutRoom);
}
export const dismissBusy = (roomId: string) => setAssistantBusy(roomId, null);

/** Saves first (the server reads the message from the room), then asks; 429 means three are running already.
 * `aboutRoom` (10/21 只回我): asked in your private chat about that room, the answer stays private.
 * 10/25: on 429 the room shows a busy line and asks once more by itself 30 s later; after that only 重試 asks. */
export async function askAssistant(roomId: string, message: ChatMessage, person: string, aboutRoom?: string): Promise<void> {
  await flushChatWrites();
  const response = await authenticatedFetch('/api/assistant/reply', {
    method: 'POST',
    body: JSON.stringify({ roomId, triggerAt: message.at, profileId: person, ...(aboutRoom ? { aboutRoom } : {}) }),
  });
  if (response.status === 429) {
    const retried = assistantBusy[roomId]?.message.at === message.at;
    const busy: AssistantBusy = { message, person, ...(aboutRoom ? { aboutRoom } : {}), auto: !retried };
    setAssistantBusy(roomId, busy);
    if (!retried) window.setTimeout(() => { if (assistantBusy[roomId] === busy) void askAssistant(roomId, message, person, aboutRoom); }, BUSY_RETRY_MS);
    return;
  }
  setAssistantBusy(roomId, null);
  if (response.status === 202) setAssistantRunning(roomId, [...(assistantRunning[roomId] ?? NO_RUNNING), message.at]);
}

/**
 * 10/25: asks when the message calls the assistant. A message with an @ the page does not know reloads the list of
 * mentions once first, so a bot someone made after this page opened is called without a refresh. True when asked.
 */
export async function askIfCalled(roomId: string, message: ChatMessage, person: string): Promise<boolean> {
  if (!callsAssistant(roomId, message.text, person)) {
    if (!message.text.includes('@')) return false;
    await loadBots(person);
    if (!callsAssistant(roomId, message.text, person)) return false;
  }
  await askAssistant(roomId, message, person);
  return true;
}

/** 停止: ends the answers still running in the room; each leaves a stop note instead of a reply. */
export async function stopAssistant(roomId: string, person: string): Promise<void> {
  await authenticatedFetch('/api/assistant/stop', { method: 'POST', body: JSON.stringify({ roomId, profileId: person }) });
  void pollAssistant(roomId);
}

/** The current step of the room's running answer, '' while it has not used a tool yet. */
export function useAssistantStep(roomId: string | null): string {
  return useSyncExternalStore(subscribe, () => (roomId ? assistantStep[roomId] ?? '' : ''), () => '');
}

export function useAssistantTrail(roomId: string | null): TrailStep[] {
  return useSyncExternalStore(subscribe, () => (roomId ? assistantTrail[roomId] ?? NO_TRAIL : NO_TRAIL), () => NO_TRAIL);
}

/** 11/02 (MausBot TryAsking): example questions colleagues asked before that got a good answer; [] when the server has none or is old. */
export async function loadAssistantExamples(): Promise<string[]> {
  try {
    const response = await authenticatedFetch('/api/assistant/examples');
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: { examples?: unknown } };
    const list = payload.data?.examples;
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, 4) : [];
  } catch {
    return [];
  }
}

/** A failed answer asked again: the message that called the assistant, found from the reply's replyTo. */
export function retryAssistant(roomId: string, reply: ChatMessage, person: string): void {
  const trigger = (state.rooms[roomId] ?? []).find((message) => message.id === reply.replyTo);
  if (trigger) void askAssistant(roomId, trigger, person);
}

// ---- 團隊小助理 action cards (10/20): an action it held for a person to press. They live on the server per room,
// not in the room's messages, because a page that has not reloaded drops unknown message fields when it saves. ----
export type AssistantCardStatus = 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'expired';
export type AssistantCard = { id: string; messageId: string; kind?: 'action' | 'patrol' | 'borrow'; tool: string; summary: string; detail: string; status: AssistantCardStatus; by?: string; doneAt?: string };
const NO_CARDS: AssistantCard[] = [];
let assistantCards: Record<string, AssistantCard[]> = {};
/** 10/21 follow-up chips: the 1–3 likely next asks under the room's latest answer. */
export type AssistantNext = { messageId: string; items: string[] };
let assistantNext: Record<string, AssistantNext | null> = {};

/** The chips for a room's latest answer (loaded with its cards), or null. */
export function useAssistantNext(roomId: string | null): AssistantNext | null {
  return useSyncExternalStore(subscribe, () => (roomId ? assistantNext[roomId] ?? null : null), () => null);
}

export async function loadAssistantCards(roomId: string): Promise<void> {
  try {
    const response = await authenticatedFetch(`/api/assistant/cards?roomId=${encodeURIComponent(roomId)}`);
    if (!response.ok) return;
    const payload = (await response.json()) as { data?: { cards?: unknown; next?: unknown } };
    const next = payload.data?.next as AssistantNext | null | undefined;
    const tidy = next && typeof next.messageId === 'string' && Array.isArray(next.items) ? { messageId: next.messageId, items: next.items.filter((item): item is string => typeof item === 'string') } : null;
    if (JSON.stringify(tidy) !== JSON.stringify(assistantNext[roomId] ?? null)) {
      assistantNext = { ...assistantNext, [roomId]: tidy };
      notify();
    }
    const raw = Array.isArray(payload.data?.cards) ? payload.data.cards : [];
    const cards = raw.filter((card): card is AssistantCard => Boolean(card) && typeof (card as AssistantCard).id === 'string' && typeof (card as AssistantCard).messageId === 'string');
    if (JSON.stringify(cards) === JSON.stringify(assistantCards[roomId] ?? NO_CARDS)) return;
    assistantCards = { ...assistantCards, [roomId]: cards };
    notify();
  } catch {
    // Offline for a moment; the next open loads them.
  }
}

/** The cards in a room; loaded when the room opens and again whenever an answer or a press finishes. */
export function useAssistantCards(roomId: string | null): AssistantCard[] {
  const cards = useSyncExternalStore(subscribe, () => (roomId ? assistantCards[roomId] ?? NO_CARDS : NO_CARDS), () => NO_CARDS);
  useEffect(() => {
    if (roomId) void loadAssistantCards(roomId);
  }, [roomId]);
  return cards;
}

/** 執行 or 取消 on a card. 執行 runs on the server; its result line arrives in the room like an answer.
 * 10/25: resolves to a plain reason when nothing happened (shown under the card, no alert()), else null. */
export async function pressAssistantCard(roomId: string, cardId: string, decision: 'approve' | 'reject', person: string): Promise<string | null> {
  const response = await authenticatedFetch(`/api/assistant/actions/${encodeURIComponent(cardId)}`, {
    method: 'POST',
    body: JSON.stringify({ decision, profileId: person }),
  });
  const reason = response.status === 429 ? '小助理忙線中（同時最多 3 件），等一下再按一次' : response.status === 403 ? '只有這個私聊的主人能按' : null;
  if (response.status === 202) await pollAssistant(roomId);
  await loadAssistantCards(roomId);
  return reason;
}

// ---- 10/25 自建小助理: each person's own bots, the team roles, and 我的小助理個性 (off unless mybots-on on the server) ----
export type MyBot = { id: string; name: string; mentions: string[]; duty: string; style: string; avatar: string; owner: string; ownerName: string; visibility: 'private' | 'public' };
export type TeamRole = { id: string; name: string; mentions: string[]; prompt: string };
export type BotsInfo = { enabled: boolean; mine: MyBot[]; public: MyBot[]; team: TeamRole[]; faces: Record<string, string>; myStyle: string };
export type BotFields = { name: string; mentions: string[]; avatar: string; duty: string; style: string; visibility: 'private' | 'public' };
const NO_BOTS: BotsInfo = { enabled: false, mine: [], public: [], team: [], faces: {}, myStyle: '' };
let botsInfo: BotsInfo = NO_BOTS;
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const parseBot = (value: unknown): MyBot | null => {
  const raw = value as Partial<MyBot> | null;
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  return {
    id: raw.id, name: raw.name, mentions: strings(raw.mentions), duty: str(raw.duty), style: str(raw.style), avatar: str(raw.avatar) || raw.name.slice(0, 1),
    owner: str(raw.owner), ownerName: str(raw.ownerName), visibility: raw.visibility === 'public' ? 'public' : 'private',
  };
};

/** Takes the server's answer: the bots for the panel, and every mention the page must send to the server. */
export function applyBots(data: unknown): void {
  const raw = (data ?? {}) as Record<string, unknown>;
  const list = (value: unknown) => (Array.isArray(value) ? value.map(parseBot).filter((bot): bot is MyBot => bot !== null) : []);
  const team = (Array.isArray(raw.team) ? raw.team : []).map((role) => role as Partial<TeamRole>)
    .filter((role) => typeof role?.name === 'string')
    .map((role) => ({ id: str(role.id), name: str(role.name), mentions: strings(role.mentions), prompt: str(role.prompt) }));
  const faces = raw.faces && typeof raw.faces === 'object' ? Object.fromEntries(Object.entries(raw.faces as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
  if (Array.isArray(raw.mentions)) callMentions = strings(raw.mentions).filter((mention) => mention.length > 1 && mention.startsWith('@'));
  botsInfo = { enabled: raw.enabled === true, mine: list(raw.mine), public: list(raw.public), team, faces, myStyle: str(raw.myStyle) };
  notify();
}

export async function loadBots(person: string | null): Promise<void> {
  try {
    const response = await authenticatedFetch(`/api/assistant/bots?profileId=${encodeURIComponent(person ?? '')}`);
    if (!response.ok) return;
    applyBots(((await response.json()) as { data?: unknown }).data);
  } catch {
    // Offline for a moment; the fallback mentions still work.
  }
}

export const useBots = (): BotsInfo => useSyncExternalStore(subscribe, () => botsInfo, () => botsInfo);

/** The face of a bot's answer: its avatar when the reply starts with 【name】 of a known bot, else null. */
export const botFace = (text: string, faces: Record<string, string>): string | null => {
  const name = botSpeaker(text, faces);
  return name === null ? null : faces[name];
};

/** 11/04 AI 辦公室: the helper that wrote this answer (the 【name】 the server puts first), or null for 團隊小助理 itself. */
export const botSpeaker = (text: string, faces: Record<string, string>): string | null => {
  const match = /^【([^】]{1,12})】/.exec(text);
  return match && Object.prototype.hasOwnProperty.call(faces, match[1]) ? match[1] : null;
};

/** Sends a change and reloads; resolves to the server's reason when it refused, else null. */
async function changeBots(person: string, url: string, method: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    const response = await authenticatedFetch(url, { method, body: JSON.stringify({ ...body, profileId: person }) });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
      return typeof payload?.error?.message === 'string' ? payload.error.message : '沒有存成功，稍後再試';
    }
    await loadBots(person);
    return null;
  } catch {
    return '連不到主機，稍後再試';
  }
}
export const saveBot = (person: string, fields: BotFields, id?: string) => changeBots(person, id ? `/api/assistant/bots/${encodeURIComponent(id)}` : '/api/assistant/bots', id ? 'PUT' : 'POST', fields);
export const removeBot = (person: string, id: string) => changeBots(person, `/api/assistant/bots/${encodeURIComponent(id)}`, 'DELETE', {});
export const saveMyStyle = (person: string, style: string) => changeBots(person, '/api/assistant/style', 'PUT', { style });

/** True while the assistant is answering in this room; polls every 3 s while it is, and once when the room opens. */
export function useAssistantThinking(roomId: string | null): boolean {
  const running = useSyncExternalStore(subscribe, () => (roomId ? assistantRunning[roomId] ?? NO_RUNNING : NO_RUNNING), () => NO_RUNNING);
  const active = running.length > 0;
  useEffect(() => {
    if (roomId) void pollAssistant(roomId);
  }, [roomId]);
  useEffect(() => {
    if (!roomId || !active) return undefined;
    const timer = window.setInterval(() => void pollAssistant(roomId), ASSISTANT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [roomId, active]);
  return active;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

function parseRef(value: unknown): ChatRef | null {
  const raw = value as Partial<ChatRef> | null;
  if (!raw || (raw.kind !== 'person' && raw.kind !== 'session' && raw.kind !== 'board') || !str(raw.id)) return null;
  return { kind: raw.kind, id: str(raw.id), label: str(raw.label) };
}

const parseRefs = (value: unknown) => (Array.isArray(value) ? value.map(parseRef).filter((ref): ref is ChatRef => ref !== null) : []);

/** A stored name is a bare file name; anything that could point outside the assets folder is dropped. */
function parseFiles(value: unknown): ChatFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = item as Partial<ChatFile> | null;
    const stored = str(raw?.stored);
    if (!raw || !stored || /[\\/]|\.\./.test(stored)) return [];
    return [{ name: str(raw.name) || stored, stored, size: Math.max(0, num(raw.size, 0)), type: str(raw.type) }];
  });
}

export function parseMessages(value: unknown): ChatMessage[] {
  const raw = value && typeof value === 'object' ? (value as { msgs?: unknown }).msgs : null;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const message = item as Partial<ChatMessage> | null;
    if (!message || !str(message.id) || !str(message.by) || !str(message.at)) return [];
    const parsed: ChatMessage = { id: str(message.id), by: str(message.by), text: str(message.text), at: str(message.at), refs: parseRefs(message.refs) };
    const share = parseRef(message.share);
    if (share) parsed.share = share;
    const files = parseFiles(message.files);
    if (files.length > 0) parsed.files = files;
    if (str(message.replyTo)) parsed.replyTo = str(message.replyTo);
    if (message.failed === true) parsed.failed = true;
    if (message.reactions && typeof message.reactions === 'object') {
      const reactions: Record<string, string[]> = {};
      for (const [emoji, who] of Object.entries(message.reactions)) {
        const list = Array.isArray(who) ? who.filter((id): id is string => typeof id === 'string') : [];
        if (list.length > 0) reactions[emoji] = Array.from(new Set(list));
      }
      if (Object.keys(reactions).length > 0) parsed.reactions = reactions;
    }
    return [parsed];
  }).sort((a, b) => a.at.localeCompare(b.at));
}

export function parseNotes(value: unknown): StickyNote[] {
  const raw = value && typeof value === 'object' ? (value as { items?: unknown }).items : null;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const note = item as Partial<StickyNote> | null;
    const target = note?.target as Partial<NoteTarget> | undefined;
    if (!note || !str(note.id) || !target || (target.kind !== 'session' && target.kind !== 'board') || !str(target.id)) return [];
    const parsed: StickyNote = {
      id: str(note.id),
      target: { kind: target.kind, id: str(target.id), title: str(target.title) },
      by: str(note.by),
      text: str(note.text),
      refs: parseRefs(note.refs),
      color: NOTE_COLORS.includes(note.color as NoteColor) ? note.color as NoteColor : 'yellow',
      w: Math.max(120, num(note.w, 220)),
      h: Math.max(56, num(note.h, 140)),
      at: str(note.at),
      updatedAt: str(note.updatedAt) || str(note.at),
    };
    if (str(note.anchor)) parsed.anchor = str(note.anchor);
    if (typeof note.dy === 'number') parsed.dy = note.dy;
    if (typeof note.xFrac === 'number') parsed.xFrac = Math.min(1, Math.max(0, note.xFrac));
    if (typeof note.x === 'number') parsed.x = note.x;
    if (typeof note.y === 'number') parsed.y = note.y;
    return [parsed];
  });
}

const parseSeen = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
};

// ---- store ----
type State = {
  rooms: Record<string, ChatMessage[]>;
  notes: StickyNote[];
  seen: Record<string, string>;
};
let state: State = { rooms: {}, notes: [], seen: {} };
let me: string | null = null;
let writesInFlight = 0;
let writeChain: Promise<void> = Promise.resolve();
let panelOpen = false;
let lastLoadAt = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = () => listeners.forEach((listener) => listener());
const setState = (next: Partial<State>) => {
  state = { ...state, ...next };
  notify();
};

// ---- 11/01 未送出: a message whose save failed stays here (and in localStorage, so a reload keeps it) until it is saved ----
const UNSENT_KEY = 'dhc.chatUnsent';
const readUnsent = (): Record<string, ChatMessage[]> => {
  try {
    const raw = JSON.parse(localStorage.getItem(UNSENT_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).map(([room, list]) => [room, parseMessages({ msgs: list })] as const).filter(([, list]) => list.length > 0));
  } catch {
    return {};
  }
};
let unsent: Record<string, ChatMessage[]> = readUnsent();
const saveUnsent = () => {
  try {
    if (Object.keys(unsent).length > 0) localStorage.setItem(UNSENT_KEY, JSON.stringify(unsent));
    else localStorage.removeItem(UNSENT_KEY);
  } catch {
    // Storage blocked: they last for this page load.
  }
};
const dropUnsent = (roomId: string, id: string) => {
  const rest = (unsent[roomId] ?? []).filter((message) => message.id !== id);
  const { [roomId]: _old, ...others } = unsent;
  unsent = rest.length > 0 ? { ...others, [roomId]: rest } : others;
  saveUnsent();
};
/** The server's rooms with the unsent messages put back in (flagged); one the server already has was saved after all. */
const withUnsent = (rooms: Record<string, ChatMessage[]>): Record<string, ChatMessage[]> => {
  let next = rooms;
  for (const [roomId, list] of Object.entries(unsent)) {
    const here = rooms[roomId] ?? [];
    const merged = [...here.filter((item) => !list.some((message) => message.id === item.id)), ...list.map((message) => ({ ...message, unsent: true }))];
    next = { ...next, [roomId]: merged.sort((a, b) => a.at.localeCompare(b.at)) };
  }
  return next;
};
const settleUnsent = (rooms: Record<string, ChatMessage[]>) => {
  // Anything the server now has leaves the unsent store.
  for (const [roomId, list] of Object.entries(unsent)) {
    for (const message of list) if ((rooms[roomId] ?? []).some((item) => item.id === message.id)) dropUnsent(roomId, message.id);
  }
};

async function fetchRows(): Promise<Record<string, unknown>> {
  const response = await api.user.preferences();
  if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
  const payload = (await response.json()) as { preferences?: Record<string, unknown> };
  return payload.preferences ?? {};
}

function readRooms(rows: Record<string, unknown>): Record<string, ChatMessage[]> {
  const rooms: Record<string, ChatMessage[]> = {};
  for (const [key, value] of Object.entries(rows)) {
    if (key.startsWith(ROOM_PREFIX)) rooms[key.slice(ROOM_PREFIX.length)] = parseMessages(value);
  }
  return rooms;
}

export async function loadChat(): Promise<void> {
  lastLoadAt = Date.now();
  try {
    const rows = await fetchRows();
    if (writesInFlight > 0) return;
    const rooms = readRooms(rows);
    settleUnsent(rooms);
    setState({ rooms: withUnsent(rooms), notes: parseNotes(rows[NOTES_KEY]), seen: me ? parseSeen(rows[SEEN_PREFIX + me]) : {} });
  } catch (error) {
    console.error('[ChatRoom] Failed to load:', error);
  }
}

/** Who this page is (the device's linked project); the seen marks are theirs. */
export function setChatMe(projectId: string | null): void {
  if (me === projectId) return;
  me = projectId;
  void loadChat();
}

/** Polls every 5 s while the panel is open, once a minute otherwise (only while the page is in view). */
export function startChatSync(): () => void {
  void loadChat();
  const tick = () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastLoadAt >= (panelOpen ? POLL_OPEN_MS : POLL_CLOSED_MS) - 500) void loadChat();
  };
  const timer = window.setInterval(tick, POLL_OPEN_MS);
  document.addEventListener('visibilitychange', tick);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
  };
}

function queueWrite(apply: () => void, save: (rows: Record<string, unknown>) => Record<string, unknown>, after?: { ok?: () => void; failed?: () => void }): void {
  apply();
  writesInFlight += 1;
  writeChain = writeChain.then(async () => {
    try {
      const updates = save(await fetchRows());
      const response = await api.user.savePreferences(updates);
      if (!response.ok) throw new Error(`Failed to save (${response.status})`);
      after?.ok?.();
    } catch (error) {
      console.error('[ChatRoom] Failed to save:', error);
      after?.failed?.();
      alert(after?.failed ? '訊息沒有存到伺服器，已標成「未送出」，網路好了可以按「重試」。' : '聊天室或便利貼沒有存到伺服器，請稍後重新整理再試一次。');
    } finally {
      writesInFlight -= 1;
    }
  });
}

function changeRoom(roomId: string, change: (messages: ChatMessage[]) => ChatMessage[], after?: { ok?: () => void; failed?: () => void }): void {
  queueWrite(
    () => setState({ rooms: { ...state.rooms, [roomId]: change(state.rooms[roomId] ?? []) } }),
    (rows) => {
      const next = change(parseMessages(rows[ROOM_PREFIX + roomId])).sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_MESSAGES);
      return { [ROOM_PREFIX + roomId]: { msgs: next } };
    },
    after,
  );
}

/** Shows the message as 未送出 (kept on this device) after its save failed. */
function markUnsent(roomId: string, message: ChatMessage): void {
  unsent = { ...unsent, [roomId]: [...(unsent[roomId] ?? []).filter((item) => item.id !== message.id), message] };
  saveUnsent();
  setState({ rooms: withUnsent(state.rooms) });
}
/** The save went through: the message is a normal one now. */
function markSent(roomId: string, id: string): void {
  dropUnsent(roomId, id);
  setState({ rooms: { ...state.rooms, [roomId]: (state.rooms[roomId] ?? []).map((item) => {
    if (item.id !== id) return item;
    const { unsent: _flag, ...rest } = item;
    return rest;
  }) } });
}

export function sendChatMessage(roomId: string, message: Omit<ChatMessage, 'id' | 'at'>): ChatMessage {
  const full: ChatMessage = { ...message, text: message.text.slice(0, MAX_TEXT), id: newChatId(), at: new Date().toISOString() };
  changeRoom(roomId, (messages) => [...messages.filter((item) => item.id !== full.id), full], { failed: () => markUnsent(roomId, full) });
  if (message.by === me) markSeen(roomId);
  return full;
}

/** 重試 on an 未送出 message: saves it again; it stays marked until the save goes through. */
export function retryChatMessage(roomId: string, id: string): void {
  const message = (unsent[roomId] ?? []).find((item) => item.id === id);
  if (!message) return;
  changeRoom(roomId, (messages) => [...messages.filter((item) => item.id !== id), message], { ok: () => markSent(roomId, id), failed: () => markUnsent(roomId, message) });
  // changeRoom shows the plain copy at once; put the mark back until the save has gone through.
  setState({ rooms: withUnsent(state.rooms) });
}

export function deleteChatMessage(roomId: string, id: string): void {
  if ((unsent[roomId] ?? []).some((item) => item.id === id)) dropUnsent(roomId, id);
  changeRoom(roomId, (messages) => messages.filter((item) => item.id !== id));
}

export function toggleReaction(roomId: string, id: string, emoji: string, person: string): void {
  changeRoom(roomId, (messages) => messages.map((item) => {
    if (item.id !== id) return item;
    const who = item.reactions?.[emoji] ?? [];
    const list = who.includes(person) ? who.filter((p) => p !== person) : [...who, person];
    const reactions = { ...(item.reactions ?? {}) };
    if (list.length > 0) reactions[emoji] = list;
    else delete reactions[emoji];
    const { reactions: _old, ...rest } = item;
    return Object.keys(reactions).length > 0 ? { ...rest, reactions } : rest;
  }));
}

function changeNotes(change: (notes: StickyNote[]) => StickyNote[]): void {
  queueWrite(
    () => setState({ notes: change(state.notes) }),
    (rows) => ({ [NOTES_KEY]: { items: change(parseNotes(rows[NOTES_KEY])) } }),
  );
}

export function addNote(note: Omit<StickyNote, 'id' | 'at' | 'updatedAt'>): StickyNote {
  const at = new Date().toISOString();
  const full: StickyNote = { ...note, id: newChatId(), at, updatedAt: at };
  changeNotes((notes) => [...notes, full]);
  return full;
}

/** Text edits arrive per keystroke; the note shows them at once and the save waits for a pause (11/01: 完成 and leaving the page skip the wait). */
const noteTimers = new Map<string, number>();
const commitNote = (id: string) => {
  noteTimers.delete(id);
  writesInFlight -= 1;
  const latest = state.notes.find((note) => note.id === id);
  if (latest) changeNotes((notes) => notes.map((note) => (note.id === id ? latest : note)));
};
/** Saves a note's pending edit now, if it has one. */
export function flushNote(id: string): void {
  const pending = noteTimers.get(id);
  if (pending === undefined) return;
  window.clearTimeout(pending);
  commitNote(id);
}
export const flushNotes = (): void => [...noteTimers.keys()].forEach(flushNote);
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushNotes);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNotes(); });
}
export function updateNote(id: string, patch: Partial<Omit<StickyNote, 'id' | 'at'>>): void {
  const apply = (notes: StickyNote[]) => notes.map((note) => (note.id === id ? { ...note, ...patch, updatedAt: new Date().toISOString() } : note));
  setState({ notes: apply(state.notes) });
  const pending = noteTimers.get(id);
  if (pending) window.clearTimeout(pending);
  else writesInFlight += 1;
  noteTimers.set(id, window.setTimeout(() => commitNote(id), 700));
}

export function removeNote(id: string): void {
  changeNotes((notes) => notes.filter((note) => note.id !== id));
}

/** Looking at a room, session or whiteboard clears its unread mentions (for this person, on every device). */
export function markSeen(key: string): void {
  if (!me) return;
  const person = me;
  const at = new Date().toISOString();
  if ((state.seen[key] ?? '') >= at) return;
  queueWrite(
    () => setState({ seen: { ...state.seen, [key]: at } }),
    (rows) => {
      const server = parseSeen(rows[SEEN_PREFIX + person]);
      const merged = { ...server };
      for (const [k, v] of Object.entries(state.seen)) if (!merged[k] || merged[k] < v) merged[k] = v;
      return { [SEEN_PREFIX + person]: merged };
    },
  );
}

// ---- panel ----
/** `members`: who can see a whiteboard (its owner and Co-Work members), to offer inviting anyone mentioned outside it. */
export type ChatContext = { kind: 'session' | 'board'; id: string; title: string; ownerProjectId?: string; provider?: string; members?: string[] };
type Panel = { open: boolean; room: string | null; context: ChatContext | null; boardContext: ChatContext | null };
let panel: Panel = { open: false, room: null, context: null, boardContext: null };
const setPanel = (next: Partial<Panel>) => {
  panel = { ...panel, ...next };
  panelOpen = panel.open;
  notify();
  if (panel.open && Date.now() - lastLoadAt > 2_000) void loadChat();
};
export const openChatPanel = (room: string | null = null) => setPanel({ open: true, room });
export const closeChatPanel = () => setPanel({ open: false });
/** The open session (from the workspace header) and the open whiteboard: each gets its own room tab. */
export const setChatContext = (context: ChatContext | null) => {
  if (JSON.stringify(context) !== JSON.stringify(panel.context)) setPanel({ context });
};
export const setBoardContext = (context: ChatContext | null) => {
  if (JSON.stringify(context) !== JSON.stringify(panel.boardContext)) setPanel({ boardContext: context });
};
export const useChatPanel = (): Panel => useSyncExternalStore(subscribe, () => panel, () => panel);

// ---- board jumps: the tool library opens the whiteboard window on this board ----
let boardRequest: { id: string; nonce: number } | null = null;
export function requestOpenBoard(id: string): void {
  boardRequest = { id, nonce: Date.now() };
  notify();
}
export const useBoardRequest = () => useSyncExternalStore(subscribe, () => boardRequest, () => null);
export const clearBoardRequest = () => {
  boardRequest = null;
  notify();
};
/** 10/25: 打開工具庫 from the chat (the starter buttons in the private chat with 團隊小助理); 自選功能 opens it. */
let libraryRequest = 0;
export function requestOpenLibrary(): void {
  libraryRequest = Date.now();
  notify();
}
export const useLibraryRequest = () => useSyncExternalStore(subscribe, () => libraryRequest, () => 0);
export const clearLibraryRequest = () => {
  libraryRequest = 0;
  notify();
};
/** 10/25 R4 (稽核 P1-2): a 「打開：試算工作台」 follow-up chip opens that tool; 自選功能 (ProjectWishPool) opens the window. */
let toolRequest: string | null = null;
export function requestOpenTool(id: string): void {
  toolRequest = id;
  notify();
}
export const useToolRequest = () => useSyncExternalStore(subscribe, () => toolRequest, () => null);
export const clearToolRequest = () => {
  toolRequest = null;
  notify();
};
/** The tool name in a 「打開：工具名」 chip (full-width or ASCII colon), else null. */
export const openToolName = (item: string): string | null => {
  const match = /^打開[：:]\s*(.+)$/.exec(item.trim());
  return match ? match[1].trim() : null;
};

// ---- 10/25 R4 (稽核 P1-1): a tool's result into the chat, as plain text (tool, title, the first 1500 characters) ----
export const TOOL_SUMMARY_CHARS = 1500;
export function toolSummary(toolName: string, title: string, body: string): string {
  const text = body.trim();
  const cut = Array.from(text);
  const shown = cut.length > TOOL_SUMMARY_CHARS ? `${cut.slice(0, TOOL_SUMMARY_CHARS).join('')}\n…（後面還有 ${cut.length - TOOL_SUMMARY_CHARS} 字沒貼）` : text;
  return `【${toolName}】${title.trim() || '（未命名）'}\n${shown}`;
}
/** 貼到聊天室…: waits in the composer of the room the panel shows (動態 first), so the person picks the room and sends. */
let chatDraft: string | null = null;
export const useChatDraft = () => useSyncExternalStore(subscribe, () => chatDraft, () => null);
export const takeChatDraft = (): string | null => {
  const draft = chatDraft;
  chatDraft = null;
  if (draft !== null) notify();
  return draft;
};
/**
 * 'chat' puts the summary in a composer (nothing is sent yet); 'assistant' sends it with @團隊小助理 to your private
 * chat with it and asks. False when this device has no 你是誰 yet (the panel opens and offers to choose).
 */
export function postToolSummary(target: 'chat' | 'assistant', toolName: string, title: string, body: string): boolean {
  const summary = toolSummary(toolName, title, body);
  if (target === 'chat') {
    chatDraft = summary;
    openChatPanel(LOBBY);
    return true;
  }
  if (!me) {
    openChatPanel();
    return false;
  }
  const room = dmRoom(me, ASSISTANT_ID);
  const sent = sendChatMessage(room, { by: me, text: `${ASSISTANT_MENTION} 幫我看一下這份${toolName}的內容：\n${summary}`, refs: [] });
  void askAssistant(room, sent, me);
  openChatPanel(room);
  return true;
}

// ---- sticky-note placement: 便利貼 next to the beaker arms it, the next drag on the transcript or board draws one ----
let placing: NoteTarget | null = null;
export function armNotePlacement(target: NoteTarget | null): void {
  placing = target;
  notify();
}
export const useNotePlacement = () => useSyncExternalStore(subscribe, () => placing, () => null);

// ---- reads ----
const NO_MESSAGES: ChatMessage[] = [];
const NO_NOTES: StickyNote[] = [];
export const useChatState = (): State => useSyncExternalStore(subscribe, () => state, () => state);
export const useRoom = (roomId: string | null) => useSyncExternalStore(subscribe, () => (roomId ? state.rooms[roomId] ?? NO_MESSAGES : NO_MESSAGES), () => NO_MESSAGES);

// One cached list per target: a single shared slot made a session layer and a board layer mounted together
// evict each other, so every snapshot read returned a new array and React looped (minified error #185).
const notesCache = new WeakMap<StickyNote[], Map<string, StickyNote[]>>();
export function useNotesOn(kind: NoteTarget['kind'], id: string | null | undefined): StickyNote[] {
  return useSyncExternalStore(subscribe, () => {
    if (!id) return NO_NOTES;
    let byTarget = notesCache.get(state.notes);
    if (!byTarget) notesCache.set(state.notes, (byTarget = new Map()));
    const key = `${kind}:${id}`;
    let list = byTarget.get(key);
    if (!list) byTarget.set(key, (list = state.notes.filter((note) => note.target.kind === kind && note.target.id === id)));
    return list;
  }, () => NO_NOTES);
}

const mentions = (refs: ChatRef[], person: string) => refs.some((ref) => ref.kind === 'person' && ref.id === person);

/**
 * Where `person` is mentioned and has not looked yet, by place: `s:<id>`, `b:<id>`, a room id. A mention in a
 * session's or board's room and one on its notes count for the same place.
 */
export function unreadMentions(current: State, person: string | null): Map<string, number> {
  const unread = new Map<string, number>();
  if (!person) return unread;
  const add = (key: string, at: string) => {
    if ((current.seen[key] ?? '') < at) unread.set(key, (unread.get(key) ?? 0) + 1);
  };
  for (const [roomId, messages] of Object.entries(current.rooms)) {
    for (const message of messages) {
      if (isAnnouncement(roomId, message)) {
        // Unread until 已讀, not until the room is opened.
        if (announcementUnread(current.seen, person, message)) unread.set(roomId, (unread.get(roomId) ?? 0) + 1);
        continue;
      }
      if (message.by !== person && mentions(message.refs, person)) add(roomId, message.at);
    }
  }
  for (const note of current.notes) {
    if (note.by !== person && mentions(note.refs, person)) add(note.target.kind === 'session' ? roomOfSession(note.target.id) : roomOfBoard(note.target.id), note.updatedAt);
  }
  return unread;
}

/** Private chats with new messages from the other person, by room. */
export function unreadDirect(current: State, person: string | null): Map<string, number> {
  const unread = new Map<string, number>();
  if (!person) return unread;
  for (const [roomId, messages] of Object.entries(current.rooms)) {
    if (!dmPeer(roomId, person)) continue;
    const seen = current.seen[roomId] ?? '';
    const count = messages.filter((message) => message.by !== person && message.at > seen).length;
    if (count > 0) unread.set(roomId, count);
  }
  return unread;
}

/** The people `person` last had a private chat with, newest first; 團隊小助理 is left out (it has its own spot). */
export function recentContacts(current: State, person: string | null, limit = 2): string[] {
  if (!person) return [];
  return Object.entries(current.rooms)
    .map(([roomId, messages]) => ({ peer: dmPeer(roomId, person), at: messages.at(-1)?.at ?? '' }))
    .filter((row): row is { peer: string; at: string } => !!row.peer && row.peer !== ASSISTANT_ID && row.at !== '')
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map((row) => row.peer);
}

export type ChatLightKind = 'direct' | 'assistant' | 'notice';
export type ChatLight = { count: number; since: string };

/**
 * The chat handle's lights for `person`: 私訊 and @ mentions (direct), 團隊小助理's private chat (assistant), unread
 * 公告 (notice). `since` is the oldest unread item, so the light that came on first can take the first corner.
 */
export function unreadLights(current: State, person: string | null): Partial<Record<ChatLightKind, ChatLight>> {
  const lights: Partial<Record<ChatLightKind, ChatLight>> = {};
  if (!person) return lights;
  const add = (kind: ChatLightKind, at: string) => {
    const light = lights[kind];
    lights[kind] = light ? { count: light.count + 1, since: at < light.since ? at : light.since } : { count: 1, since: at };
  };
  for (const [roomId, messages] of Object.entries(current.rooms)) {
    const peer = dmPeer(roomId, person);
    const seen = current.seen[roomId] ?? '';
    for (const message of messages) {
      if (message.by === person) continue;
      if (peer) {
        if (message.at > seen) add(peer === ASSISTANT_ID ? 'assistant' : 'direct', message.at);
      } else if (isAnnouncement(roomId, message)) {
        if (announcementUnread(current.seen, person, message)) add('notice', message.at);
      } else if (mentions(message.refs, person) && message.at > seen) add('direct', message.at);
    }
  }
  for (const note of current.notes) {
    const key = note.target.kind === 'session' ? roomOfSession(note.target.id) : roomOfBoard(note.target.id);
    if (note.by !== person && mentions(note.refs, person) && (current.seen[key] ?? '') < note.updatedAt) add('direct', note.updatedAt);
  }
  return lights;
}

let mentionCache:{ state: State | null; me: string | null; value: Map<string, number> } = { state: null, me: null, value: new Map() };
/** Unread mentions of this page's person, by place (see `unreadMentions`); one Map identity until they change. */
export function useMyMentions(): Map<string, number> {
  return useSyncExternalStore(subscribe, () => {
    if (mentionCache.state !== state || mentionCache.me !== me) mentionCache = { state, me, value: unreadMentions(state, me) };
    return mentionCache.value;
  }, () => mentionCache.value);
}
export const useChatMe = () => useSyncExternalStore(subscribe, () => me, () => null);

/** Refs whose label still appears in the text (a deleted @name drops its ref). */
export function keepMentioned(text: string, refs: ChatRef[]): ChatRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return text.includes(`${ref.kind === 'person' ? '@' : '@@'}${ref.label}`);
  });
}

export type TextPart = { text: string } | { ref: ChatRef };
/** Splits text into plain runs and the @name / @@title runs its refs point at (longest label first). */
export function splitRefs(text: string, refs: ChatRef[]): TextPart[] {
  const tokens = refs
    .map((ref) => ({ ref, token: `${ref.kind === 'person' ? '@' : '@@'}${ref.label}` }))
    .sort((a, b) => b.token.length - a.token.length);
  const parts: TextPart[] = [];
  let rest = text;
  while (rest) {
    let best: { index: number; ref: ChatRef; token: string } | null = null;
    for (const { ref, token } of tokens) {
      const index = rest.indexOf(token);
      if (index >= 0 && (!best || index < best.index)) best = { index, ref, token };
    }
    if (!best) {
      parts.push({ text: rest });
      break;
    }
    if (best.index > 0) parts.push({ text: rest.slice(0, best.index) });
    parts.push({ ref: best.ref });
    rest = rest.slice(best.index + best.token.length);
  }
  return parts;
}

export const REF_DRAG_TYPE = 'application/x-dhc-ref';

/** A session's name can be its whole first message; a tag keeps the first 40 characters on one line. */
export const clipLabel = (label: string) => {
  const line = label.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : line;
};
