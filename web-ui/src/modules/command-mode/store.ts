import type { CommandFrame } from '@/modules/command-mode/protocol';
import { STROKE_LOOKBACK_MS, deskStrokesOf, type AttachmentPlan, type Stroke } from '@/modules/command-mode/strokes';

/**
 * 手機端指揮模式的狀態（模組層級，一個分頁一份）。
 * 檢視元件寫入；聊天送出語音句子時讀出來決定要不要附圖。
 */
export type ViewerState = {
  /** 目前畫面所在的專案；WorkspaceHeader 裡的 CommandModeControl 設定。 */
  projectKey: string | null;
  callLive: boolean;
  sharing: boolean;
  frame: CommandFrame | null;
  strokes: Stroke[];
  lastTurnAt: number;
  lastAttachedFrameId: string | null;
};

const INITIAL: ViewerState = {
  projectKey: null,
  callLive: false,
  sharing: false,
  frame: null,
  strokes: [],
  lastTurnAt: 0,
  lastAttachedFrameId: null,
};

let state: ViewerState = INITIAL;
const listeners = new Set<() => void>();

const set = (next: Partial<ViewerState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

export const commandModeStore = {
  get: (): ViewerState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  setProjectKey(projectKey: string | null): void {
    if (projectKey !== state.projectKey) set({ projectKey });
  },
  setCallLive(callLive: boolean): void {
    if (callLive === state.callLive) return;
    set(callLive ? { callLive } : { callLive, sharing: false, frame: null, strokes: [], lastAttachedFrameId: null });
  },
  setSharing(sharing: boolean): void {
    if (sharing === state.sharing) return;
    set(sharing ? { sharing } : { sharing, frame: null });
  },
  receiveFrame(frame: CommandFrame): void {
    if (!state.callLive) return;
    const known = new Set(state.strokes.map((s) => s.id));
    const desk = deskStrokesOf(frame).filter((s) => !known.has(s.id));
    set({ frame, sharing: true, ...(desk.length > 0 ? { strokes: [...state.strokes, ...desk] } : {}) });
  },
  addStroke(stroke: Stroke): void {
    const keepAfter = stroke.endedAt - STROKE_LOOKBACK_MS;
    set({ strokes: [...state.strokes.filter((s) => s.endedAt >= keepAfter), stroke] });
  },
  commitTurn(plan: AttachmentPlan | null, now: number): void {
    set({ lastTurnAt: now, ...(plan ? { lastAttachedFrameId: plan.frame.id } : {}) });
  },
  reset(): void {
    state = INITIAL;
    for (const listener of listeners) listener();
  },
};
