import assert from 'node:assert/strict';

import { test } from 'vitest';

import { boardToCards } from '@/modules/plan-board/boardToCards';
import type { PlanEdge, PlanNode } from '@/shared/planBoards';

const node = (id: string, x: number, y: number, text = id): PlanNode => ({ id, x, y, w: 160, h: 80, text });
const edge = (from: string, to: string): PlanEdge => ({ id: `${from}-${to}`, from, to, text: '' });
const order = (cards: Array<{ id: string }>) => cards.map((card) => card.id).join('');

test('a chain drawn out of order is listed by arrows, with dependsOn', () => {
  const cards = boardToCards([node('c', 0, 0), node('a', 0, 300), node('b', 0, 150)], [edge('a', 'b'), edge('b', 'c')]);
  assert.equal(order(cards), 'abc');
  assert.deepEqual(cards.map((card) => card.dependsOn), [[], ['a'], ['b']]);
});

test('a branch and a join wait for all predecessors; ties follow reading order', () => {
  const nodes = [node('s', 0, 0), node('l', 0, 200), node('r', 300, 200), node('j', 0, 400)];
  const cards = boardToCards(nodes, [edge('s', 'l'), edge('s', 'r'), edge('l', 'j'), edge('r', 'j')]);
  assert.equal(order(cards), 'slrj');
  assert.deepEqual([...cards[3].dependsOn].sort(), ['l', 'r']);
});

test('a cycle falls back to reading order and drops the arrow that points backwards', () => {
  const cards = boardToCards([node('b', 0, 200), node('a', 0, 0)], [edge('a', 'b'), edge('b', 'a')]);
  assert.equal(order(cards), 'ab');
  assert.deepEqual(cards.map((card) => card.dependsOn), [[], ['a']]);
});

test('unconnected boxes go top to bottom, then left to right; title is the first line, note the rest', () => {
  const nodes = [node('r', 300, 10, '右'), node('l', 0, 0, '左\n細節一\n細節二'), node('d', 0, 300, ''), node('x', 0, 100, 'x')];
  const cards = boardToCards(nodes, [edge('ghost', 'l')]);
  assert.deepEqual(cards.map((card) => card.title), ['左', '右', 'x']);
  assert.equal(cards[0].note, '細節一\n細節二');
  assert.deepEqual(cards[0].dependsOn, []);
});

test('no boxes, no cards', () => {
  assert.deepEqual(boardToCards([], []), []);
});

test('empty boxes are not cards, and arrows to them are dropped', () => {
  const box = (id: string, text: string, x: number) => ({ id, text, x, y: 0, w: 200, h: 80 });
  const cards = boardToCards([box('a', '抓部位', 0), box('b', '  ', 300), box('c', '寄報表', 600)], [{ id: 'e1', from: 'a', to: 'b', text: '' }, { id: 'e2', from: 'b', to: 'c', text: '' }]);
  assert.deepEqual(cards.map((card) => [card.title, card.dependsOn]), [['抓部位', []], ['寄報表', []]]);
});
