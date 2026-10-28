import assert from 'node:assert/strict';

import JSZip from 'jszip';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as CustomToolsModule from '@/shared/customTools';

import { readDocxAsMarkdown, readPptxAsMarkdown, readSpreadsheetFile, readTextFile } from '@/modules/tool-library/importers';

vi.mock('@/shared/customTools', async (importOriginal) => ({
  ...(await importOriginal<typeof CustomToolsModule>()),
  loadToolData: async (tool: string) => {
    if (tool === 'doc-editor') return { docs: [{ id: 'd1', title: '空白', markdown: '' }], activeId: 'd1' };
    if (tool === 'deck-studio') return { decks: [{ id: 'k1', name: '舊簡報', markdown: '# 舊', chat: [] }], activeId: 'k1' };
    return null;
  },
  createToolSaver: () => ({ save: () => {}, flush: async () => {} }),
}));

const { default: SheetBench } = await import('@/modules/tool-library/tools/SheetBench');
const { default: DocEditor } = await import('@/modules/tool-library/tools/DocEditor');
const { default: DeckStudio } = await import('@/modules/tool-library/tools/DeckStudio');

Element.prototype.scrollIntoView = () => {};
// jsdom has no layout; CodeMirror measures ranges.
Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
afterEach(cleanup);

/** DHC CLI 10/14 工具庫匯入: real small files built in the test (xlsx / docx / pptx are zips of XML), plus CSV encodings. */

const zipFile = async (name: string, parts: Record<string, string>) => {
  const zip = new JSZip();
  for (const [path, xml] of Object.entries(parts)) zip.file(path, xml);
  return new File([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))], name);
};
const bytesFile = (name: string, bytes: number[]) => new File([new Uint8Array(bytes)], name);

const NS_MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

test('text files: UTF-8, UTF-8 BOM, UTF-16LE BOM and Big5 all decode', async () => {
  assert.equal(await readTextFile(new File(['代號,名稱\n2330,台積電'], 'a.csv')), '代號,名稱\n2330,台積電');
  assert.equal(await readTextFile(bytesFile('b.csv', [0xef, 0xbb, 0xbf, 0x41, 0x2c, 0xe4, 0xbb, 0xa3])), 'A,代');
  assert.equal(await readTextFile(bytesFile('c.csv', [0xff, 0xfe, 0x41, 0x00, 0x23, 0x4e])), 'A丣');
  // 代號 in Big5, then ,1
  assert.equal(await readTextFile(bytesFile('d.csv', [0xa5, 0x4e, 0xb8, 0xb9, 0x2c, 0x31])), '代號,1');
});

test('csv: Big5 file is read as rows; tab files are sniffed; quoted commas survive', async () => {
  const big5 = await readSpreadsheetFile(bytesFile('部位.csv', [0xa5, 0x4e, 0xb8, 0xb9, 0x2c, 0x41, 0x0d, 0x0a, 0x31, 0x2c, 0x32, 0x0d, 0x0a]));
  assert.deepEqual(big5, [{ name: '部位', rows: [['代號', 'A'], ['1', '2']] }]);
  const bom = await readSpreadsheetFile(bytesFile('x.csv', [0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62, 0x0a, 0x31, 0x2c, 0x32]));
  assert.deepEqual(bom[0].rows, [['a', 'b'], ['1', '2']]);
  const tsv = await readSpreadsheetFile(new File(['a\tb,c\n1\t2'], 't.txt'));
  assert.deepEqual(tsv[0].rows, [['a', 'b,c'], ['1', '2']]);
  const quoted = await readSpreadsheetFile(new File(['n,v\n"x,y",3\n'], 'q.csv'));
  assert.deepEqual(quoted[0].rows, [['n', 'v'], ['x,y', '3']]);
});

test('xls and oversized files are refused with a clear message', async () => {
  await assert.rejects(readSpreadsheetFile(new File(['x'], 'old.xls')), /另存成 \.xlsx 或 CSV/);
  const big = new File(['x'], 'big.csv');
  Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
  await assert.rejects(readSpreadsheetFile(big), /20 MB/);
  await assert.rejects(readDocxAsMarkdown(big), /20 MB/);
});

