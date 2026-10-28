import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const SUMMARY = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. ...';

test('a live compact summary without the flag is not a user bubble', () => {
  // The SDK stream re-emits the summary as a plain synthetic user message, so
  // during the run it rendered as a huge right-side bubble from the user.
  const [message] = new ClaudeSessionsProvider().normalizeMessage(
    { type: 'user', isSynthetic: true, message: { role: 'user', content: SUMMARY }, parent_tool_use_id: null },
    's1',
  );
  assert.equal(message.role, 'assistant');
  assert.equal(message.isCompactSummary, true);
});

test('a transcript compact summary keeps working', () => {
  const [message] = new ClaudeSessionsProvider().normalizeMessage(
    { type: 'user', uuid: 'u1', isCompactSummary: true, message: { role: 'user', content: SUMMARY } },
    's1',
  );
  assert.equal(message.isCompactSummary, true);
});

test('an ordinary prompt stays a user message', () => {
  const [message] = new ClaudeSessionsProvider().normalizeMessage(
    { type: 'user', message: { role: 'user', content: 'Hello' } },
    's1',
  );
  assert.equal(message.role, 'user');
  assert.equal(message.isCompactSummary, undefined);
});

test('a live compact summary sent as text blocks is not a user bubble', () => {
  const [message] = new ClaudeSessionsProvider().normalizeMessage(
    { type: 'user', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: SUMMARY }] } },
    's1',
  );
  assert.equal(message.role, 'assistant');
  assert.equal(message.isCompactSummary, true);
});

test('compaction status becomes a status event', () => {
  const provider = new ClaudeSessionsProvider();
  const [start] = provider.normalizeMessage({ type: 'system', subtype: 'status', status: 'compacting' }, 's1');
  const [end] = provider.normalizeMessage({ type: 'system', subtype: 'status', status: null, compact_result: 'success' }, 's1');
  assert.equal(start.kind, 'status');
  assert.equal(start.text, 'compacting');
  assert.equal(end.text, 'compacting_done');
});
