import assert from 'node:assert/strict';
import test from 'node:test';

import { recentUserMessages } from '@/modules/providers/services/session-title-suggest.service.js';

const userLine = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });

test('recentUserMessages keeps only the user\'s own words, oldest first', () => {
  const transcript = [
    userLine('first question'),
    JSON.stringify({ type: 'assistant', message: { content: 'an answer' } }),
    userLine([{ type: 'text', text: 'second' }, { type: 'image', source: {} }, { type: 'text', text: 'part' }]),
    userLine('tool output', { toolUseResult: { stdout: 'x' } }),
    userLine('meta note', { isMeta: true }),
    userLine('summary', { isCompactSummary: true }),
    userLine('<command-name>/clear</command-name>'),
    'not json but mentions "type":"user"',
    '',
  ].join('\n');

  assert.deepEqual(recentUserMessages(transcript), ['first question', 'second part']);
});

test('recentUserMessages strips attached-file blocks and a leading 【tag】', () => {
  const transcript = [
    userLine('【夜間排程】  please   look\n\nat this'),
    userLine('before <files_input>huge file body</files_input> after'),
    userLine('only <files_input>an unterminated block'),
  ].join('\r\n');

  assert.deepEqual(recentUserMessages(transcript), ['please look at this', 'before after', 'only']);
});

test('recentUserMessages caps each message at 300 characters and returns the last N', () => {
  const transcript = Array.from({ length: 10 }, (_, index) => userLine(`message ${index}`)).join('\n');
  assert.deepEqual(recentUserMessages(transcript, 3), ['message 7', 'message 8', 'message 9']);
  assert.equal(recentUserMessages(transcript).length, 6);

  const long = recentUserMessages(userLine('y'.repeat(1000)));
  assert.deepEqual(long, ['y'.repeat(300)]);
});

test('recentUserMessages returns nothing for an empty transcript', () => {
  assert.deepEqual(recentUserMessages(''), []);
});
