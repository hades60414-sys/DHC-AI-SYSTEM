import assert from 'node:assert/strict';

import { test } from 'vitest';

import { boardBrief, planToSkeletons, redrawnIds, sceneToPlan } from '@/modules/plan-board/sceneModel';
import type { SceneElement } from '@/modules/plan-board/sceneModel';

/**
 * DHC CLI 10/13 規劃白板 on Excalidraw: shapes with labels are boxes, bound arrows are connections, free text is a
 * note, freehand is only counted; the AI redraws boxes and arrows but keeps their colours; 開工 describes it all.
 */

const el = (fields: Partial<SceneElement> & Pick<SceneElement, 'id' | 'type'>): SceneElement => ({
  x: 0, y: 0, width: 200, height: 80, strokeColor: '#1e1e1e', backgroundColor: 'transparent', ...fields,
});

const scene: SceneElement[] = [
  el({ id: 'a', type: 'rectangle', x: 0, y: 0, backgroundColor: '#a5d8ff', boundElements: [{ id: 'ta', type: 'text' }] }),
  el({ id: 'ta', type: 'text', text: '抓 DB1 部位', containerId: 'a' }),
  el({ id: 'b', type: 'diamond', x: 300, y: 0, strokeColor: '#e03131' }),
  el({ id: 'tb', type: 'text', text: '超限？', containerId: 'b' }),
  el({ id: 'ab', type: 'arrow', startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } }),
  el({ id: 'tab', type: 'text', text: '每日 CSV', containerId: 'ab' }),
  el({ id: 'loose', type: 'arrow', startBinding: { elementId: 'a' }, endBinding: null }),
  el({ id: 'pen', type: 'freedraw' }),
  el({ id: 'note', type: 'text', text: '  記得\n週五不跑 ', x: 0, y: 300 }),
  el({ id: 'gone', type: 'rectangle', isDeleted: true }),
];

test('a scene reads as boxes, connections, notes and counted sketches', () => {
  const plan = sceneToPlan(scene);
  assert.deepEqual(plan.nodes.map((node) => [node.id, node.text]), [['a', '抓 DB1 部位'], ['b', '超限？']]);
  assert.deepEqual(plan.edges, [{ id: 'ab', from: 'a', to: 'b', text: '每日 CSV' }]);
  assert.deepEqual(plan.notes, ['記得 週五不跑']);
  assert.equal(plan.sketches, 2, 'the loose arrow and the freehand stroke');
  assert.deepEqual(plan.colors.get('a'), { stroke: undefined, fill: '#a5d8ff' });
  assert.deepEqual([...redrawnIds(scene, plan)].sort(), ['a', 'ab', 'b', 'ta', 'tab', 'tb']);
});

test('a redraw keeps a kept box\'s shape and colours, new boxes are plain rectangles with labels', () => {
  const skeletons = planToSkeletons(
    [{ id: 'b', x: 10, y: 20, w: 200, h: 80, text: '超限？' }, { id: 'n9', x: 300, y: 20, w: 0, h: 0, text: '寄報表' }],
    [{ id: 'e1', from: 'b', to: 'n9', text: '否' }],
    scene,
  );
  assert.equal(skeletons[0].type, 'diamond');
  assert.equal(skeletons[0].strokeColor, '#e03131');
  assert.deepEqual(skeletons[1].label, { text: '寄報表' });
  assert.equal(skeletons[1].type, 'rectangle');
  assert.equal(skeletons[1].width, 200, 'a missing size falls back to the default box');
  assert.deepEqual([skeletons[2].type, skeletons[2].start, skeletons[2].end], ['arrow', { id: 'b' }, { id: 'n9' }]);
});

test('開工 brief names boxes with their colours, arrows, notes, sketches and what was asked', () => {
  const brief = boardBrief('風險日報', sceneToPlan(scene), [
    { role: 'user', text: '畫風險日報流程' },
    { role: 'assistant', text: '好' },
  ]);
  assert.match(brief, /白板「風險日報」/);
  assert.match(brief, /- 抓 \DB1 部位〔底色淺藍〕/);
  assert.match(brief, /- 超限？〔框線紅〕/);
  assert.match(brief, /抓 \DB1 部位 → 超限？（每日 CSV）/);
  assert.match(brief, /文字註記：\n- 記得 週五不跑/);
  assert.match(brief, /另有 2 筆手繪/);
  assert.match(brief, /- 畫風險日報流程/);
  assert.doesNotMatch(brief, /^- 好$/m, 'only the person\'s own words');
});

test('a board mode changes what 開工 asks for, and an old board without a mode reads as 自由', async () => {
  const { BOARD_MODES } = await import('@/modules/plan-board/boardModes');
  const { boardBrief: brief } = await import('@/modules/plan-board/sceneModel');
  const { parseBoards } = await import('@/shared/planBoards');
  const plan = { nodes: [], edges: [], notes: [], sketches: 0, colors: new Map() } as never;
  const sop = brief('月底對帳', plan, [], BOARD_MODES.sop);
  assert.match(sop, /^依照這張 SOP 泳道圖寫一份作業 SOP/);
  assert.match(sop, /\.docx/);
  assert.match(brief('x', plan, []), /^依照這張系統規劃圖開工/);
  assert.equal(parseBoards({ items: [{ id: 'b1' }] })[0].mode, 'free');
  assert.equal(parseBoards({ items: [{ id: 'b1', mode: 'dataflow' }] })[0].mode, 'dataflow');
  assert.equal(parseBoards({ items: [{ id: 'b1', mode: 'nope' }] })[0].mode, 'free');
});
