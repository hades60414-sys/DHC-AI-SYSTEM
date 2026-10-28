import assert from 'node:assert/strict';

import { test } from 'vitest';

import { timeTag } from '@/modules/todo-dock/TimeTag';
import type { TodoItem } from '@/shared/personTodos';

const now = new Date(2026, 9, 13, 12);
const item = (patch: Partial<TodoItem>): TodoItem => ({ id: 'a', text: 'x', done: false, createdAt: new Date(2026, 9, 13).toISOString(), today: false, ...patch });
const label = (patch: Partial<TodoItem>, showAge = true) => {
  const tag = timeTag(item(patch), showAge, now);
  return tag && `${tag.tone}:${tag.label}`;
};

test('10/13: one small word per task — a due countdown, else its age once it has sat a week', () => {
  assert.equal(label({ due: '2026-10-20' }), 'muted:10/20');
  assert.equal(label({ due: '2026-10-15' }), 'amber:剩 2 天');
  assert.equal(label({ due: '2026-10-13' }), 'red:今天');
  assert.equal(label({ due: '2026-10-10' }), 'red:過 3 天');
  assert.equal(label({ due: '2026-10-10', done: true }), null);
  assert.equal(label({}), null);
  assert.equal(label({ createdAt: new Date(2026, 9, 5).toISOString() }), 'muted:8 天');
  assert.equal(label({ createdAt: new Date(2026, 8, 20).toISOString() }), 'amber:23 天');
  assert.equal(label({ createdAt: new Date(2026, 8, 20).toISOString() }, false), null, 'subtasks inside a card show no age');
  assert.equal(label({ createdAt: new Date(2026, 8, 20).toISOString(), due: '2026-10-20' }), 'muted:10/20', 'a due date wins over age');
});
