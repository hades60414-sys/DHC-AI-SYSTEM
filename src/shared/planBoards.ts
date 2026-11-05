import { api } from '@/shared/api';

/**
 * DHC CLI 10/13 規劃白板: an Excalidraw canvas (shapes, arrows, text, freehand, colours), drawn by hand or roughed
 * out by AI, then handed to a new session as the brief. Boards belong to the person, i.e. this device's 專案設定
 * profile (never the open project, so nobody lands in someone else's boards), in user_preferences under
 * `dhc.boards:p:<profileId>`, so every device of that person shows the same ones. A save re-reads the server's
 * copy and only replaces the boards this page changed, so a board edited on another device stays.
 */
/** 10/19: `shape` absent is a rectangle; a diamond is a decision. */
export type PlanShape = 'rectangle' | 'ellipse' | 'diamond';
/** 10/19: a box linked with @@ to a conversation or another whiteboard (its customData.dhcRef). */
export type PlanLink = { kind: 'session' | 'board'; id: string; label: string };
/** `link` absent keeps the box's link as it is; null (only from the AI) takes it off. */
export type PlanNode = { id: string; x: number; y: number; w: number; h: number; text: string; shape?: PlanShape; link?: PlanLink | null };
export type PlanEdge = { id: string; from: string; to: string; text: string };
/**
 * 10/19: anything on the canvas that is neither a box nor an arrow bound at both ends to boxes: free text, loose lines
 * and arrows, freehand. The AI sees them (with id and place) so it can move a note or clear a stale line.
 */
export type PlanLoose = { id: string; kind: 'text' | 'line' | 'arrow' | 'freedraw'; text?: string; x: number; y: number; w: number; h: number };
/** 10/19: free text the AI keeps, moves or adds; a known id is a move or rewrite, none (or an unknown one) a new note. */
export type PlanNote = { id?: string; text: string; x: number; y: number };
/**
 * 10/14: `at` (ISO time) and `by` (who asked, on a shared board) let two people's chats merge; `who` is the asker's
 * project, which gives the avatar beside the message.
 */
export type PlanChatMessage = { role: 'user' | 'assistant'; text: string; at?: string; by?: string; who?: string };
/** 10/14 Co-Work: who a shared board belongs to, who else is in it, and their unopened invitations. */
export type CoBoardInfo = {
  ownerProjectId: string;
  members: string[];
  invites?: Record<string, { from: string; message: string; at: string }>;
};
/** 10/14: how the AI lays the board out and what 開工 asks for (自由／SOP 泳道／心智圖／資料流程). */
export type BoardMode = 'free' | 'sop' | 'mindmap' | 'dataflow';
const MODES: BoardMode[] = ['free', 'sop', 'mindmap', 'dataflow'];
/** Shapes and arrows as the AI reads and redraws them; the canvas itself is stored as Excalidraw elements. */
export type PlanBoard = {
  id: string;
  name: string;
  mode: BoardMode;
  /** Excalidraw elements (deleted ones left out), kept as the canvas saved them. */
  elements: unknown[];
  chat: PlanChatMessage[];
  updatedAt: string;
  /** 11/01: a new board nobody named yet; it takes a name from what gets drawn or asked first (PlanBoard.tsx autoNameOf). */
  autoName?: true;
  /** Set on a shared board (kept in `dhc.coBoards`, see coBoards.ts), absent on the person's own. */
  co?: CoBoardInfo;
};

export const BOX_WIDTH = 200;
export const BOX_HEIGHT = 80;
const MAX_CHAT = 40;
const SAVE_DELAY_MS = 800;

const keyOf = (profileId: string) => `dhc.boards:p:${profileId}`;
// 10/13 first version kept boards under the person's project id; read once if the profile has none yet.
const legacyKeyOf = (projectId: string) => `dhc.boards:${projectId}`;
const styleKeyOf = (profileId: string) => `dhc.boardStyle:p:${profileId}`;
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const SHAPES: PlanShape[] = ['rectangle', 'ellipse', 'diamond'];
const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const str = (value: unknown) => (typeof value === 'string' ? value : '');

export function parseNodes(value: unknown): PlanNode[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object' && str((item as PlanNode).id))
    .map((item: Partial<PlanNode>) => ({
      id: str(item.id),
      x: num(item.x, 0),
      y: num(item.y, 0),
      w: Math.max(80, num(item.w, BOX_WIDTH)),
      h: Math.max(40, num(item.h, BOX_HEIGHT)),
      text: str(item.text),
      ...(SHAPES.includes(item.shape as PlanShape) ? { shape: item.shape } : {}),
      ...parseLink(item.link),
    }));
}

/** The AI's link on a box: null unlinks; a kind and id is checked against what @@ offers later (acceptLinks). */
function parseLink(value: unknown): { link?: PlanLink | null } {
  if (value === null) return { link: null };
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<PlanLink>;
  if ((raw.kind !== 'session' && raw.kind !== 'board') || !str(raw.id)) return {};
  return { link: { kind: raw.kind, id: str(raw.id), label: str(raw.label) } };
}

export function parseNotes(value: unknown): PlanNote[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object' && str((item as PlanNote).text).trim())
    .map((item: Partial<PlanNote>) => ({
      ...(str(item.id) ? { id: str(item.id) } : {}),
      text: str(item.text).trim(),
      x: num(item.x, 0),
      y: num(item.y, 0),
    }));
}

