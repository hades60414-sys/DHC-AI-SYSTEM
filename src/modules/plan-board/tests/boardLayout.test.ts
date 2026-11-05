import assert from 'node:assert/strict';

import { test } from 'vitest';

import { diffNodes, labelWidth, routeArrows, spreadForLabels, unconnected } from '@/modules/plan-board/boardLayout';
import { planToSkeletons } from '@/modules/plan-board/sceneModel';
import type { PlanEdge, PlanNode } from '@/shared/planBoards';

const node = (id: string, x: number, y: number, text = id): PlanNode => ({ id, x, y, w: 200, h: 80, text });
const edge = (from: string, to: string, text = ''): PlanEdge => ({ id: `${from}-${to}`, from, to, text });
const at = (nodes: PlanNode[], id: string) => nodes.find((item) => item.id === id)!;

test('label width counts CJK wide and Latin narrow, longest line wins', () => {
  assert.equal(labelWidth('讀寫任務狀態'), 6 * 20 + 40);
  assert.equal(labelWidth('CSV'), 3 * 11 + 40);
  assert.equal(labelWidth('是\n每日 CSV'), 2 * 20 + 4 * 11 + 40);
});

// The 10/14 screenshot: column gap 80 with a six-character label put the words on the boxes.
test('a long label on a left–right arrow pushes the far column right, keeping rows aligned', () => {
  const nodes = [node('a', 0, 0), node('b', 280, 0), node('c', 560, 0), node('b2', 280, 140), node('a2', 0, 140)];
  const out = spreadForLabels(nodes, [edge('a', 'b', '讀寫任務狀態'), edge('b', 'c')]);
  const gap = at(out, 'b').x - (at(out, 'a').x + 200);
  assert.ok(gap >= labelWidth('讀寫任務狀態'));
  assert.equal(at(out, 'b2').x, at(out, 'b').x, 'the column moves together');
  assert.equal(at(out, 'c').x - at(out, 'b').x, 280, 'later columns keep their spacing');
  assert.equal(at(out, 'a2').x, 0, 'boxes left of the gap stay');
});

test('an up–down label pushes lower rows down; right-to-left and short labels work too', () => {
  const vertical = spreadForLabels([node('top', 0, 0), node('low', 0, 140)], [edge('low', 'top', '仍無法解決')]);
  assert.ok(at(vertical, 'low').y - 80 >= 25 + 40);
  const back = spreadForLabels([node('a', 0, 0), node('b', 280, 0)], [edge('b', 'a', '處理不了就升級')]);
  assert.ok(at(back, 'b').x - 200 >= labelWidth('處理不了就升級'));
  const fits = [node('a', 0, 0), node('b', 280, 0)];
  assert.deepEqual(spreadForLabels(fits, [edge('a', 'b', '是')]), fits);
  assert.notEqual(spreadForLabels(fits, [edge('a', 'b', '很長很長很長的條件')])[1], fits[1], 'input is not mutated');
  assert.equal(fits[1].x, 280);
});

const endOf = (route: { x: number; y: number; points: Array<[number, number]> }) => {
  const last = route.points[route.points.length - 1];
  return [route.x + last[0], route.y + last[1]];
};

test('a lone arrow runs straight from facing edge to facing edge, whichever way the boxes sit', () => {
  const a = node('a', 0, 0);
  const one = (other: PlanNode) => routeArrows([a, other], [edge('a', other.id)]).get(`a-${other.id}`)!;
  assert.deepEqual(one(node('r', 400, 0)), { x: 200, y: 40, points: [[0, 0], [200, 0]] });
  assert.deepEqual(endOf(one(node('l', -400, 0))), [-200, 40]);
  assert.deepEqual(one(node('d', 0, 300)), { x: 100, y: 80, points: [[0, 0], [0, 220]] });
  assert.deepEqual(endOf(one(node('u', 0, -300))), [100, -220]);
  const [arrow] = planToSkeletons([a, node('r', 400, 0)], [edge('a', 'r', '是')], []).filter((item) => item.type === 'arrow');
  assert.deepEqual([arrow.x, arrow.y, arrow.points], [200, 40, [[0, 0], [200, 0]]]);
});