test('xlsx: shared + rich text + inline strings, exact decimals, dates, booleans, gaps and several sheets', async () => {
  const file = await zipFile('部位.xlsx', {
    'xl/workbook.xml': `<workbook ${NS_MAIN}><sheets><sheet name="明細" sheetId="1" r:id="rId1"/><sheet name="第二張" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst ${NS_MAIN}><si><t>代號</t></si><si><r><t>台積</t></r><r><rPr><b/></rPr><t>電</t></r></si><si><t>日期</t></si><si><t>價格</t></si><si><t>比率</t></si></sst>`,
    'xl/styles.xml': `<styleSheet ${NS_MAIN}><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/></numFmts>`
      + '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<worksheet ${NS_MAIN}><sheetData>`
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"><v>45000</v></c><c r="D2"><v>1035.5</v></c><c r="E2"><v>0.1</v></c></row>'
      + '<row r="4"><c r="A4" t="inlineStr"><is><t>內嵌</t></is></c><c r="B4" s="2"><v>60</v></c><c r="C4" t="b"><v>1</v></c><c r="D4" s="2"><v>61</v></c><c r="E4" t="str"><v>x</v></c></row>'
      + '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': `<worksheet ${NS_MAIN}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>only</t></is></c></row></sheetData></worksheet>`,
  });
  const sheets = await readSpreadsheetFile(file);
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].name, '明細');
  assert.deepEqual(sheets[0].rows, [
    ['代號', '日期', '', '價格', '比率'],
    ['台積電', '2023-03-15', '', '1035.5', '0.1'],
    ['', '', '', '', ''],
    ['內嵌', '1900-02-28', 'TRUE', '1900-03-01', 'x'],
  ]);
  assert.deepEqual(sheets[1], { name: '第二張', rows: [['only']] });
});

test('docx: Title / 標題 style becomes a # heading, Subtitle / 副標題 a plain paragraph right after it', async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = (title: string, sub: string) => `<w:document ${W}><w:body>`
    + `<w:p><w:pPr><w:pStyle w:val="${title}"/></w:pPr><w:r><w:t>年度報告</w:t></w:r></w:p>`
    + `<w:p><w:pPr><w:pStyle w:val="${sub}"/></w:pPr><w:r><w:t>風控部</w:t></w:r></w:p>`
    + '<w:p><w:r><w:t>內文</w:t></w:r></w:p></w:body></w:document>';
  const byId = await zipFile('a.docx', { 'word/document.xml': doc('Title', 'Subtitle') });
  assert.equal(await readDocxAsMarkdown(byId), '# 年度報告\n\n風控部\n\n內文');
  const byName = await zipFile('b.docx', {
    'word/styles.xml': `<w:styles ${W}><w:style w:styleId="a3"><w:name w:val="標題"/></w:style><w:style w:styleId="a4"><w:name w:val="副標題"/></w:style></w:styles>`,
    'word/document.xml': doc('a3', 'a4'),
  });
  assert.equal(await readDocxAsMarkdown(byName), '# 年度報告\n\n風控部\n\n內文');
});

test('docx: headings, bullets, numbers, bold/italic, table, line break and image note', async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const file = await zipFile('sop.docx', {
    'word/styles.xml': `<w:styles ${W}><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="a9"><w:name w:val="標題 2"/></w:style></w:styles>`,
    'word/numbering.xml': `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>`
      + '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>'
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>',
    'word/document.xml': `<w:document ${W}><w:body>`
      + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>月報</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:pStyle w:val="a9"/></w:pPr><w:r><w:t>背景</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t xml:space="preserve">這是 </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>重點</w:t></w:r><w:r><w:t xml:space="preserve"> 與 </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>斜體</w:t></w:r><w:r><w:br/><w:t>換行</w:t></w:r></w:p>'
      + '<w:p/>'
      + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>甲</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>甲一</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>步驟一</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>步驟二</w:t></w:r></w:p>'
      + '<w:p><w:r><w:drawing/></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>欄A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>欄B</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>x|y</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      + '</w:body></w:document>',
  });
  assert.equal(await readDocxAsMarkdown(file), [
    '# 月報',
    '',
    '## 背景',
    '',
    '這是 **重點** 與 *斜體*  ',
    '換行',
    '',
    '- 甲',
    '  - 甲一',
    '1. 步驟一',
    '1. 步驟二',
    '',
    '（圖片未匯入）',
    '',
    '| 欄A | 欄B |',
    '| --- | --- |',
    '| **1** | x\\|y |',
  ].join('\n'));
});

