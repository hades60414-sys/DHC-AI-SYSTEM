import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatClock, formatDayLabel, formatFullStamp, isSameDay } from '@/modules/chat/utils/messageTime';

/** DHC CLI 9/26: bubble clock, tooltip stamp and the day divider labels. */

const NOW = new Date(2026, 8, 26, 15, 4, 7); // 2026-09-26 15:04:07 local

test('clock and full stamp use zero-padded local time', () => {
  assert.equal(formatClock(NOW), '15:04');
  assert.equal(formatFullStamp(NOW), '2026/09/26 15:04:07');
  assert.equal(formatClock(new Date(2026, 0, 2, 9, 5)), '09:05');
});

test('bad or missing stamps render as nothing rather than "Invalid Date"', () => {
  assert.equal(formatClock(undefined), '');
  assert.equal(formatClock('not a date'), '');
  assert.equal(formatFullStamp(null), '');
  assert.equal(formatDayLabel('', NOW), '');
});

test('day labels: today, yesterday, same-year date, other-year date', () => {
  assert.equal(formatDayLabel(new Date(2026, 8, 26, 0, 1), NOW), '今天');
  assert.equal(formatDayLabel(new Date(2026, 8, 25, 23, 59), NOW), '昨天');
  assert.equal(formatDayLabel(new Date(2026, 8, 24, 12, 0), NOW), '9月24日（週四）');
  assert.equal(formatDayLabel(new Date(2025, 11, 31, 12, 0), NOW), '2025年12月31日（週三）');
});

test('isSameDay compares calendar days across string and Date inputs', () => {
  assert.equal(isSameDay('2026-09-26T00:10:00', NOW), true);
  assert.equal(isSameDay(new Date(2026, 8, 25, 23, 59), NOW), false);
  assert.equal(isSameDay(undefined, NOW), false);
});

test('elapsed labels: seconds, minutes, hours, and nothing for unknown or zero', async () => {
  const { formatElapsed } = await import('@/modules/chat/utils/messageTime');
  const t0 = new Date(2026, 8, 26, 15, 0, 0);
  assert.equal(formatElapsed(t0, new Date(2026, 8, 26, 15, 0, 42)), '42秒');
  assert.equal(formatElapsed(t0, new Date(2026, 8, 26, 15, 2, 13)), '2分13秒');
  assert.equal(formatElapsed(t0, new Date(2026, 8, 26, 15, 3, 0)), '3分');
  assert.equal(formatElapsed(t0, new Date(2026, 8, 26, 16, 5, 0)), '1小時5分');
  assert.equal(formatElapsed(t0, t0), '');
  assert.equal(formatElapsed(undefined, t0), '');
});
