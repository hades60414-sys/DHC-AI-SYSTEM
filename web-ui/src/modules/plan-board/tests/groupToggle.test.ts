import assert from 'node:assert/strict';

import { test } from 'vitest';

import { wholeGroupOf } from '@/modules/plan-board/sceneModel';

/** 10/19: a second Ctrl+G ungroups only when the selection is exactly one whole group. */

test('whole group detection', () => {
  const els = [
    { id: 'a', groupIds: ['g1'] },
    { id: 'b', groupIds: ['g1'] },
    { id: 'c', groupIds: [] },
    { id: 'd', groupIds: ['inner', 'outer'] },
    { id: 'e', groupIds: ['outer'] },
  ];
  assert.equal(wholeGroupOf(els, { a: true, b: true }), 'g1');
  assert.equal(wholeGroupOf(els, { a: true }), null, 'part of a group');
  assert.equal(wholeGroupOf(els, { a: true, b: true, c: true }), null, 'group plus a loose box');
  assert.equal(wholeGroupOf(els, { c: true }), null, 'nothing grouped');
  assert.equal(wholeGroupOf(els, { d: true, e: true }), 'outer', 'outermost group first');
});
