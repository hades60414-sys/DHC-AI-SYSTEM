import assert from 'node:assert/strict';

import { test } from 'vitest';

import { labelSize, layoutMarks, routes } from '@/shared/ui/TutorialOverlay';

type R = { x: number; y: number; w: number; h: number };
const overlaps = (a: R, b: R) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: R, vw: number, vh: number) => r.x >= 0 && r.y >= 0 && r.x + r.w <= vw && r.y + r.h <= vh;

test('only active marks get a callout; idle ones keep just the box', () => {
  const marks = layoutMarks([
    { tip: '月亮：開著時送出的訊息先存著', box: { x: 300, y: 860, w: 28, h: 28 }, active: true },
    { tip: '快閃任務', box: { x: 332, y: 860, w: 28, h: 28 }, active: false },
  ], 1440, 900);
  assert.ok(marks[0].label);
  assert.equal(marks[1].label, null);
});

test('regression (Astra 11/01): a crowded column never yields callouts that leave the viewport, cover a box or each other', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    tip: '這是一段大約二十五個字的說明文字，用來測試擠在一起的狀況',
    box: { x: 300, y: 4 + i * 30, w: 20, h: 20 },
    active: true,
  }));
  const marks = layoutMarks(items, 320, 400);
  const labels = marks.flatMap((m) => (m.label ? [m.label] : []));
  for (const l of labels) {
    assert.ok(inside(l, 320, 400), 'inside viewport');
    for (const b of items.map((i) => i.box)) assert.ok(!overlaps(l, b), 'covers no box');
  }
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) assert.ok(!overlaps(labels[i], labels[j]), 'no two callouts overlap');
  }
});

test('the straight route runs from the callout edge to the box edge', () => {
  const box = { x: 100, y: 100, w: 20, h: 20 };
  const label = { x: 80, y: 140, w: 120, h: 30 };
  const [c] = routes(box, label)[0];
  assert.equal(c.y1, 140, 'starts on the callout top edge');
  assert.equal(c.y2, 120, 'ends on the box bottom edge');
});

test('a callout is dropped rather than drawn far away or with a line through another control', () => {
  const target = { x: 100, y: 100, w: 20, h: 20 };
  // A wall of other controls all around the target: no spot within reach has a clear line.
  const wall = [
    { x: 40, y: 40, w: 140, h: 40 }, { x: 40, y: 140, w: 140, h: 40 },
    { x: 40, y: 80, w: 40, h: 60 }, { x: 140, y: 80, w: 40, h: 60 },
  ];
  const marks = layoutMarks([
    { tip: '被包圍的按鈕', box: target, active: true },
    ...wall.map((box) => ({ tip: '牆', box, active: false })),
  ], 1000, 800);
  assert.equal(marks[0].label, null);
});

test('long unbroken text wraps instead of overflowing the measured width', () => {
  const { w, h } = labelSize('x'.repeat(100), 260);
  assert.ok(w <= 260);
  assert.ok(h > 40, 'several lines');
});

test('the control under the pointer keeps its callout even when crowded', () => {
  const target = { x: 100, y: 100, w: 20, h: 20 };
  const wall = [
    { x: 40, y: 40, w: 140, h: 40 }, { x: 40, y: 140, w: 140, h: 40 },
    { x: 40, y: 80, w: 40, h: 60 }, { x: 140, y: 80, w: 40, h: 60 },
  ];
  const marks = layoutMarks([
    { tip: '被包圍的按鈕', box: target, active: true, direct: true },
    ...wall.map((box) => ({ tip: '牆', box, active: false })),
  ], 1000, 800);
  assert.ok(marks[0].label);
  assert.ok(!overlaps(marks[0].label!, target));
});

test('regression (Astra round 3): a narrow window still gives the pointed control a callout', () => {
  const marks = layoutMarks([
    { tip: '這是一段大約二十五個字的說明文字，用來測試窄視窗的狀況喔', box: { x: 100, y: 300, w: 24, h: 24 }, active: true, direct: true },
  ], 320, 640);
  assert.ok(marks[0].label);
});
