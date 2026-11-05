import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import type { CommandFrame } from '@/modules/command-mode/protocol';
import { commandModeStore } from '@/modules/command-mode/store';
import {
  STROKE_LOOKBACK_MS,
  classifyStroke,
  planAttachment,
  type Stroke,
  type StrokePoint,
} from '@/modules/command-mode/strokes';

const frame = (id: string): CommandFrame => ({ id, capturedAt: 0, width: 1280, height: 720, dataUrl: `data:image/jpeg;base64,${id}` });
const ring = (cx: number, cy: number, r: number, t0: number): StrokePoint[] => Array.from({ length: 13 }, (_, i) => ({
  x: cx + r * Math.cos((i / 12) * Math.PI * 2), y: cy + r * Math.sin((i / 12) * Math.PI * 2), t: t0 + i * 20,
}));
const stroke = (id: string, f: CommandFrame, points: StrokePoint[]): Stroke => ({
  id, source: 'phone', frame: f, points, shape: classifyStroke(points), startedAt: points[0].t, endedAt: points[points.length - 1].t,
});

beforeEach(() => commandModeStore.reset());

test('a tap is a dot, a closed loop is a circle, an open drag is a line', () => {
  assert.equal(classifyStroke([{ x: 0.5, y: 0.5, t: 0 }, { x: 0.505, y: 0.502, t: 30 }]), 'dot');
  assert.equal(classifyStroke(ring(0.5, 0.5, 0.1, 0)), 'circle');
  assert.equal(classifyStroke([{ x: 0.1, y: 0.1, t: 0 }, { x: 0.3, y: 0.2, t: 10 }, { x: 0.6, y: 0.3, t: 20 }]), 'line');
});

test('strokes drawn while (or just before) this sentence go with it, on the frame they were drawn on', () => {
  const old = frame('f1');
  const latest = frame('f2');
  const circle = stroke('a', old, ring(0.4, 0.4, 0.1, 10_000));
  const tap = stroke('b', latest, [{ x: 0.7, y: 0.2, t: 12_000 }]);
  const plan = planAttachment({ sharing: true, frame: latest, strokes: [tap, circle], lastTurnAt: 5_000, lastAttachedFrameId: null }, 13_000);
  assert.equal(plan?.kind, 'annotated');
  assert.deepEqual(plan?.kind === 'annotated' && plan.strokes.map((s) => s.id), ['a', 'b'], 'ordered by when they were drawn');
  assert.equal(plan?.frame.id, 'f2', 'composited onto the frame of the latest stroke');
  assert.match(plan?.note ?? '', /^〔指揮模式：使用者講這句時在手機上對電腦畫面圈了 1 處、點了 1 處（紅色標記，數字是先後順序），見附圖〕$/);
});

test('strokes from before the previous sentence, or older than the lookback, are not attached again', () => {
  const f = frame('f1');
  const beforeLastTurn = stroke('a', f, [{ x: 0.2, y: 0.2, t: 4_000 }]);
  const tooOld = stroke('b', f, [{ x: 0.2, y: 0.2, t: 6_000 }]);
  const now = 6_000 + STROKE_LOOKBACK_MS + 1;
  const plan = planAttachment({ sharing: true, frame: f, strokes: [beforeLastTurn, tooOld], lastTurnAt: 5_000, lastAttachedFrameId: null }, now);
  assert.equal(plan?.kind, 'frame', 'no strokes left, so only the plain screen goes');
});

test('without strokes the latest screen is attached once, and an unchanged screen is not repeated', () => {
  const f = frame('f1');
  const first = planAttachment({ sharing: true, frame: f, strokes: [], lastTurnAt: 0, lastAttachedFrameId: null }, 1_000);
  assert.equal(first?.kind, 'frame');
  assert.match(first?.note ?? '', /沒有圈點/);
  assert.equal(planAttachment({ sharing: true, frame: f, strokes: [], lastTurnAt: 1_000, lastAttachedFrameId: 'f1' }, 2_000), null);
  assert.equal(planAttachment({ sharing: true, frame: frame('f2'), strokes: [], lastTurnAt: 1_000, lastAttachedFrameId: 'f1' }, 2_000)?.kind, 'frame');
});

test('nothing is attached when the desktop is not sharing', () => {
  assert.equal(planAttachment({ sharing: false, frame: frame('f1'), strokes: [], lastTurnAt: 0, lastAttachedFrameId: null }, 1), null);
  assert.equal(planAttachment({ sharing: true, frame: null, strokes: [], lastTurnAt: 0, lastAttachedFrameId: null }, 1), null);
});

test('store: a committed turn consumes its strokes; hanging up forgets the screen and the strokes', () => {
  commandModeStore.setCallLive(true);
  commandModeStore.receiveFrame(frame('f1'));
  commandModeStore.addStroke(stroke('a', frame('f1'), [{ x: 0.5, y: 0.5, t: 1_000 }]));
  const plan = planAttachment(commandModeStore.get(), 2_000);
  assert.equal(plan?.kind, 'annotated');
  commandModeStore.commitTurn(plan, 2_000);
  assert.equal(planAttachment(commandModeStore.get(), 3_000), null, 'same strokes and same screen are not sent twice');

  commandModeStore.setCallLive(false);
  const s = commandModeStore.get();
  assert.equal(s.frame, null);
  assert.equal(s.strokes.length, 0);
  commandModeStore.receiveFrame(frame('late'));
  assert.equal(commandModeStore.get().frame, null, 'a frame arriving after hang-up is dropped');
});

test('a stroke drawn with the mouse on the desktop arrives inside a frame and counts as a mark for the next sentence', () => {
  commandModeStore.setCallLive(true);
  const marked = { ...frame('f9'), marks: [{ id: 'd1', shape: 'line' as const, startedAt: 10_000, endedAt: 10_400 }] };
  commandModeStore.receiveFrame(frame('f8'));
  commandModeStore.receiveFrame(marked);
  commandModeStore.receiveFrame(frame('f10'));
  commandModeStore.receiveFrame(marked);
  assert.equal(commandModeStore.get().strokes.length, 1, 'the same mark resent (e.g. on reconnect) is kept once');
  const plan = planAttachment(commandModeStore.get(), 12_000);
  assert.equal(plan?.kind, 'annotated');
  assert.equal(plan?.frame.id, 'f9', 'the frame that has the trail in it, not the newest one');
  assert.match(plan?.note ?? '', /在電腦上用滑鼠畫了 1 條線（畫面裡的紅色軌跡）/);
});
