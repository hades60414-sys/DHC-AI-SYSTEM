import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { extractAnswerJson, parseBoardInput, parseLinkables, saveBoardImage } from '@/modules/providers/services/plan-board-assist.service.js';

// DHC CLI 10/13 規劃白板: the assistant's answer is read even with a code fence or a sentence around the JSON.
test('board answers are read from fenced, bare, or broken replies', () => {
  const board = { nodes: [{ id: 'n1', text: 'A', x: 0, y: 0 }], edges: [] };
  assert.deepEqual(extractAnswerJson(JSON.stringify({ reply: '好', board })), { reply: '好', board });
  assert.deepEqual(extractAnswerJson(`\`\`\`json\n${JSON.stringify({ reply: '畫好了', board })}\n\`\`\``), { reply: '畫好了', board });
  assert.deepEqual(extractAnswerJson('{"reply":"只是回答","board":null}'), { reply: '只是回答', board: null });
  assert.deepEqual(extractAnswerJson('抱歉我不懂'), { reply: '抱歉我不懂', board: null });
  assert.deepEqual(extractAnswerJson('{壞掉'), { reply: '{壞掉', board: null });
});

// 10/19: shapes, fills, loose things and @@ candidates come through a whitelist; anything else is dropped.
test('board input keeps known shapes, short fills, loose things of known kinds and valid links only', () => {
  const board = parseBoardInput({
    nodes: [
      { id: 'a', text: 'A', x: 1.4, y: 2, w: 200, h: 80, shape: 'diamond', fill: '#a5d8ff', link: { kind: 'session', id: 's1', label: '去識別層' } },
      { id: 'b', text: 'B', shape: 'hexagon', fill: 'red', link: { kind: 'person', id: 'p1', label: 'x' } },
      { id: 'c', fill: '#1234567890' },
    ],
    edges: [],
    loose: [
      { id: 'n1', kind: 'text', text: '或'.repeat(400), x: 3, y: 4, w: 5, h: 6, extra: 'dropped' },
      { id: 'n2', kind: 'image' },
      { kind: 'line' },
      ...Array.from({ length: 250 }, (_, index) => ({ id: `l${index}`, kind: 'line' })),
    ],
  });
  assert.deepEqual(board.nodes[0], { id: 'a', text: 'A', x: 1, y: 2, w: 200, h: 80, shape: 'diamond', fill: '#a5d8ff', link: { kind: 'session', id: 's1', label: '去識別層' } });
  assert.deepEqual(board.nodes[1], { id: 'b', text: 'B', x: 0, y: 0, w: 0, h: 0 });
  assert.equal('fill' in board.nodes[2], false, 'a fill longer than #rrggbbaa is not a colour');
  assert.equal(board.loose.length, 200);
  assert.deepEqual(board.loose[0], { id: 'n1', kind: 'text', text: '或'.repeat(300), x: 3, y: 4, w: 5, h: 6 });
  assert.ok(board.loose.every((item) => item.kind === 'text' || item.kind === 'line'));
  const linkables = parseLinkables([
    { kind: 'board', id: 'b1', label: '架'.repeat(100) },
    { kind: 'person', id: 'p1', label: 'x' },
    { kind: 'session', id: '' },
    ...Array.from({ length: 100 }, (_, index) => ({ kind: 'session', id: `s${index}`, label: `${index}` })),
  ]);
  assert.equal(linkables.length, 80);
  assert.deepEqual(linkables[0], { kind: 'board', id: 'b1', label: '架'.repeat(80) });
});

test('the screenshot is written only when it is a PNG under the size limit', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const file = await saveBoardImage(png.toString('base64'));
  assert.ok(file && path.basename(file).startsWith('dhc-board-') && path.dirname(file) === os.tmpdir());
  assert.deepEqual(await readFile(file), png);
  await rm(file, { force: true });
  assert.equal(await saveBoardImage(Buffer.from('GIF89a not a png').toString('base64')), null);
  assert.equal(await saveBoardImage(png.toString('base64') + 'A'.repeat(4 * 1024 * 1024)), null, 'a PNG over 4MB of base64');
  assert.equal(await saveBoardImage(42), null);
  assert.equal(await saveBoardImage(''), null);
});
