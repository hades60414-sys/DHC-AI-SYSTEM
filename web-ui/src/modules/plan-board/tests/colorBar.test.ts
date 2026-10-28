import assert from 'node:assert/strict';

import { test } from 'vitest';

import { splitAlpha, withAlpha } from '@/modules/plan-board/sceneModel';

// DHC CLI 10/13 規劃白板: a fill's transparency rides on its colour as '#rrggbbaa'.
test('fill transparency is written into and read back from the colour', () => {
  assert.equal(withAlpha('#a5d8ff', 100), '#a5d8ff', 'opaque stays a plain colour');
  assert.equal(withAlpha('#a5d8ff', 50), '#a5d8ff80');
  assert.equal(withAlpha('#a5d8ff', 0), '#a5d8ff00');
  assert.equal(withAlpha('transparent', 40), 'transparent');
  assert.deepEqual(splitAlpha('#a5d8ff80'), { base: '#a5d8ff', alpha: 50 });
  assert.deepEqual(splitAlpha('#a5d8ff'), { base: '#a5d8ff', alpha: 100 });
  assert.deepEqual(splitAlpha('transparent'), { base: 'transparent', alpha: 100 });
});
