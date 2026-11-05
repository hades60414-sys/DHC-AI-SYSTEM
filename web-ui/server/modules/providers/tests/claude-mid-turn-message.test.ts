import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

// DHC CLI: a message sent while a turn runs is stored by the CLI as a `queued_command` attachment
// (shape copied from a real transcript, 2026-10-15), not as a user row.
const queuedRow = (prompt: unknown, commandMode = 'prompt') => ({
  type: 'attachment',
  uuid: 'a1',
  timestamp: '2026-10-15T03:12:44.600Z',
  attachment: {
    type: 'queued_command',
    prompt,
    source_uuid: 'src1',
    commandMode,
    timestamp: '2026-10-15T03:12:44.567Z',
  },
});

test('a mid-turn message shows as the user\'s own message, marked mid-turn', () => {
  const messages = new ClaudeSessionsProvider().normalizeMessage(queuedRow('Change of plan: run echo ZZZ'), 's1');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].content, 'Change of plan: run echo ZZZ');
  assert.equal(messages[0].midTurn, true);
  assert.equal(messages[0].timestamp, '2026-10-15T03:12:44.567Z');
  // It has no turn of its own, so edit/fork must not anchor on it.
  assert.equal(messages[0].transcriptAnchorId, undefined);
});

test('a background-task notification queued the same way is not a user message', () => {
  const messages = new ClaudeSessionsProvider().normalizeMessage(
    queuedRow('<task-notification>done</task-notification>', 'task-notification'),
    's1',
  );
  assert.equal(messages.filter((message) => message.role === 'user').length, 0);
});

test('a mid-turn message sent as content blocks keeps its text', () => {
  const messages = new ClaudeSessionsProvider().normalizeMessage(
    queuedRow([{ type: 'text', text: '看這張圖' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]),
    's1',
  );
  assert.equal(messages[0].content, '看這張圖');
});
