import assert from 'node:assert/strict';

import { test } from 'vitest';

import { arrowheadsFor, isHorizontal } from '@/modules/plan-board/sceneModel';

// DHC CLI 10/14 規劃白板: ← → ↔ follow what the line looks like on screen, not which end was drawn first.
test('arrow direction follows the screen, whichever way the line was drawn', () => {
  const drawnRight = [[0, 0], [200, 10]] as const;
  const drawnLeft = [[0, 0], [-200, 10]] as const;
  assert.deepEqual(arrowheadsFor('forward', drawnRight), { startArrowhead: null, endArrowhead: 'arrow' });
  assert.deepEqual(arrowheadsFor('forward', drawnLeft), { startArrowhead: 'arrow', endArrowhead: null }, '→ on a line drawn right-to-left');
  assert.deepEqual(arrowheadsFor('back', drawnRight), { startArrowhead: 'arrow', endArrowhead: null });
  assert.deepEqual(arrowheadsFor('both', drawnLeft), { startArrowhead: 'arrow', endArrowhead: 'arrow' });
  assert.deepEqual(arrowheadsFor('none', drawnRight), { startArrowhead: null, endArrowhead: null });
  const drawnUp = [[0, 0], [5, -150]] as const;
  assert.equal(isHorizontal(drawnUp), false);
  assert.deepEqual(arrowheadsFor('forward', drawnUp), { startArrowhead: 'arrow', endArrowhead: null }, '↓ on a line drawn upwards');
  assert.equal(isHorizontal([[0, 0], [100, 20], [100, 300]]), false, 'a bent line reads by its two ends');
});
