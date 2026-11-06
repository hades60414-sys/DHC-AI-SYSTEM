import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

import { extractDocumentText, PDF_EXTRACTOR } from '../document-extraction.js';
import { extractionChildEnv, runIsolatedExtraction } from '../extraction-sandbox.js';
import { inspectZip, ZIP_LIMITS } from '../zip-reader.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/extraction');
const docXml = (text: string) => `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

async function docx(extra: (zip: JSZip) => void = () => undefined, text = '合成小段落') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', docXml(text));
  extra(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** 找出 central directory 中某 entry 的起點（測試用來偽造欄位）。 */
function centralEntryOffset(buffer: Buffer, name: string) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    let pointer = buffer.readUInt32LE(offset + 16);
    while (buffer.readUInt32LE(pointer) === 0x02014b50) {
      const nameLength = buffer.readUInt16LE(pointer + 28);
      if (buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString() === name) return pointer;
      pointer += 46 + nameLength + buffer.readUInt16LE(pointer + 30) + buffer.readUInt16LE(pointer + 32);
    }
  }
  throw new Error('entry not found');
}

const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: Error) => error.message === code, code);

describe('ASTRA-003 ZIP 資源放大：解壓前先驗整包，只解壓需要的 entry', () => {
  test('Astra 反例：小 document.xml＋24 MiB 無關 entry → 拒絕；主行程 RSS 幾乎不增加', async () => {
    const bytes = await docx(zip => zip.file('irrelevant.bin', Buffer.alloc(24 * 1024 * 1024, 65)));
    assert.ok(bytes.length < 64 * 1024, `fixture ${bytes.length} bytes`);
    const before = process.memoryUsage().rss;
    const started = Date.now();
    await rejects(extractDocumentText(DOCX, bytes), 'ENTERPRISE_EXTRACTION_TOO_LARGE');
    const growth = process.memoryUsage().rss - before;
    assert.ok(growth < 8 * 1024 * 1024, `parent RSS growth ${growth}`);
    assert.ok(Date.now() - started < 10_000);
    // 解壓前就能判斷：central directory 宣告 24 MiB > 單一 entry 上限
    assert.throws(() => inspectZip(bytes), /ENTERPRISE_EXTRACTION_TOO_LARGE/);
  });

  test('偽造宣告大小（宣告 100 bytes、實際 5 MiB）：maxOutputLength 擋下，不會解壓超過宣告', async () => {
    const bytes = await docx(() => undefined, 'A'.repeat(5 * 1024 * 1024));
    for (const offset of [centralEntryOffset(bytes, 'word/document.xml') + 24]) bytes.writeUInt32LE(100, offset);
    await rejects(extractDocumentText(DOCX, bytes), 'ENTERPRISE_EXTRACTION_TOO_LARGE');
  });

  test('entry 數、總宣告量、壓縮比例超過上限都拒絕', async () => {
    const many = await docx(zip => { for (let i = 0; i < ZIP_LIMITS.maxEntries; i += 1) zip.file(`x/${i}.txt`, 'x'); });
    await rejects(extractDocumentText(DOCX, many), 'ENTERPRISE_EXTRACTION_TOO_LARGE');
    const total = await docx(zip => { for (let i = 0; i < 4; i += 1) zip.file(`big${i}.bin`, Buffer.alloc(19 * 1024 * 1024, i)); });
    await rejects(extractDocumentText(DOCX, total), 'ENTERPRISE_EXTRACTION_TOO_LARGE');
    const ratio = await docx(zip => zip.file('zeros.bin', Buffer.alloc(4 * 1024 * 1024, 0)));
    await rejects(extractDocumentText(DOCX, ratio), 'ENTERPRISE_EXTRACTION_TOO_LARGE');
  });

  test('CRC 損毀、路徑穿越、加密旗標、截斷封包 → FAILED', async () => {
    const bytes = await docx();
    const crc = Buffer.from(bytes);
    crc.writeUInt32LE((crc.readUInt32LE(centralEntryOffset(crc, 'word/document.xml') + 16) ^ 1) >>> 0, centralEntryOffset(crc, 'word/document.xml') + 16);
    await rejects(extractDocumentText(DOCX, crc), 'ENTERPRISE_EXTRACTION_FAILED');
    const traversal = await docx(zip => zip.file('../evil.txt', 'x'));
    await rejects(extractDocumentText(DOCX, traversal), 'ENTERPRISE_EXTRACTION_FAILED');
    const encrypted = Buffer.from(bytes);
    const flags = centralEntryOffset(encrypted, 'word/document.xml') + 8;
    encrypted.writeUInt16LE(encrypted.readUInt16LE(flags) | 1, flags);
    await rejects(extractDocumentText(DOCX, encrypted), 'ENTERPRISE_EXTRACTION_FAILED');
    await rejects(extractDocumentText(DOCX, bytes.subarray(0, bytes.length - 30)), 'ENTERPRISE_EXTRACTION_FAILED');
  });

  test('正常 DOCX／XLSX golden：段落與儲存格參照正確', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>第一段 合成</w:t></w:r></w:p><w:p/><w:p><w:r><w:t xml:space="preserve">第三段 &amp; 符號</w:t></w:r><w:r><w:tab/><w:t>尾</w:t></w:r></w:p></w:body></w:document>');
    zip.file('irrelevant-small.bin', Buffer.alloc(512 * 1024, 7)); // 小於比例門檻的無關 entry 不會被解壓，也不會被拒
    const word = await extractDocumentText(DOCX, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    assert.equal(word.extractor, 'docx-ooxml@2');
    assert.deepEqual(word.units, [{ text: '第一段 合成', location: { kind: 'paragraph', paragraph: 1 } }, { text: '第三段 & 符號\t尾', location: { kind: 'paragraph', paragraph: 3 } }]);
    const book = new JSZip();
    book.file('xl/workbook.xml', '<workbook><sheets><sheet name="報價" sheetId="1" r:id="rId1"/></sheets></workbook>');
    book.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
    book.file('xl/sharedStrings.xml', '<sst><si><t>品項</t></si><si><t>金額</t></si></sst>');
    book.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>合成筆電</t></is></c><c r="B2"><v>32000</v></c></row></sheetData></worksheet>');
    const sheet = await extractDocumentText(XLSX, await book.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    assert.equal(sheet.extractor, 'xlsx-ooxml@2');
    assert.deepEqual(sheet.units.map(unit => unit.text), ['A1: 品項 | B1: 金額', 'A2: 合成筆電 | B2: 32000']);
    assert.deepEqual(sheet.units[1].location, { kind: 'row', sheet: '報價', row: 2 });
  });
});

describe('DEC-PDF-01 PDF 文字擷取（pdfjs-dist，隔離子行程）', () => {
  test('CJK 文字 PDF：逐頁逐行、保留頁碼', async () => {
    const result = await extractDocumentText('application/pdf', readFileSync(path.join(fixtures, 'text-cjk.pdf')));
    assert.equal(result.extractor, PDF_EXTRACTOR);
    assert.deepEqual(result.units.map(unit => unit.text), ['合成甲公司 採購合約', '交付期限 2026/12/20', 'Total amount 1,250,000']);
    assert.deepEqual(result.units[1].location, { kind: 'page', page: 1, line: 2 });
  });

  test('多頁 PDF：頁碼正確；康熙部首正規化（⾴→頁）', async () => {
    const result = await extractDocumentText('application/pdf', readFileSync(path.join(fixtures, 'multipage.pdf')));
    const firstOfPage3 = result.units.find(unit => unit.text.startsWith('第 3 頁'));
    assert.ok(firstOfPage3, '第 3 頁標題存在且為正規「頁」字');
    assert.ok(Number(firstOfPage3!.location.page) >= 3);
    assert.ok(!result.units.some(unit => unit.text.includes('⾴')));
    const pages = new Set(result.units.map(unit => unit.location.page));
    assert.ok(pages.size >= 3);
  });

  test('沒有文字層（掃描影像）PDF：明確 NO_TEXT_LAYER（不做 OCR）；截斷 PDF：FAILED', async () => {
    await rejects(extractDocumentText('application/pdf', readFileSync(path.join(fixtures, 'image-only.pdf'))), 'ENTERPRISE_EXTRACTION_NO_TEXT_LAYER');
    await rejects(extractDocumentText('application/pdf', readFileSync(path.join(fixtures, 'truncated.pdf'))), 'ENTERPRISE_EXTRACTION_FAILED');
    await rejects(extractDocumentText('application/pdf', Buffer.from('%PDF-1.7\nnot really')), 'ENTERPRISE_EXTRACTION_FAILED');
  });
});

describe('隔離子行程', () => {
  test('逾時：SIGKILL 子行程，回 TIMEOUT，主行程不受影響', async () => {
    await rejects(extractDocumentText('application/pdf', readFileSync(path.join(fixtures, 'text-cjk.pdf')), { timeoutMs: 1 }), 'ENTERPRISE_EXTRACTION_TIMEOUT');
    assert.equal((await extractDocumentText(DOCX, await docx())).units.length, 1, '之後仍可正常擷取');
  });

  test('子行程記憶體耗盡（heap 上限極小）：只這次失敗，主行程存活', async () => {
    await rejects(extractDocumentText('application/pdf', readFileSync(path.join(fixtures, 'multipage.pdf')), { heapMb: 4 }), 'ENTERPRISE_EXTRACTION_FAILED');
    assert.equal((await extractDocumentText(DOCX, await docx())).units.length, 1);
  });

  test('OCR 審查：子行程無法啟動（spawn 失敗）時立即回 FAILED，不懸置、不占住並行名額', async () => {
    for (let i = 0; i < 3; i += 1) {
      await rejects(runIsolatedExtraction(DOCX, await docx(), { execPath: '/nonexistent/node-binary', timeoutMs: 60_000 }), 'ENTERPRISE_EXTRACTION_FAILED');
    }
    assert.equal((await extractDocumentText(DOCX, await docx())).units.length, 1, '名額已釋放，之後仍可擷取');
  });

  test('子行程不繼承任何環境變數（秘密不會進入解析不可信內容的行程）', () => {
    process.env.ENTERPRISE_SECRET_KEY_TEST_PROBE = 'synthetic';
    try {
      assert.deepEqual(extractionChildEnv(), {});
    } finally {
      delete process.env.ENTERPRISE_SECRET_KEY_TEST_PROBE;
    }
  });

  test('並行 6 個擷取（上限 2 個子行程同時跑）全部正確完成', async () => {
    const bytes = await docx();
    const results = await Promise.all(Array.from({ length: 6 }, () => extractDocumentText(DOCX, bytes)));
    assert.ok(results.every(result => result.units[0].text === '合成小段落'));
  });
});
