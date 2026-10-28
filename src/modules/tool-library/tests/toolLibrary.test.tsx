import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import React, { useState } from 'react';
import { test } from 'vitest';

import ToolLibrary from '@/modules/tool-library/ToolLibrary';
import { addPick, emptyPicks, movePick, parsePicks, removePick } from '@/shared/customTools';
import type { Picks } from '@/shared/customTools';

/**
 * DHC CLI 10/14 工具庫: tools as cards; 加入自選 fills the first empty of five slots, 我的自選 orders and empties
 * them, tools still being built show 製作中 and cannot be picked, and 功能許願池 opens from the bottom.
 */

function Harness({ start, onOpenTool = () => {}, onOpenWishes = () => {} }: { start?: Picks; onOpenTool?: (id: string) => void; onOpenWishes?: () => void }) {
  const [picks, setPicks] = useState<Picks>(start ?? emptyPicks());
  return <ToolLibrary isMobile={false} picks={picks} onPicksChange={setPicks} onOpenTool={onOpenTool} onOpenWishes={onOpenWishes} onClose={() => {}} />;
}

test('slots are five, read defensively, filled in order, moved and emptied', () => {
  assert.deepEqual(parsePicks(null), [null, null, null, null, null]);
  assert.deepEqual(parsePicks(['a', 3, '', 'b']), ['a', null, null, 'b', null]);
  const one = addPick(emptyPicks(), 'a')!;
  assert.deepEqual(one, ['a', null, null, null, null]);
  assert.equal(addPick(one, 'a'), null, 'already there');
  assert.equal(addPick(['a', 'b', 'c', 'd', 'e'], 'f'), null, 'all five taken');
  assert.deepEqual(movePick(one, 0, 1), [null, 'a', null, null, null]);
  assert.deepEqual(movePick(one, 0, -1), one, 'cannot move past the start');
  assert.deepEqual(removePick(one, 'a'), emptyPicks());
});

test('加入自選 puts 規劃白板 in a slot, the card then offers to take it out, and it opens', () => {
  const opened: string[] = [];
  render(<Harness onOpenTool={(id) => opened.push(id)} />);
  const card = screen.getByRole('article', { name: '規劃白板' });
  fireEvent.click(within(card).getByRole('button', { name: /加入自選/ }));
  const mine = screen.getByRole('region', { name: '我的自選' });
  assert.ok(within(mine).getByText('規劃白板'));
  assert.ok(within(card).getByRole('button', { name: '已在自選（拿掉）' }));
  fireEvent.click(within(card).getByRole('button', { name: '打開' }));
  assert.deepEqual(opened, ['plan-board']);
  fireEvent.click(within(mine).getByRole('button', { name: '從自選拿掉 規劃白板' }));
  assert.equal(within(mine).queryByText('規劃白板'), null);
});

test('a full set of slots says so instead of adding', () => {
  render(<Harness start={['x1', 'x2', 'x3', 'x4', 'x5']} />);
  fireEvent.click(within(screen.getByRole('article', { name: '規劃白板' })).getByRole('button', { name: /加入自選/ }));
  assert.ok(screen.getByText(/五格自選都滿了/));
});

test('功能許願池 opens from the bottom of 工具庫', () => {
  let wishes = 0;
  render(<Harness onOpenWishes={() => { wishes += 1; }} />);
  fireEvent.click(screen.getByRole('button', { name: /功能許願池/ }));
  assert.equal(wishes, 1);
});
