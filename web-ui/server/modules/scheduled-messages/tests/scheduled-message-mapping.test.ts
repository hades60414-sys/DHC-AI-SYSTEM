import assert from 'node:assert/strict';
import test from 'node:test';

import { toScheduledMessage } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';

type ScheduledMessageRow = Parameters<typeof toScheduledMessage>[0];

const row = (overrides: Partial<ScheduledMessageRow> = {}): ScheduledMessageRow => ({
  id: 'msg-1',
  user_id: 7,
  session_id: 'session-1',
  content: 'ping the deploy',
  options: '{"permissionMode":"plan"}',
  scheduled_for: '2026-01-10T12:00:00.000Z',
  status: 'pending',
  failure_reason: null,
  created_at: '2026-01-09T12:00:00.000Z',
  updated_at: '2026-01-09T12:00:00.000Z',
  ...overrides,
});

test('toScheduledMessage maps a database row to the API shape', () => {
  assert.deepEqual(toScheduledMessage(row()), {
    id: 'msg-1',
    sessionId: 'session-1',
    content: 'ping the deploy',
    options: { permissionMode: 'plan' },
    scheduledFor: '2026-01-10T12:00:00.000Z',
    status: 'pending',
    failureReason: null,
    createdAt: '2026-01-09T12:00:00.000Z',
  });
});

test('toScheduledMessage keeps the failure reason', () => {
  assert.equal(toScheduledMessage(row({ status: 'failed', failure_reason: 'session busy' })).failureReason, 'session busy');
});

test('toScheduledMessage turns corrupt or non-object options into an empty object', () => {
  for (const options of ['{not json', '[1,2]', '"text"', 'null', '']) {
    assert.deepEqual(toScheduledMessage(row({ options })).options, {}, `options=${options}`);
  }
});
