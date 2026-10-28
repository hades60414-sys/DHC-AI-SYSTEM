import assert from 'node:assert/strict';

import { test } from 'vitest';

import { boardNameFromFile, extractMermaid, importKind, looksLikeMermaid, parseExcalidrawJson } from '@/modules/plan-board/boardImport';

/** DHC CLI 10/14 規劃白板 匯入: the pure parsing (Excalidraw scene file, Mermaid block); the canvas itself is not rendered here. */

const FENCE = '`'.repeat(3);

test('parseExcalidrawJson keeps live elements and rejects other JSON', () => {
  const scene = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [{ id: 'a', type: 'rectangle' }, { id: 'b', type: 'text', isDeleted: true }, { id: 'c', type: 'arrow' }, 'junk', { type: 'x' }],
  });
  const parsed = parseExcalidrawJson(scene);
  assert.ok('elements' in parsed);
  if ('elements' in parsed) assert.deepEqual(parsed.elements.map((element) => (element as { id: string }).id), ['a', 'c']);
  assert.ok('error' in parseExcalidrawJson('{"type":"other","elements":[]}'));
  assert.ok('error' in parseExcalidrawJson('not json'));
  assert.ok('error' in parseExcalidrawJson(JSON.stringify({ type: 'excalidraw', elements: [{ id: 'z', type: 'text', isDeleted: true }] })));
  assert.ok('elements' in parseExcalidrawJson(`﻿${scene}`));
});

test('extractMermaid takes the first mermaid fence of a markdown file, or a bare diagram', () => {
  const md = [
    '# 流程', `${FENCE}sql`, 'select 1', FENCE,
    `${FENCE}mermaid`, 'flowchart TD', '  A-->B', FENCE,
    `${FENCE}mermaid`, 'graph LR', '  X-->Y', FENCE, '',
  ].join('\n');
  assert.equal(extractMermaid(md), 'flowchart TD\n  A-->B');
  assert.equal(extractMermaid('graph LR\n  A-->B\n'), 'graph LR\n  A-->B');
  assert.equal(extractMermaid('%% note\nsequenceDiagram\n  A->>B: hi'), '%% note\nsequenceDiagram\n  A->>B: hi');
  assert.equal(extractMermaid('---\ntitle: t\n---\nflowchart LR\n A-->B')?.includes('flowchart LR'), true);
  assert.equal(extractMermaid('just some notes\nabout things'), null);
  assert.equal(extractMermaid(`${FENCE}mermaid\n${FENCE}`), null);
  assert.equal(looksLikeMermaid('pie title x'), true);
  assert.equal(looksLikeMermaid('hello'), false);
});

test('importKind and board names come from the file name', () => {
  assert.equal(importKind('a.excalidraw'), 'excalidraw');
  assert.equal(importKind('a.JSON'), 'excalidraw');
  assert.equal(importKind('a.mmd'), 'mermaid');
  assert.equal(importKind('a.md'), 'mermaid');
  assert.equal(importKind('a.txt'), 'mermaid');
  assert.equal(importKind('a.png'), 'unsupported');
  assert.equal(boardNameFromFile('流程圖.v2.mmd'), '流程圖.v2');
  assert.equal(boardNameFromFile('.mmd'), '匯入的白板');
});
