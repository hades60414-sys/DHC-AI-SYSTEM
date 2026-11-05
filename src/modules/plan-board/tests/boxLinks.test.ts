import assert from 'node:assert/strict';

import { test } from 'vitest';

import { linkOf, linkPatch } from '@/modules/plan-board/boxLinkData';

/** 10/19: a box linked with @@ keeps its other custom data and takes the chat room's colours. */

test('linking keeps other custom data and fills with the conversation colour', () => {
  const patch = linkPatch({ customData: { keep: 1 } }, { kind: 'session', id: 's1', label: 'PRESENTER 外接' });
  assert.deepEqual(patch.customData, { keep: 1, dhcRef: { kind: 'session', id: 's1', label: 'PRESENTER 外接' } });
  assert.equal(patch.fillStyle, 'solid');
  assert.equal(patch.backgroundColor, '#e5dbff');
  assert.deepEqual(linkOf(patch), patch.customData.dhcRef);
});

test('a whiteboard link is green; people and junk are not links', () => {
  assert.equal(linkPatch({}, { kind: 'board', id: 'b1', label: '白板' }).backgroundColor, '#c3fae8');
  assert.equal(linkOf({ customData: { dhcRef: { kind: 'person', id: 'p', label: 'x' } } }), null);
  assert.equal(linkOf({ customData: { dhcRef: 'nope' } }), null);
  assert.equal(linkOf({}), null);
});