/** Arrows whose ends are not on the board are dropped. */
export function parseEdges(value: unknown, nodes: PlanNode[]): PlanEdge[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set(nodes.map((node) => node.id));
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item: Partial<PlanEdge>) => ({
      id: str(item.id) || newId(),
      from: str(item.from),
      to: str(item.to),
      text: str(item.text),
    }))
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);
}

export function parseBoards(value: unknown, maxChat = MAX_CHAT): PlanBoard[] {
  const raw = value && typeof value === 'object' ? (value as { items?: unknown }).items : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object' && str((item as PlanBoard).id))
    .map((item: Partial<PlanBoard>) => {
      return {
        id: str(item.id),
        name: str(item.name) || '未命名白板',
        mode: MODES.includes(item.mode as BoardMode) ? item.mode as BoardMode : 'free',
        elements: Array.isArray(item.elements) ? item.elements.filter((element) => element && typeof element === 'object') : [],
        chat: Array.isArray(item.chat)
          ? item.chat
            .filter((m): m is PlanChatMessage => Boolean(m) && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
            .slice(-maxChat)
          : [],
        updatedAt: str(item.updatedAt),
        ...(item.autoName === true ? { autoName: true as const } : {}),
      };
    });
}

export function emptyBoard(name: string, mode: BoardMode = 'free'): PlanBoard {
  return { id: newId(), name, mode, elements: [], chat: [], updatedAt: new Date().toISOString() };
}

const AUTO_NAME_MAX = 20;
/** A name for an unnamed board: the first thing asked of the AI, else the top-left box; null while both are empty. */
export function autoNameOf(chat: ReadonlyArray<PlanChatMessage>, nodes: ReadonlyArray<{ x: number; y: number; text: string }>): string | null {
  const firstLine = (text: string) => text.trim().split('\n')[0].trim();
  const asked = chat.find((item) => item.role === 'user' && firstLine(item.text));
  const box = [...nodes].filter((node) => firstLine(node.text)).sort((a, b) => a.y - b.y || a.x - b.x)[0];
  const name = asked ? firstLine(asked.text) : box ? firstLine(box.text) : '';
  if (!name) return null;
  return name.length > AUTO_NAME_MAX ? `${name.slice(0, AUTO_NAME_MAX)}…` : name;
}

async function fetchPreferences(): Promise<Record<string, unknown>> {
  const response = await api.user.preferences();
  if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
  const payload = (await response.json()) as { preferences?: Record<string, unknown> };
  return payload.preferences ?? {};
}

async function fetchBoards(profileId: string): Promise<PlanBoard[]> {
  return parseBoards((await fetchPreferences())[keyOf(profileId)]);
}

/** The pen, fill, font and line settings last used, so the next board or visit starts with them. */
export type BoardStyle = Record<string, unknown>;

export async function loadBoards(
  profileId: string,
  legacyProjectId?: string | null,
): Promise<{ boards: PlanBoard[]; style: BoardStyle }> {
  const preferences = await fetchPreferences();
  let boards = parseBoards(preferences[keyOf(profileId)]);
  if (boards.length === 0 && legacyProjectId) boards = parseBoards(preferences[legacyKeyOf(legacyProjectId)]);
  const style = preferences[styleKeyOf(profileId)];
  return { boards, style: style && typeof style === 'object' ? (style as BoardStyle) : {} };
}

export function saveBoardStyle(profileId: string, style: BoardStyle): void {
  void api.user.savePreferences({ [styleKeyOf(profileId)]: style }).catch(() => {
    // Only a convenience; the next change tries again.
  });
}

/**
 * Saves one person's boards a moment after the last change. Only boards touched here are written over the
 * server's copy; everything else on the server is kept.
 */
export function createBoardSaver(profileId: string, onError: () => void) {
  const changed = new Map<string, PlanBoard>();
  const removed = new Set<string>();
  let timer: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  const flush = () => {
    timer = null;
    if (changed.size === 0 && removed.size === 0) return chain;
    const boards = new Map(changed);
    const gone = new Set(removed);
    changed.clear();
    removed.clear();
    chain = chain.then(async () => {
      try {
        const server = await fetchBoards(profileId);
        const next = server.filter((board) => !gone.has(board.id) && !boards.has(board.id));
        const merged = [...boards.values(), ...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const response = await api.user.savePreferences({ [keyOf(profileId)]: { items: merged } });
        if (!response.ok) throw new Error(`Failed to save boards (${response.status})`);
      } catch (error) {
        console.error('[PlanBoards] Failed to save:', error);
        onError();
      }
    });
    return chain;
  };

  return {
    save(board: PlanBoard) {
      removed.delete(board.id);
      changed.set(board.id, { ...board, chat: board.chat.slice(-MAX_CHAT) });
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void flush(); }, SAVE_DELAY_MS);
    },
    remove(id: string) {
      changed.delete(id);
      removed.add(id);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void flush(); }, SAVE_DELAY_MS);
    },
    /** Writes anything still waiting now (closing the board, starting work). */
    flush() {
      if (timer !== null) window.clearTimeout(timer);
      return flush();
    },
  };
}
