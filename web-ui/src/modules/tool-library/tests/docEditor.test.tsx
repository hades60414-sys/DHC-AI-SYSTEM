import assert from 'node:assert/strict';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import JSZip from 'jszip';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as CustomToolsModule from '@/shared/customTools';
import {
  applyDocResult, buildDocx, docBrief, docContext, docxParts, documentXml, escapeXml, parseBlocks, parseDocsData, parseInline,
} from '@/modules/tool-library/tools/docModel';

/**
 * DHC CLI 10/14 文件共編: Markdown → .docx parts, AI result application, stored data, and a render smoke.
 */

vi.mock('@/shared/customTools', async (importOriginal) => ({
  ...(await importOriginal<typeof CustomToolsModule>()),
  loadToolData: async () => ({ docs: [{ id: 'd1', title: '月報', markdown: '# 標題\n\n內容 **粗**' }], activeId: 'd1' }),
  createToolSaver: () => ({ save: () => {}, flush: async () => {} }),
}));

const { default: DocEditor } = await import('@/modules/tool-library/tools/DocEditor');

window.HTMLElement.prototype.scrollIntoView = () => {};
// CodeMirror measures text with ranges, which jsdom lacks.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
Range.prototype.getClientRects = emptyRects;
Range.prototype.getBoundingClientRect = () => new DOMRect();

Element.prototype.scrollIntoView = () => {};
afterEach(() => { localStorage.clear(); });

const parseXml = (xml: string) => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  assert.equal(doc.getElementsByTagName('parsererror').length, 0, `not well-formed: ${xml.slice(0, 200)}`);
  return doc;
};
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const byTag = (doc: Document, tag: string) => Array.from(doc.getElementsByTagNameNS(W, tag));

const SAMPLE = [
  '# 月報', '', '第一段 **重點** 與 *斜體* 和 `code`，',
  '接著第二行。', '', '## 清單', '', '- 甲', '  - 甲一', '- 乙', '', '1. 一', '2. 二', '', '3. 三', '',
  '### 表格', '', '| 名稱 | 金額 |', '| --- | ---: |', '| A & B | 1 < 2 |', '| C | 3 |', '',
  '> 引用文字', '', '```', 'x = 1 < 2', '```', '', '---', '', '#### 四級',
].join('\n');