test('pptx: slide order, title as heading, bullets with levels, notes as narration, joined with ---', async () => {
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
  const title = (text: string, type = 'title') => `<p:sp><p:nvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const slide = (inner: string) => `<p:sld ${P}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;
  const file = await zipFile('deck.pptx', {
    // slide2 comes first in the list although slide1.xml is its file name
    'ppt/presentation.xml': `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships ${RELS}><Relationship Id="rId1" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="x/slide" Target="slides/slide2.xml"/></Relationships>`,
    'ppt/slides/slide2.xml': slide(title('封面', 'ctrTitle') + title('2026 年報告', 'subTitle')),
    'ppt/slides/slide1.xml': slide(
      title('重點')
      + '<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>要點一</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>細項</a:t></a:r></a:p></p:txBody></p:sp>'
      + title('3', 'sldNum'),
    ),
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships ${RELS}><Relationship Id="rId1" Type="http://x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    'ppt/notesSlides/notesSlide1.xml': `<p:notes ${P}><p:cSld><p:spTree>${title('旁白第一句', 'body')}${title('1', 'sldNum')}</p:spTree></p:cSld></p:notes>`,
  });
  assert.equal(await readPptxAsMarkdown(file), '# 封面\n\n- 2026 年報告\n\n---\n\n## 重點\n\n- 要點一\n  - 細項\n\n> 旁白：旁白第一句');
});

const importInto = async (file: File) => {
  const input = await waitFor(() => screen.getByTestId('tool-import-input'));
  fireEvent.change(input, { target: { files: [file] } });
};

test('SheetBench: importing a CSV becomes the sheet with its columns', async () => {
  render(React.createElement(SheetBench, { profileId: 'p1', profileName: '同事A', isMobile: false, onClose: () => {}, onStartWork: null }));
  await importInto(new File(['代號,數量\nA,1\nB,2'], '部位.csv'));
  await waitFor(() => assert.ok(screen.getAllByText('2 列 × 2 欄').length > 0));
  assert.ok(screen.getByRole('button', { name: /^代號/ }));
  assert.ok(screen.getByText(/已匯入 部位\.csv：2 列 × 2 欄/));
});

test('DocEditor: importing a Markdown file fills the empty document and takes its title', async () => {
  render(React.createElement(DocEditor, { profileId: 'p1', profileName: '同事A', isMobile: false, onClose: () => {}, onStartWork: null }));
  await importInto(new File(['# 你好\n\n內容'], '會議紀錄.md'));
  await waitFor(() => assert.ok(screen.getByRole('heading', { name: '你好' })));
  assert.equal((screen.getByLabelText('選擇文件') as HTMLSelectElement).selectedOptions[0].textContent, '會議紀錄');
});

test('DeckStudio: importing a Markdown file creates a new deck', async () => {
  render(React.createElement(DeckStudio, { profileId: 'p1', profileName: '同事A', isMobile: false, onClose: () => {}, onStartWork: null }));
  await importInto(new File(['# 新簡報\n\n---\n\n## 第二頁'], '季報.md'));
  await waitFor(() => assert.ok(screen.getByText('1 / 2')));
  assert.equal((screen.getByLabelText('我的簡報') as HTMLSelectElement).selectedOptions[0].textContent, '季報');
});
