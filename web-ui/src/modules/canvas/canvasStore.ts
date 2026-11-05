import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { ChatMessage } from '@/shared/types';
import { docToAutoOpen, extractCanvases, keySet, keysNotAbove, newestKeys } from '@/modules/canvas/canvasModel';
import type { CanvasDoc } from '@/modules/canvas/canvasModel';

/**
 * The open chat hands its transcript and its send function here (useCanvasFeed, two lines in ChatInterface); the
 * canvas panel beside the chat (CanvasDock in WorkspaceMain) reads them. 11/02: nothing starts by itself — only after
 * the 畫布 button is pressed in this conversation does a new HTML or SVG version open the panel.
 */
type Feed = {
  sessionId: string | null;
  projectId: string | null;
  messages: ChatMessage[];
  submitText: ((text: string) => void) | null;
};
type State = Feed & {
  open: boolean;
  activeDocId: string | null;
  /** Files' current content by path, for versions that can only be worked out backwards (see canvasModel). */
  currents: ReadonlyMap<string, string | null>;
  /** 畫布模式, pressed in this conversation; never remembered across conversations or reloads. */
  mode: boolean;
};

let state: State = { sessionId: null, projectId: null, messages: [], submitText: null, open: false, activeDocId: null, currents: new Map(), mode: false };
let docsCache: { messages: ChatMessage[]; currents: ReadonlyMap<string, string | null>; docs: CanvasDoc[] } | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  notify();
};

export function canvasDocs(): CanvasDoc[] {
  if (docsCache && docsCache.messages === state.messages && docsCache.currents === state.currents) return docsCache.docs;
  const docs = extractCanvases(state.messages, state.currents);
  docsCache = { messages: state.messages, currents: state.currents, docs };
  return docs;
}

export const useCanvasState = () => useSyncExternalStore(subscribe, () => state, () => state);
/** Just whether the panel is open: the workspace around the chat must not re-render on every streamed message. */
export const useCanvasOpen = () => useSyncExternalStore(subscribe, () => state.open, () => false);
export const useCanvasDocs = () => {
  useCanvasState();
  return canvasDocs();
};

export const openCanvas = (docId?: string | null) => set({ open: true, ...(docId !== undefined ? { activeDocId: docId } : {}) });
export const closeCanvas = () => set({ open: false });
export const selectCanvasDoc = (docId: string) => set({ activeDocId: docId });
/** The newest version's key per path when its current content was read: a later Edit/Write makes that read old. */
const currentReadAt = new Map<string, string>();
const newestKeyOfPath = (path: string) => canvasDocs().find((doc) => doc.path === path)?.versions.slice(-1)[0]?.messageKey ?? '';
export const setCanvasCurrent = (path: string, content: string | null) => {
  const currents = new Map(state.currents);
  currents.set(path, content);
  currentReadAt.set(path, newestKeyOfPath(path));
  set({ currents });
};
/** 11/01: forgets the content read for a file once a newer Edit/Write to it has arrived, so it is read again. */
export function dropStaleCurrents(): void {
  const stale = [...state.currents.keys()].filter((path) => currentReadAt.get(path) !== newestKeyOfPath(path));
  if (stale.length === 0) return;
  const currents = new Map(state.currents);
  for (const path of stale) currents.delete(path);
  state = { ...state, currents };
  docsCache = null;
}

/** 畫布模式 for the open conversation (the composer button): each turn asks Claude for a self-contained page. */
export const isCanvasMode = () => state.mode;
export const setCanvasMode = (on: boolean) => set({ mode: on });
export const useCanvasMode = () => useSyncExternalStore(subscribe, () => state.mode, () => false);

export const CANVAS_SYSTEM_NOTE = [
  '# DHC AI System 畫布模式',
  '使用者開了畫布模式（輸入框的畫布鈕）：這一輪若要交付看得到的成果（網頁、圖表、試算器、表單、簡報頁、文件），照下面做，聊天室旁的畫布會自動顯示它。',
  '- 寫成單一自含的 HTML 檔：CSS、JS、資料都內嵌，不連外部網址（內網開不了 CDN），中文介面。',
  '- 用 Write 存在目前專案資料夾的 canvas\\ 底下，檔名用英數與連字號；回覆裡不要再貼整份 HTML，只說做了什麼。',
  '- 之後要修改同一份成果，用 Edit 只改被要求的部分，不要整檔重寫，這樣畫布能保留每一版。',
  '- 使用者用「畫布框選修改」送來的訊息會附上選取的元素與選取器，只改那一段，其餘保持原樣。',
  '- 只是問答、查資料、改程式等沒有可看成果的工作，照常回答，不必硬做畫布。',
].join('\n');

/** The system-prompt append for a send: the notes that are on, joined. */
export function appendNotes(...notes: Array<string | false | null | undefined>): { appendSystemPrompt: string } | Record<string, never> {
  const text = notes.filter(Boolean).join('\n\n');
  return text ? { appendSystemPrompt: text } : {};
}

/**
 * Called by the chat with its live transcript. A new session (or the first transcript of one) only records what is
 * there; a later change that adds an HTML/SVG version opens the panel on that document.
 */
export function useCanvasFeed(feed: Feed): void {
  const baseline = useRef<{ sessionId: string | null; keys: Set<string>; newest: Map<string, string> } | null>(null);
  const { sessionId, projectId, messages, submitText } = feed;
  useEffect(() => {
    const switched = state.sessionId !== sessionId;
    // A new conversation getting its id is still the same conversation: keep the mode pressed before its first send.
    const keepMode = state.mode && state.sessionId === null;
    state = { ...state, sessionId, projectId, messages, submitText, ...(switched ? { activeDocId: null, open: false, currents: new Map(), mode: keepMode } : {}) };
    if (switched) docsCache = null;
    dropStaleCurrents();
    const docs = canvasDocs();
    const before = baseline.current;
    baseline.current = { sessionId, keys: keySet(messages), newest: newestKeys(docs) };
    // The first transcript of a conversation (opening it) only sets the baseline.
    if (before && before.sessionId === sessionId && before.keys.size > 0 && state.mode) {
      const doc = docToAutoOpen(docs, before.newest, keysNotAbove(messages, before.keys));
      if (doc) state = { ...state, open: true, activeDocId: doc.id };
    }
    notify();
  }, [sessionId, projectId, messages, submitText]);
}

// ---- 存到白板: the panel leaves a card here and opens the whiteboard; the board puts it on its canvas ----
export type PendingCanvasCard = { storedName: string; title: string };
let pendingCard: PendingCanvasCard | null = null;
export const setPendingCanvasCard = (card: PendingCanvasCard) => { pendingCard = card; };
export const takePendingCanvasCard = (): PendingCanvasCard | null => {
  const card = pendingCard;
  pendingCard = null;
  return card;
};