test('inline markdown: bold, italic, code, links, escapes, unmatched markers', () => {
  assert.deepEqual(parseInline('a **b** *c* `d`'), [
    { text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', italic: true }, { text: ' ' }, { text: 'd', code: true },
  ]);
  assert.deepEqual(parseInline('**粗*斜*字**').map((r) => [r.text, !!r.bold, !!r.italic]), [['粗', true, false], ['斜', true, true], ['字', true, false]]);
  assert.equal(parseInline('[官網](https://x.tw)').map((r) => r.text).join(''), '官網 (https://x.tw)');
  assert.equal(parseInline('2 * 3 * 4').map((r) => r.text).join(''), '2 * 3 * 4');
  assert.equal(parseInline('snake_case_name').map((r) => r.text).join(''), 'snake_case_name');
  assert.equal(parseInline('\\*not italic\\*').map((r) => r.text).join(''), '*not italic*');
});

test('blocks: headings, nested lists, restarting numbered lists, tables', () => {
  const { blocks, orderedLists } = parseBlocks(SAMPLE);
  assert.deepEqual(blocks.filter((b) => b.t === 'heading').map((b) => (b as { level: number }).level), [1, 2, 3, 4]);
  const items = blocks.filter((b) => b.t === 'item') as Array<{ level: number; numId: number }>;
  assert.deepEqual(items.map((i) => [i.level, i.numId]), [[0, 1], [1, 1], [0, 1], [0, 2], [0, 2], [0, 2]]);
  assert.equal(orderedLists, 1, 'a blank line inside a list does not restart it');
  const table = blocks.find((b) => b.t === 'table') as { rows: unknown[][] };
  assert.equal(table.rows.length, 3, 'header + 2 rows, separator dropped');
  assert.equal(blocks.filter((b) => b.t === 'code').length, 1);
  assert.equal(blocks.filter((b) => b.t === 'hr').length, 1);
  assert.equal(parseBlocks('1. a\n\n- b\n\n1. c').orderedLists, 2, 'a new numbered list starts at 1 again');
});

test('document.xml is well-formed and carries headings, lists, bold/italic, table and escaped text', () => {
  const xml = documentXml(SAMPLE);
  const doc = parseXml(xml);
  const styles = byTag(doc, 'pStyle').map((e) => e.getAttributeNS(W, 'val'));
  assert.ok(styles.includes('Heading1') && styles.includes('Heading2') && styles.includes('Heading3'));
  assert.equal(styles.filter((s) => s === 'Heading3').length, 2, '#### falls back to Heading3');
  assert.equal(byTag(doc, 'numPr').length, 6);
  assert.equal(byTag(doc, 'tbl').length, 1);
  assert.equal(byTag(doc, 'tr').length, 3);
  assert.ok(byTag(doc, 'b').length >= 3, 'bold run plus bold header cells');
  assert.ok(byTag(doc, 'i').length >= 1);
  const text = byTag(doc, 't').map((e) => e.textContent).join('|');
  assert.ok(text.includes('A & B') && text.includes('1 < 2') && text.includes('x = 1 < 2'));
  assert.ok(xml.includes('A &amp; B') && xml.includes('1 &lt; 2'));
  assert.ok(text.includes('接著第二行'));
});

test('control characters and an empty document still give valid XML', () => {
  assert.equal(escapeXml('a\u0001b&<>"'), 'ab&amp;&lt;&gt;&quot;');
  parseXml(documentXml('壞\u0000字元 \u000B 與 <script>'));
  const empty = parseXml(documentXml(''));
  assert.equal(byTag(empty, 'p').length, 1);
});

test('all required parts exist and are well-formed; numbering has one num per numbered list', () => {
  const parts = docxParts(SAMPLE);
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml']) {
    assert.ok(parts[name], name);
    parseXml(parts[name]);
  }
  assert.ok(parts['[Content_Types].xml'].includes('/word/numbering.xml'));
  assert.ok(parts['word/styles.xml'].includes('微軟正黑體'));
  for (const id of ['Heading1', 'Heading2', 'Heading3']) assert.ok(parts['word/styles.xml'].includes(`w:styleId="${id}"`));
  const numbering = parseXml(parts['word/numbering.xml']);
  assert.equal(byTag(numbering, 'num').length, 2, 'bullets + one numbered list');
  assert.equal(byTag(numbering, 'abstractNum').length, 2);
});

test('the zip has the parts, and document.xml comes back out intact', async () => {
  const bytes = await buildDocx(SAMPLE);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK');
  const zip = await JSZip.loadAsync(bytes);
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']) {
    assert.ok(zip.file(name), name);
  }
  const xml = await zip.file('word/document.xml')!.async('string');
  assert.equal(xml, documentXml(SAMPLE));
  parseXml(xml);
});

test('AI results: whole document, selection replace (even if the selection moved), and refusals', () => {
  const md = 'AAA BBB CCC';
  const sel = { from: 4, to: 7, text: 'BBB' };
  assert.equal(applyDocResult(md, sel, { replaceSelection: 'xx' }, false).markdown, 'AAA xx CCC');
  assert.equal(applyDocResult(`新增 ${md}`, sel, { replaceSelection: 'xx' }, false).markdown, '新增 AAA xx CCC');
  assert.throws(() => applyDocResult('changed', sel, { replaceSelection: 'xx' }, false), /改過/);
  assert.throws(() => applyDocResult(md, null, { replaceSelection: 'xx' }, false), /沒有選取/);
  assert.equal(applyDocResult(md, null, { markdown: '# 新' }, false).markdown, '# 新');
  assert.throws(() => applyDocResult(md, null, { markdown: '# 新' }, true), /太長/);
  assert.throws(() => applyDocResult(md, null, { other: 1 }, false));
});

