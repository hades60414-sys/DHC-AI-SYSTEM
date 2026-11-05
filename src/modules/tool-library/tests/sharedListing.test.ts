import assert from 'node:assert/strict';

import { test } from 'vitest';

import { resolvePick } from '@/modules/tool-library/catalog';
import { findListing, parseSharedTools } from '@/shared/sharedTools';

const listed = parseSharedTools({ items: [
  { id: 'L1', name: '手續費計算', html: '<p>x</p>', author: '同事C', sharedAt: '2026-10-22T00:00:00Z', sourceId: 'w1', summary: '算手續費' },
  { id: 'L2', name: '舊工具', html: '<p>y</p>', author: '同事C', sharedAt: '2026-10-01T00:00:00Z' },
] });

test('a published tool fills a 自選 slot, and the slot empties once it is taken down', () => {
  assert.equal(resolvePick('shared:L1', listed)?.name, '手續費計算');
  assert.equal(resolvePick('shared:L9', listed), null);
  assert.equal(resolvePick('tool-workshop', listed)?.name, '小工具工坊');
});

test('publishing the same workshop tool again finds its listing; another author does not', () => {
  assert.equal(findListing(listed, 'w1', '同事C')?.id, 'L1');
  assert.equal(findListing(listed, 'w1', '別人'), null);
  assert.equal(listed[0].summary, '算手續費');
  assert.equal(listed[1].sourceId, undefined);
});