// The 10/14 screenshot: 訊息匯流排 fans out to 中型節點 and 電腦 A/B/N, and 電腦 A answers back on the same pair.
test('a fan leaves from spread-out points and each label gets a straight stretch at its own target row', () => {
  const nodes = [node('bus', 0, 300), node('mid', 400, 0), node('a', 400, 300), node('b', 400, 450), node('n', 400, 600)];
  const edges = [edge('bus', 'mid', '彙整'), edge('bus', 'a', '派工'), edge('a', 'bus', '回報'), edge('bus', 'b'), edge('bus', 'n')];
  const routes = routeArrows(nodes, edges);
  const starts = ['bus-mid', 'bus-a', 'bus-b', 'bus-n'].map((id) => routes.get(id)!.y);
  assert.equal(new Set(starts).size, 4, 'no two arrows start at the same point');
  assert.deepEqual([...starts].sort((p, q) => p - q), starts, 'ordered top to bottom like their targets');
  // A slanted arrow bends twice; its middle stretch is level, at the target's row.
  const toB = routes.get('bus-b')!;
  assert.equal(toB.points.length, 4);
  assert.equal(toB.points[1][1], toB.points[2][1]);
  assert.equal(toB.y + toB.points[1][1], endOf(toB)[1]);
  // The two-way pair: their straight stretches (where the labels sit) are a label's height apart.
  const out = routes.get('bus-a')!;
  const back = routes.get('a-bus')!;
  const laneOf = (route: { y: number; points: Array<[number, number]> }) => route.y + route.points[1][1];
  assert.equal(out.points.length, 4);
  assert.equal(back.points.length, 4);
  assert.ok(Math.abs(laneOf(out) - laneOf(back)) >= 30, 'labels on the pair do not touch');
});

test('an arrow that skips a column takes a row with no box in the way, else goes straight', () => {
  // brain ← mid (top right) skips over bus, which sits in brain's row.
  const nodes = [node('brain', 0, 300), node('bus', 400, 300), node('mid', 800, 0)];
  const back = routeArrows(nodes, [edge('mid', 'brain', '摘要')]).get('mid-brain')!;
  const lane = back.y + back.points[1][1];
  assert.ok(lane < 300 - 18, 'runs along the top row instead of through bus');
  const blocked = [node('l', 0, 0), node('m', 400, 0), node('r', 800, 100), node('m2', 400, 100)];
  assert.equal(routeArrows(blocked, [edge('l', 'r')]).get('l-r')!.points.length, 2, 'both rows blocked: straight');
});

test('diff names added, changed and removed boxes; unconnected skips single boxes', () => {
  const before = [node('a', 0, 0), node('b', 280, 0), node('c', 560, 0)];
  const after = [node('a', 0, 0), { ...node('b', 280, 0), text: '新名字' }, node('d', 0, 140)];
  assert.deepEqual(diffNodes(before, after), { added: ['d'], changed: ['b'], removed: ['c'] });
  assert.deepEqual(unconnected(after, [edge('a', 'b')]).map((item) => item.id), ['d']);
  assert.deepEqual(unconnected([node('a', 0, 0)], []), []);
});

// 10/19 screenshot: a long label wrapped and grew its box down over the box below.
test('boxes grow to fit their text: a long one-line title widens (up to 360) and wraps taller', async () => {
  const { fitBoxesToText } = await import('@/modules/plan-board/boardLayout');
  const [long, latin, two, fits, diamond] = fitBoxesToText([
    node('long', 0, 0, '去識別代理把機密換成別名再送模型回來換回真值'),
    node('latin', 0, 0, 'deid-proxy cutover'),
    node('two', 0, 0, '抓部位\n算限額使用率並寄出報表'),
    node('fits', 0, 0, '抓部位'),
    { ...node('diamond', 0, 0, '超限？'), shape: 'diamond' as const },
  ]);
  assert.deepEqual([long.w, long.h], [360, 90], '21 characters: 360 wide, 16 a line, two lines');
  assert.deepEqual([latin.w, latin.h], [238, 80], 'one line of Latin: wider, same height');
  assert.deepEqual([two.w, two.h], [200, 115], 'two lines kept, the second wraps: 3 lines');
  assert.deepEqual([fits.w, fits.h], [200, 80], 'a box that fits stays');
  assert.deepEqual([diamond.w, diamond.h], [200, 104], 'a diamond needs 1.6× a box');
});

test('overlapping boxes: the lower one moves down, the rest stay, and a push carries on down the column', async () => {
  const { resolveOverlaps } = await import('@/modules/plan-board/boardLayout');
  const apart = [node('a', 0, 0), node('b', 280, 0), node('c', 0, 140)];
  assert.deepEqual(resolveOverlaps(apart), apart, 'nothing within 40px: nothing moves');
  const pushed = resolveOverlaps([{ ...node('tall', 0, 0), h: 200 }, node('under', 0, 140), node('next', 0, 280), node('side', 400, 140)]);
  assert.equal(at(pushed, 'under').y, 240, 'below the tall box plus the gap');
  assert.equal(at(pushed, 'next').y, 360, 'the box below it is pushed in turn');
  assert.equal(at(pushed, 'side').y, 140, 'a box clear of all of it stays');
  assert.equal(at(pushed, 'tall').y, 0);
  const row = resolveOverlaps([{ ...node('wide', 0, 0), w: 360 }, node('right', 280, 0), node('far', 560, 0)]);
  assert.deepEqual([at(row, 'right').x, at(row, 'right').y], [400, 0], 'a widened box pushes its row neighbour right, not down');
  assert.equal(at(row, 'far').x, 640, 'and that one pushes the next');
});