test('AI context caps the document and the selection and flags it', () => {
  const ctx = docContext('t', 'x'.repeat(100_000), { from: 0, to: 30_000, text: 'y'.repeat(30_000) });
  assert.equal(ctx.markdown.length, 90_000);
  assert.equal(ctx.truncated, true);
  assert.equal(ctx.selection.length, 20_000);
  assert.equal(ctx.selectionTruncated, true);
  const small = docContext('t', 'hi', null);
  assert.deepEqual([small.truncated, small.selection, small.selectionTruncated], [false, '', false]);
});

test('stored docs are parsed defensively and the 開工 brief contains the document', () => {
  const data = parseDocsData({ docs: [{ id: 'a', title: '', markdown: 5 }, 'junk'], activeId: 'zzz' });
  assert.equal(data.docs.length, 1);
  assert.equal(data.docs[0].markdown, '');
  assert.equal(data.activeId, 'a');
  assert.equal(parseDocsData(undefined).docs.length, 1);
  const brief = docBrief('月報', '# 內容');
  assert.ok(brief.includes('# 內容') && brief.includes('月報'));
});

test('render: opens the saved document with its preview and export button', async () => {
  render(<DocEditor profileId="p1" profileName="同事A" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByRole('dialog', { name: '文件共編' })));
  await waitFor(() => assert.ok(screen.getByRole('heading', { name: '標題' })));
  assert.equal(document.querySelector('strong')?.textContent, '粗');
  assert.ok(screen.getByRole('button', { name: /匯出 Word/ }));
  assert.equal((screen.getByLabelText('選擇文件') as HTMLSelectElement).value, 'd1');
});

test('handoff: a document becomes slides and slides become a document', async () => {
  const { docToSlides, slidesToDoc } = await import('@/modules/tool-library/tools/handoffModel');
  const doc = '# 月報\n\n本月重點如下。其他略。\n\n## 風險\n\n部位偏高，需要調降。細節見附件。\n\n- 甲\n- 乙\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## 大表\n\n' + ['| x |', '|---|', ...Array.from({ length: 9 }, (_, i) => `| ${i} |`)].join('\n') + '\n';
  const slides = docToSlides(doc, '備用');
  assert.equal(slides.pages, 3);
  const parts = slides.markdown.split('\n\n---\n\n');
  assert.equal(parts[0], '# 月報\n\n本月重點如下。');
  assert.equal(parts[1], '## 風險\n\n- 部位偏高，需要調降。\n- 甲\n- 乙\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(parts[2], '## 大表');
  const many = docToSlides('## s\n\n' + Array.from({ length: 9 }, (_, i) => `- i${i}`).join('\n'), 't');
  assert.equal(many.markdown.split('\n').filter((l) => l.startsWith('- ')).length, 6);

  const back = slidesToDoc('簡報', '# 封面\n\n副標\n\n> 旁白：大家好\n\n---\n\n## 重點\n\n- 要點\n\n> 旁白：說明一下');
  assert.equal(back.title, '封面');
  assert.equal(back.markdown, '# 封面\n\n副標\n\n大家好\n\n## 重點\n\n- 要點\n\n說明一下');
});

test('handoff: markdown-insert on mount is appended to the open doc, undoable, with a note', async () => {
  const { sendToTool } = await import('@/shared/toolHandoff');
  cleanup();
  sendToTool({ tool: 'doc-editor', kind: 'markdown-insert', from: "試算工作台『部位』", payload: { markdown: '| a |\n| --- |\n| 1 |', title: '部位', summary: '放進表格（1 列）' } });
  render(<DocEditor profileId="p1" profileName="同事A" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByText(/已從 試算工作台『部位』放進表格（1 列）/)));
  await waitFor(() => assert.ok(document.querySelector('table')));
  assert.ok(screen.getByRole('heading', { name: '標題' }));
  assert.equal((screen.getByRole('button', { name: '復原 AI 修改' }) as HTMLButtonElement).disabled, false);
});

test('a doc that is only a title and a table still gets the table on a slide', async () => {
  const { docToSlides } = await import('@/modules/tool-library/tools/handoffModel');
  const slides = docToSlides('# tasks\n\n| 工作 | 狀態 |\n| --- | --- |\n| 抓部位 | 進行中 |\n', '備用');
  assert.equal(slides.pages, 2);
  assert.match(slides.markdown, /## tasks\n\n\| 工作 \| 狀態 \|/);
});
