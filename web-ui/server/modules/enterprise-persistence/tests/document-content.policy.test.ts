import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { inspectDocumentContent } from '../document-content.policy.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 只為型別判讀產生的合成 ZIP local header；不是可開啟的 Office 檔。 */
function syntheticZip(names: string[]) {
  return Buffer.concat(names.map(name => {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(Buffer.byteLength(name), 26);
    return Buffer.concat([header, Buffer.from(name), Buffer.from('synthetic')]);
  }));
}

const sha = (content: Buffer) => createHash('sha256').update(content).digest('hex');

describe('inspectDocumentContent（伺服器端內容政策）', () => {
  test('伺服器自行計算 SHA-256 與大小，回傳正規化 metadata', () => {
    const content = Buffer.from('合成會議紀錄\n第二行\n');
    const result = inspectDocumentContent({ filename: ' 會議紀錄.txt ', mediaType: 'text/plain', content });
    assert.deepEqual(result, { filename: '會議紀錄.txt', mediaType: 'text/plain', byteSize: content.length, sha256: sha(content) });
  });

  test('接受特徵一致的 PDF、DOCX、XLSX、PNG、JPEG、Markdown、CSV', () => {
    const cases: Array<[string, string, Buffer]> = [
      ['a.pdf', 'application/pdf', Buffer.from('%PDF-1.7\nsynthetic')],
      ['a.docx', DOCX, syntheticZip(['[Content_Types].xml', 'word/document.xml'])],
      ['a.xlsx', XLSX, syntheticZip(['[Content_Types].xml', 'xl/workbook.xml'])],
      ['a.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])],
      ['a.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])],
      ['a.md', 'text/markdown', Buffer.from('# 標題')],
      ['a.csv', 'text/csv', Buffer.from('欄1,欄2\n1,2\n')],
    ];
    for (const [filename, mediaType, content] of cases) {
      assert.equal(inspectDocumentContent({ filename, mediaType, content }).mediaType, mediaType, filename);
    }
  });

  test('宣告型別與檔頭不符一律拒絕（含 DOCX/XLSX 互換、偽裝成 PDF 的文字）', () => {
    const cases: Array<[string, Buffer]> = [
      ['application/pdf', Buffer.from('not a pdf')],
      [DOCX, syntheticZip(['[Content_Types].xml', 'xl/workbook.xml'])],
      [XLSX, syntheticZip(['[Content_Types].xml', 'word/document.xml'])],
      [DOCX, syntheticZip(['word/document.xml'])],
      ['image/png', Buffer.from('%PDF-1.7')],
      ['text/plain', Buffer.from([0xff, 0xfe, 0x00, 0x41])],
      ['text/plain', Buffer.from('a\u0000b')],
    ];
    for (const [mediaType, content] of cases) {
      assert.throws(() => inspectDocumentContent({ filename: 'x.bin', mediaType, content }), /ENTERPRISE_DOCUMENT_TYPE_MISMATCH/, mediaType);
    }
  });

  test('allowlist 外的型別拒絕（HTML、SVG、可執行檔）', () => {
    for (const mediaType of ['text/html', 'image/svg+xml', 'application/x-msdownload', 'application/octet-stream', '']) {
      assert.throws(() => inspectDocumentContent({ filename: 'x', mediaType, content: Buffer.from('x') }), /ENTERPRISE_DOCUMENT_TYPE_NOT_ALLOWED/);
    }
  });

  test('空檔與超過上限拒絕；上限可由伺服器設定但不可超過硬上限', () => {
    assert.throws(() => inspectDocumentContent({ filename: 'a.txt', mediaType: 'text/plain', content: Buffer.alloc(0) }), /ENTERPRISE_DOCUMENT_EMPTY/);
    assert.throws(() => inspectDocumentContent({ filename: 'a.txt', mediaType: 'text/plain', content: Buffer.from('12345') }, { maxBytes: 4 }), /ENTERPRISE_DOCUMENT_TOO_LARGE/);
    assert.throws(() => inspectDocumentContent({ filename: 'a.txt', mediaType: 'text/plain', content: Buffer.from('1') }, { maxBytes: 0 }), /ENTERPRISE_DOCUMENT_INVALID_LIMIT/);
    assert.throws(() => inspectDocumentContent({ filename: 'a.txt', mediaType: 'text/plain', content: Buffer.from('1') }, { maxBytes: 1024 ** 4 }), /ENTERPRISE_DOCUMENT_INVALID_LIMIT/);
  });

  test('檔名不得含路徑、控制字元、保留名稱或過長', () => {
    for (const filename of ['../a.txt', 'a/b.txt', 'a\\b.txt', 'a\u0000.txt', 'a\n.txt', '.', '..', '', '   ', 'x'.repeat(256)]) {
      assert.throws(() => inspectDocumentContent({ filename, mediaType: 'text/plain', content: Buffer.from('a') }), /ENTERPRISE_DOCUMENT_INVALID_FILENAME/, JSON.stringify(filename));
    }
  });

  test('呼叫端提供的 expectedSha256 只作比對，不符拒絕、格式錯拒絕', () => {
    const content = Buffer.from('合成');
    assert.equal(inspectDocumentContent({ filename: 'a.txt', mediaType: 'text/plain', content, expectedSha256: sha(content).toUpperCase() }).sha256, sha(content));
    assert.throws(() => inspectDocumentContent({ filename: 'a.txt', mediaType: 'text/plain', content, expectedSha256: '0'.repeat(64) }), /ENTERPRISE_DOCUMENT_HASH_MISMATCH/);
    assert.throws(() => inspectDocumentContent({ filename: 'a.txt', mediaType: 'text/plain', content, expectedSha256: 'abc' }), /ENTERPRISE_DOCUMENT_HASH_MISMATCH/);
  });

  test('非 Buffer 內容拒絕', () => {
    assert.throws(() => inspectDocumentContent({ filename: 'a.txt', mediaType: 'text/plain', content: 'text' as unknown as Buffer }), /ENTERPRISE_DOCUMENT_EMPTY/);
  });
});
