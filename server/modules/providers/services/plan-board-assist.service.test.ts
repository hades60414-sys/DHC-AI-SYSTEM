import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractAnswerJson } from '@/modules/providers/services/plan-board-assist.service.js';

// DHC CLI 10/13 規劃白板: the assistant's answer is read even with a code fence or a sentence around the JSON.
test('board answers are read from fenced, bare, or broken replies', () => {
  const board = { nodes: [{ id: 'n1', text: 'A', x: 0, y: 0 }], edges: [] };
  assert.deepEqual(extractAnswerJson(JSON.stringify({ reply: '好', board })), { reply: '好', board });
  assert.deepEqual(extractAnswerJson(`\`\`\`json\n${JSON.stringify({ reply: '畫好了', board })}\n\`\`\``), { reply: '畫好了', board });
  assert.deepEqual(extractAnswerJson('{"reply":"只是回答","board":null}'), { reply: '只是回答', board: null });
  assert.deepEqual(extractAnswerJson('抱歉我不懂'), { reply: '抱歉我不懂', board: null });
  assert.deepEqual(extractAnswerJson('{壞掉'), { reply: '{壞掉', board: null });
});
