import assert from 'node:assert/strict';

import { test } from 'vitest';

import { boardsFor, hasUnsaved, invitesFor, mergeBoard, mergeChat, mergeElements, parseCoBoards, restoreTo, toPersonal, withMembers, withoutMember } from '@/shared/coBoards';
import type { CoBoard } from '@/shared/coBoards';
import { emptyBoard } from '@/shared/planBoards';

const el = (id: string, version: number, extra: Record<string, unknown> = {}) => ({ id, version, versionNonce: 1, ...extra });

test('elements merge by version per id; a deletion with a higher version wins over the old copy', () => {
  const mine = [el('a', 3, { x: 10 }), el('b', 1), el('c', 2, { isDeleted: true })];
  const theirs = [el('a', 2, { x: 0 }), el('b', 4, { x: 99 }), el('c', 1), el('d', 1)];
  const merged = mergeElements(mine, theirs) as Array<Record<string, unknown>>;
  assert.deepEqual(merged.map((item) => [item.id, item.version]), [['a', 3], ['b', 4], ['c', 2], ['d', 1]]);
  assert.equal(merged[2].isDeleted, true);
  // Same version: both pages pick the lower nonce.
  const tie = mergeElements([{ id: 'x', version: 2, versionNonce: 9 }], [{ id: 'x', version: 2, versionNonce: 3 }]) as Array<{ versionNonce: number }>;
  assert.equal(tie[0].versionNonce, 3);
});

test('chat merges once per message in time order, keeping old untimed messages first', () => {
  const old = { role: 'user' as const, text: '舊的' };
  const a = { role: 'user' as const, text: '甲問', at: '2026-10-14T01:00:00Z', by: '甲' };
  const b = { role: 'user' as const, text: '乙問', at: '2026-10-14T00:59:00Z', by: '乙' };
  assert.deepEqual(mergeChat([old, a], [old, b, a]).map((m) => m.text), ['舊的', '乙問', '甲問']);
});

test('restore bumps versions above the canvas and marks later additions deleted, so a merge keeps the undo', () => {
  const snapshot = [el('a', 1, { x: 0 })];
  const current = [el('a', 5, { x: 50 }), el('n', 2)];
  const restored = restoreTo(current, snapshot) as Array<Record<string, unknown>>;
  const merged = mergeElements(current, restored) as Array<Record<string, unknown>>;
  assert.equal(merged.find((item) => item.id === 'a')!.x, 0);
  assert.equal(merged.find((item) => item.id === 'n')!.isDeleted, true);
});

test('sharing, leaving and parsing a shared board', () => {
  const base = emptyBoard('流程');
  const shared = withMembers(base, 'me', ['me', 'p1', 'p2'], { from: 'me', message: '' }) as CoBoard;
  assert.deepEqual(shared.co.members, ['p1', 'p2']);
  assert.deepEqual(Object.keys(shared.co.invites ?? {}), ['p1', 'p2']);
  const again = withMembers(shared, 'me', ['p1', 'p2', 'p3'], { from: 'me', message: '' }) as CoBoard;
  assert.equal(again.co.invites?.p3?.from, 'me');
  assert.equal(withMembers(base, 'me', ['me'], { from: 'me', message: '' }), null, 'nobody else means not shared');
  const left = withoutMember(again, 'p1') as CoBoard;
  assert.deepEqual(left.co.members, ['p2', 'p3']);
  assert.equal(withoutMember(withoutMember(left, 'p2') as CoBoard, 'p3'), null);
  const parsed = parseCoBoards({ items: [again, { ...base, co: { ownerProjectId: 'x', members: [] } }, { bad: true }] });
  assert.equal(parsed.length, 1);
  assert.deepEqual(boardsFor(parsed, 'p3').map((board) => board.id), [base.id]);
  assert.deepEqual(boardsFor(parsed, 'stranger'), []);
  const personal = toPersonal({ ...again, elements: [el('a', 1), el('b', 2, { isDeleted: true })] });
  assert.equal('co' in personal, false);
  assert.equal(personal.elements.length, 1);
});

test('a content save keeps the server membership and merges both sides', () => {
  const server = withMembers({ ...emptyBoard('板'), elements: [el('a', 2)] }, 'me', ['p1', 'p2'], { from: 'me', message: '' }) as CoBoard;
  const local: CoBoard = { ...server, co: { ownerProjectId: 'me', members: ['p1'] }, elements: [el('a', 1), el('b', 1)], updatedAt: '2099-01-01T00:00:00Z', name: '新名' };
  const merged = mergeBoard(server, local);
  assert.deepEqual(merged.co.members, ['p1', 'p2']);
  assert.equal(merged.name, '新名');
  assert.deepEqual((merged.elements as Array<{ id: string; version: number }>).map((item) => [item.id, item.version]), [['a', 2], ['b', 1]]);
});

test('invitations list only the boards this person has not opened yet', () => {
  const shared = withMembers({ ...emptyBoard('白板一'), id: 'b1' }, 'owner', ['p1', 'p2'], { from: 'owner', message: '看一下' }) as CoBoard;
  const opened = { ...shared, co: { ...shared.co, invites: { p2: shared.co.invites!.p2 } } };
  assert.deepEqual(invitesFor([shared], 'p1').map((item) => [item.boardId, item.name, item.from, item.message]), [['b1', '白板一', 'owner', '看一下']]);
  assert.deepEqual(invitesFor([opened], 'p1'), []);
  assert.deepEqual(invitesFor([shared], 'owner'), []);
});

// The path TLC found (.claude/skills/coboard-merge, CoBoards.tla): two pages save at once and the later write drops
// the earlier page's element; only a page that saves again after its pull gets it back on the shared board.
test('two pages saving at once lose the earlier write until that page sees it is missing and saves again', () => {
  const start = withMembers({ ...emptyBoard('白板'), id: 'b1' }, 'A', ['B'], { from: 'A', message: '' }) as CoBoard;
  const pageA: CoBoard = { ...start, elements: [el('e1', 1)], updatedAt: '2026-10-25T01:00:00Z' };
  const pageB: CoBoard = { ...start, elements: [el('e2', 1)], updatedAt: '2026-10-25T01:00:01Z' };
  const readByA = start;
  const readByB = start;
  const afterA = mergeBoard(readByA, pageA);
  const afterB = mergeBoard(readByB, pageB); // written over afterA: B read the record before A's write
  assert.deepEqual(afterB.elements.map((e) => (e as { id: string }).id), ['e2']);
  // A's 5-second pull: merge the server copy into the canvas; the canvas still has e1, which the server lacks.
  const canvasA = mergeElements(pageA.elements, afterB.elements);
  assert.equal(hasUnsaved(afterB.elements, canvasA), true);
  const resaved = mergeBoard(afterB, { ...pageA, elements: canvasA });
  assert.deepEqual(resaved.elements.map((e) => (e as { id: string }).id).sort(), ['e1', 'e2']);
  assert.equal(hasUnsaved(resaved.elements, canvasA), false);
  void afterA;
});

test('hasUnsaved: only a missing element or a newer version counts, not an older or equal one', () => {
  assert.equal(hasUnsaved([el('a', 2)], [el('a', 2)]), false);
  assert.equal(hasUnsaved([el('a', 2)], [el('a', 1)]), false);
  assert.equal(hasUnsaved([el('a', 2)], [el('a', 3)]), true);
  assert.equal(hasUnsaved([], [el('a', 1, { isDeleted: true })]), true);
  assert.equal(hasUnsaved([el('a', 1)], []), false);
});
