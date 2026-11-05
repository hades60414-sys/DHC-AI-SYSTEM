import assert from 'node:assert/strict';

import { test } from 'vitest';

import { autoNameOf } from '@/shared/planBoards';
import type { PlanChatMessage } from '@/shared/planBoards';

const box = (text: string, x: number, y: number) => ({ x, y, text });
const asked = (text: string): PlanChatMessage => ({ role: 'user', text });

test('an empty board has no name to take', () => {
  assert.equal(autoNameOf([], []), null);
  assert.equal(autoNameOf([asked('  ')], [box('', 0, 0)]), null);
});

test('the first thing asked of the AI wins over the boxes, first line only', () => {
  assert.equal(autoNameOf([asked('畫報表流程\n細節…'), asked('再加一步')], [box('資料來源', 0, 0)]), '畫報表流程');
});

test('without a question, the top-left box with text names it; long names are cut', () => {
  assert.equal(autoNameOf([], [box('下面', 0, 300), box('', 0, 0), box('右上', 500, 0), box('左上', 0, 0.5)]), '右上');
  assert.equal(autoNameOf([], [box('一二三四五六七八九十一二三四五六七八九十一二', 0, 0)]), '一二三四五六七八九十一二三四五六七八九十…');
});
