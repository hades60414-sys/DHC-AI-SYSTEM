import type { ChatRef } from '@/shared/chatRoom';

/**
 * 11/01: the unsent text of each room's composer, kept in memory (so switching 動態 / 私訊 / 對話旁 tabs keeps it)
 * and in sessionStorage (so a reload of the tab keeps it too). A sent or emptied composer removes its entry.
 */
export type RoomDraft = { text: string; refs: ChatRef[] };

const KEY = 'dhc.chatDraft:';
const memory = new Map<string, RoomDraft>();
const EMPTY: RoomDraft = { text: '', refs: [] };

export function readRoomDraft(roomId: string): RoomDraft {
  const held = memory.get(roomId);
  if (held) return held;
  try {
    const stored = JSON.parse(sessionStorage.getItem(KEY + roomId) ?? 'null') as Partial<RoomDraft> | null;
    if (stored && typeof stored.text === 'string' && stored.text !== '') {
      const draft = { text: stored.text, refs: Array.isArray(stored.refs) ? stored.refs : [] };
      memory.set(roomId, draft);
      return draft;
    }
  } catch {
    // Storage blocked or damaged: no draft.
  }
  return EMPTY;
}

export function writeRoomDraft(roomId: string, text: string, refs: ChatRef[]): void {
  if (text === '') {
    memory.delete(roomId);
  } else {
    memory.set(roomId, { text, refs });
  }
  try {
    if (text === '') sessionStorage.removeItem(KEY + roomId);
    else sessionStorage.setItem(KEY + roomId, JSON.stringify({ text, refs }));
  } catch {
    // Storage blocked: the memory copy still lasts for this page load.
  }
}

/** Forgets the in-memory copies (tests; a "reload" keeps what sessionStorage holds). */
export const forgetMemoryDrafts = (): void => memory.clear();
