import { api } from '@/shared/api';

/**
 * DHC CLI 10/13 規劃白板: an Excalidraw canvas (shapes, arrows, text, freehand, colours), drawn by hand or roughed
 * out by AI, then handed to a new session as the brief. Boards belong to the person, i.e. this device's 專案設定
 * profile (never the open project, so nobody lands in someone else's boards), in user_preferences under
 * `dhc.boards:p:<profileId>`, so every device of that person shows the same ones. A save re-reads the server's
 * copy and only replaces the boards this page changed, so a board edited on another device stays.
 */
export type PlanNode = { id: string; x: number; y: number; w: number; h: number; text: string };
export type PlanEdge = { id: string; from: string; to: string; text: string };
export type PlanChatMessage = { role: 'user' | 'assistant'; text: string };
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

export function parseBoards(value: unknown): PlanBoard[] {
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
            .slice(-MAX_CHAT)
          : [],
        updatedAt: str(item.updatedAt),
      };
    });
}

export function emptyBoard(name: string, mode: BoardMode = 'free'): PlanBoard {
  return { id: newId(), name, mode, elements: [], chat: [], updatedAt: new Date().toISOString() };
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
