import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOOL_PROMPTS } from '@/modules/providers/services/tool-assist/prompts/index.js';
import { extractToolAnswer, toolAssistService } from '@/modules/providers/services/tool-assist/tool-assist.service.js';

test('the answer JSON is found even inside a code fence, and plain text becomes the reply', () => {
  assert.deepEqual(extractToolAnswer('```json\n{"reply":"好","result":{"items":[]}}\n```'), { reply: '好', result: { items: [] } });
  assert.deepEqual(extractToolAnswer('沒有 JSON'), { reply: '沒有 JSON', result: null });
  assert.deepEqual(extractToolAnswer('{"reply":"只回答"}'), { reply: '只回答', result: null });
});

test('every 工具庫 tool has instructions, and an unknown tool or empty request is refused before Claude runs', async () => {
  for (const tool of ['project-board', 'code-review', 'sheet-bench', 'doc-editor', 'tool-workshop', 'deck-studio']) {
    assert.ok(TOOL_PROMPTS[tool]?.length > 50, tool);
  }
  await assert.rejects(toolAssistService.assist({ tool: 'nope', message: 'x' }), /Unknown tool/);
  await assert.rejects(toolAssistService.assist({ tool: 'toString', message: 'x' }), /Unknown tool/);
  await assert.rejects(toolAssistService.assist({ tool: 'doc-editor', message: '  ' }), /Say what/);
});

test('a long page written after the JSON fills the "@@BLOCK@@" string', () => {
  const raw = '{"reply":"做好了","result":{"name":"計算機","html":"@@BLOCK@@"}}\n```html\n<!doctype html>\n<p>"引號" {大括號}</p>\n```';
  assert.deepEqual(extractToolAnswer(raw), { reply: '做好了', result: { name: '計算機', html: '<!doctype html>\n<p>"引號" {大括號}</p>' } });
});
