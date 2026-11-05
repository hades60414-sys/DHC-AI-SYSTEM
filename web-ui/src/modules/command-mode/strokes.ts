import type { CommandFrame } from '@/modules/command-mode/protocol';

/** 一筆雷射筆軌跡。座標正規化到畫面寬高（0–1），t 是 Date.now()。 */
export type StrokePoint = { x: number; y: number; t: number };

export type StrokeShape = 'dot' | 'line' | 'circle';

export type Stroke = {
  id: string;
  /** phone：手機上手指或右鍵畫的，送出時要合成上去；desk：電腦上右鍵畫的，軌跡已在畫面裡。 */
  source: 'phone' | 'desk';
  /** 畫這一筆時手機上顯示的那張電腦畫面。 */
  frame: CommandFrame;
  startedAt: number;
  endedAt: number;
  shape: StrokeShape;
  points: StrokePoint[];
};

/** 這句話之前多久內的圈點還算「這句的」。上一句送出之前畫的不算。 */
export const STROKE_LOOKBACK_MS = 60_000;
/** 軌跡在畫面上淡出的時間；資料不會因為淡出而消失。 */
export const STROKE_FADE_MS = 3_000;

const DOT_SPAN = 0.025;
const CLOSED_GAP = 0.35;

export function classifyStroke(points: StrokePoint[]): StrokeShape {
  if (points.length === 0) return 'dot';
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (span < DOT_SPAN) return 'dot';
  const first = points[0];
  const last = points[points.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  return points.length >= 6 && gap < span * CLOSED_GAP ? 'circle' : 'line';
}

export type AttachmentPlan =
  | { kind: 'annotated'; frame: CommandFrame; strokes: Stroke[]; note: string }
  | { kind: 'frame'; frame: CommandFrame; note: string };

export type PlanInput = {
  sharing: boolean;
  frame: CommandFrame | null;
  strokes: Stroke[];
  /** 上一句送出的時間；之前畫的屬於上一句。 */
  lastTurnAt: number;
  lastAttachedFrameId: string | null;
};

export function strokesForTurn(strokes: Stroke[], lastTurnAt: number, now: number): Stroke[] {
  const since = Math.max(lastTurnAt, now - STROKE_LOOKBACK_MS);
  return strokes.filter((s) => s.endedAt > since && s.startedAt <= now).sort((a, b) => a.startedAt - b.startedAt);
}

const SHAPE_WORD: Record<StrokeShape, string> = { circle: '圈了', dot: '點了', line: '畫了' };
const SHAPE_UNIT: Record<StrokeShape, string> = { circle: '處', dot: '處', line: '條線' };

export function describeStrokes(strokes: Stroke[]): string {
  const counts = new Map<StrokeShape, number>();
  for (const s of strokes) counts.set(s.shape, (counts.get(s.shape) ?? 0) + 1);
  const parts = (['circle', 'dot', 'line'] as StrokeShape[])
    .filter((shape) => counts.has(shape))
    .map((shape) => `${SHAPE_WORD[shape]} ${counts.get(shape)} ${SHAPE_UNIT[shape]}`);
  return parts.join('、');
}

/** 電腦端筆畫變成可以和手機筆畫一起算的 Stroke（沒有座標，軌跡在畫面裡）。 */
export function deskStrokesOf(frame: CommandFrame): Stroke[] {
  return (frame.marks ?? []).map((m) => ({ id: m.id, source: 'desk' as const, frame, startedAt: m.startedAt, endedAt: m.endedAt, shape: m.shape, points: [] }));
}

/** 決定這句話要附哪張圖：有圈點就附合成圖；沒有就附最新畫面，但同一張不重附。 */
export function planAttachment(input: PlanInput, now: number): AttachmentPlan | null {
  if (!input.sharing || !input.frame) return null;
  const strokes = strokesForTurn(input.strokes, input.lastTurnAt, now);
  if (strokes.length > 0) {
    const frame = strokes[strokes.length - 1].frame;
    const phone = strokes.filter((s) => s.source === 'phone');
    const desk = strokes.filter((s) => s.source === 'desk');
    const parts = [
      phone.length > 0 ? `在手機上對電腦畫面${describeStrokes(phone)}${phone.length > 1 ? '（紅色標記，數字是先後順序）' : '（紅色標記）'}` : '',
      desk.length > 0 ? `在電腦上用滑鼠${describeStrokes(desk)}（畫面裡的紅色軌跡）` : '',
    ].filter(Boolean);
    return {
      kind: 'annotated',
      frame,
      strokes,
      note: `〔指揮模式：使用者講這句時${parts.join('，又')}，見附圖〕`,
    };
  }
  if (input.frame.id === input.lastAttachedFrameId) return null;
  return { kind: 'frame', frame: input.frame, note: '〔指揮模式：附上目前的電腦畫面，使用者這句沒有圈點〕' };
}
