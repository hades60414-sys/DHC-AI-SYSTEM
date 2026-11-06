import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import JSZip from 'jszip';

import { chunkUnits, extractDocumentText } from '../document-extraction.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 合成 DOCX：真正可由 Word 開啟的最小結構（Content_Types＋document.xml）。 */
async function syntheticDocx(paragraphs: string[]) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const body = paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function syntheticXlsx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="對帳" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/sharedStrings.xml', '<sst><si><t>客戶</t></si><si><t>合成甲公司</t></si><si><r><t>金</t></r><r><t>額</t></r></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1200</v></c><c r="C2" t="inlineStr"><is><t>已核對 &amp; 結案</t></is></c></row>'
    + '</sheetData></worksheet>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('extractDocumentText', () => {
  test('純文字逐行擷取並記錄行號；空行略過', async () => {
    const result = await extractDocumentText('text/plain', Buffer.from('第一行\n\n第三行\r\n'));
    assert.equal(result.extractor, 'text-utf8@1');
    assert.deepEqual(result.units, [
      { text: '第一行', location: { kind: 'line', line: 1 } },
      { text: '第三行', location: { kind: 'line', line: 3 } },
    ]);
  });

  test('CSV 逐列擷取', async () => {
    const result = await extractDocumentText('text/csv', Buffer.from('欄1,欄2\n1,2\n'));
    assert.deepEqual(result.units.map(unit => unit.location), [{ kind: 'row', row: 1 }, { kind: 'row', row: 2 }]);
  });

  test('DOCX 逐段落擷取、解 XML entity、段落編號', async () => {
    const result = await extractDocumentText(DOCX, await syntheticDocx(['會議日期 11/5', 'A &amp; B 決議', '']));
    assert.equal(result.extractor, 'docx-ooxml@2');
    assert.deepEqual(result.units, [
      { text: '會議日期 11/5', location: { kind: 'paragraph', paragraph: 1 } },
      { text: 'A & B 決議', location: { kind: 'paragraph', paragraph: 2 } },
    ]);
  });

  test('XLSX 逐列擷取：工作表名稱、儲存格參照、shared/inline 字串與數值', async () => {
    const result = await extractDocumentText(XLSX, await syntheticXlsx());
    assert.equal(result.extractor, 'xlsx-ooxml@2');
    assert.deepEqual(result.units, [
      { text: 'A1: 客戶 | B1: 金額', location: { kind: 'row', sheet: '對帳', row: 1 } },
      { text: 'A2: 合成甲公司 | B2: 1200 | C2: 已核對 & 結案', location: { kind: 'row', sheet: '對帳', row: 2 } },
    ]);
  });

  test('圖片明確回 UNSUPPORTED（不做 OCR）；只有檔頭的假 PDF 回 FAILED（DEC-PDF-01 後 PDF 已支援，見 document-extraction-isolation.test）', async () => {
    for (const type of ['image/png', 'image/jpeg']) {
      await assert.rejects(extractDocumentText(type, Buffer.from('%PDF-1.7')), /ENTERPRISE_EXTRACTION_UNSUPPORTED/);
    }
    await assert.rejects(extractDocumentText('application/pdf', Buffer.from('%PDF-1.7')), /ENTERPRISE_EXTRACTION_FAILED/);
  });

  test('壞掉的 DOCX、缺 document.xml：EXTRACTION_FAILED；超過解壓上限：EXTRACTION_TOO_LARGE（ASTRA-003 更精確的代碼，服務層同樣記為 failed）', async () => {
    await assert.rejects(extractDocumentText(DOCX, Buffer.from('PK\u0003\u0004 broken')), /ENTERPRISE_EXTRACTION_FAILED/);
    const empty = new JSZip();
    empty.file('[Content_Types].xml', '<Types/>');
    await assert.rejects(extractDocumentText(DOCX, await empty.generateAsync({ type: 'nodebuffer' })), /ENTERPRISE_EXTRACTION_FAILED/);
    const bomb = new JSZip();
    bomb.file('[Content_Types].xml', '<Types/>');
    bomb.file('word/document.xml', '<w:document>' + 'a'.repeat(21 * 1024 * 1024) + '</w:document>');
    await assert.rejects(extractDocumentText(DOCX, await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), /ENTERPRISE_EXTRACTION_TOO_LARGE/);
  });
});

describe('chunkUnits', () => {
  test('合併相鄰單位至上限、保留位置範圍；長單位切開', () => {
    const units = [
      { text: 'a'.repeat(300), location: { kind: 'line', line: 1 } },
      { text: 'b'.repeat(300), location: { kind: 'line', line: 2 } },
      { text: 'c'.repeat(300), location: { kind: 'line', line: 3 } },
      { text: 'd'.repeat(2500), location: { kind: 'line', line: 4 } },
    ];
    const chunks = chunkUnits(units, 800);
    assert.deepEqual(chunks.map(chunk => chunk.location), [
      { kind: 'line', from: { kind: 'line', line: 1 }, to: { kind: 'line', line: 2 } },
      { kind: 'line', from: { kind: 'line', line: 3 }, to: { kind: 'line', line: 3 } },
      { kind: 'line', from: { kind: 'line', line: 4 }, to: { kind: 'line', line: 4 }, part: 1 },
      { kind: 'line', from: { kind: 'line', line: 4 }, to: { kind: 'line', line: 4 }, part: 2 },
      { kind: 'line', from: { kind: 'line', line: 4 }, to: { kind: 'line', line: 4 }, part: 3 },
      { kind: 'line', from: { kind: 'line', line: 4 }, to: { kind: 'line', line: 4 }, part: 4 },
    ]);
    assert.ok(chunks.every(chunk => chunk.text.length <= 800));
    assert.equal(chunks.map(chunk => chunk.text).join('').replace(/\n/g, ''), units.map(unit => unit.text).join(''));
  });

  test('超過 5000 個 chunk 時拒絕', () => {
    const units = Array.from({ length: 5001 }, (_, i) => ({ text: 'x'.repeat(799), location: { kind: 'line', line: i + 1 } }));
    assert.throws(() => chunkUnits(units, 800), /ENTERPRISE_EXTRACTION_TOO_LARGE/);
  });
});
