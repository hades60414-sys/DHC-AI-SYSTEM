import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import express from 'express';
import JSZip from 'jszip';
import { Pool } from 'pg';

import { bootstrapEnterpriseOrganization, createLocalDocumentBlobStore, runEnterpriseMigrations } from '@/modules/enterprise-persistence/index.js';

import { createEnterpriseRouter } from '../enterprise.routes.js';

const database = process.env.E02A_TEST_DATABASE;
const PASSWORD = 'Synthetic-only-Passw0rd!';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function docx(paragraphs: string[]) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<w:document><w:body>${paragraphs.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
async function xlsx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="應收" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="7"><c r="A7" t="inlineStr"><is><t>合成乙客戶 逾期帳款</t></is></c><c r="B7"><v>35000</v></c></row></sheetData></worksheet>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// DOC-02：擷取／切塊／檢索／引用，從 HTTP 驗證（真 PostgreSQL、合成文件）。
describe('DOC-02 文件擷取與檢索引用（實際 PostgreSQL，合成資料）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 6 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  let server: http.Server;
  let base = '';
  let blobRoot = '';
  let tokenA = '';
  let tokenB = '';

  async function call(method: string, route: string, token: string, options: { body?: Buffer; headers?: Record<string, string> } = {}) {
    const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) }, body: options.body });
    return { status: response.status, data: await response.json() as any };
  }
  const upload = (token: string, title: string, body: Buffer, type: string, filename: string) => call('POST', '/api/enterprise/v1/documents', token, {
    body, headers: { 'content-type': type, 'x-dhc-title': encodeURIComponent(title), 'x-dhc-filename': encodeURIComponent(filename) } });
  const search = (token: string, q: string, extra = '') => call('GET', `/api/enterprise/v1/documents/search?q=${encodeURIComponent(q)}${extra}`, token);

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    for (const slug of ['alpha', 'beta']) {
      await bootstrapEnterpriseOrganization(migrator, { slug, name: slug, adminEmail: `admin@${slug}.example.invalid`, adminPassword: PASSWORD });
    }
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-doc02-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: runtime, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024 }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = async (slug: string) => (await (await fetch(base + '/api/enterprise/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationSlug: slug, email: `admin@${slug}.example.invalid`, password: PASSWORD }) })).json() as any).token;
    tokenA = await login('alpha');
    tokenB = await login('beta');
  });
  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('上傳即擷取：DOCX、XLSX、文字層 PDF succeeded；掃描 PDF 明確 unsupported（NO_TEXT_LAYER）；假 PDF failed', async () => {
    const word = await upload(tokenA, '董事會紀錄', await docx(['第一案 通過年度預算', '第二案 合成甲專案延期']), DOCX, '紀錄.docx');
    assert.equal(word.status, 201);
    assert.equal(word.data.extraction.status, 'succeeded');
    assert.equal(word.data.extraction.extractor, 'docx-ooxml@2');
    const sheet = await upload(tokenA, '應收帳款', await xlsx(), XLSX, '應收.xlsx');
    assert.equal(sheet.data.extraction.status, 'succeeded');
    // DEC-PDF-01：pdfjs-dist 隔離子行程擷取文字層，保留頁碼
    const fixtures = path.resolve('server/modules/enterprise-persistence/tests/fixtures/extraction');
    const pdf = await upload(tokenA, '採購合約', await readFile(path.join(fixtures, 'text-cjk.pdf')), 'application/pdf', 'contract.pdf');
    assert.equal(pdf.status, 201);
    assert.deepEqual([pdf.data.extraction.status, pdf.data.extraction.extractor], ['succeeded', 'pdf-pdfjs-6-4-299@1']);
    const pdfHit = (await search(tokenA, '採購合約')).data.items[0];
    assert.equal(pdfHit.citation.documentId, pdf.data.document.id);
    assert.equal(pdfHit.citation.location.from.page, 1);
    const scan = await upload(tokenA, '掃描檔', await readFile(path.join(fixtures, 'image-only.pdf')), 'application/pdf', 'scan.pdf');
    assert.deepEqual([scan.data.extraction.status, scan.data.extraction.errorCode, scan.data.extraction.chunkCount], ['unsupported', 'ENTERPRISE_EXTRACTION_NO_TEXT_LAYER', 0]);
    const fake = await upload(tokenA, '假檔', Buffer.from('%PDF-1.7 synthetic'), 'application/pdf', 'fake.pdf');
    assert.deepEqual([fake.data.extraction.status, fake.data.extraction.errorCode, fake.data.extraction.chunkCount], ['failed', 'ENTERPRISE_EXTRACTION_FAILED', 0]);
  });

  test('檢索回傳可驗證引用：文件、版本、位置、hash；引用端點重算 hash', async () => {
    const result = await search(tokenA, '延期');
    assert.equal(result.status, 200);
    assert.equal(result.data.items.length, 1);
    const hit = result.data.items[0];
    assert.match(hit.excerpt, /合成甲專案延期/);
    assert.equal(hit.citation.title, '董事會紀錄');
    assert.equal(hit.citation.versionNumber, 1);
    assert.deepEqual(hit.citation.location, { kind: 'paragraph', from: { kind: 'paragraph', paragraph: 1 }, to: { kind: 'paragraph', paragraph: 2 } });
    const cell = (await search(tokenA, '逾期帳款')).data.items[0];
    assert.deepEqual(cell.citation.location.from, { kind: 'row', sheet: '應收', row: 7 });
    const citation = await call('GET', `/api/enterprise/v1/citations/${hit.citation.chunkId}`, tokenA);
    assert.equal(citation.status, 200);
    assert.equal(citation.data.verified, true);
    assert.equal(citation.data.text, hit.excerpt);
  });

  test('多詞為 AND；預設只查最新版本，history=true 才含舊版', async () => {
    assert.equal((await search(tokenA, '第一案 延期')).data.items.length, 1);
    assert.equal((await search(tokenA, '第一案 不存在的詞')).data.items.length, 0);
    const created = await upload(tokenA, '合約', Buffer.from('舊條款：違約金 5%'), 'text/plain', 'c.txt');
    const id = created.data.document.id;
    const v2 = await call('POST', `/api/enterprise/v1/documents/${id}/versions`, tokenA, {
      body: Buffer.from('新條款：違約金 3%'), headers: { 'content-type': 'text/plain', 'x-dhc-filename': 'c2.txt', 'if-match': '1' } });
    assert.equal(v2.data.extraction.status, 'succeeded');
    const latest = (await search(tokenA, '違約金')).data.items;
    assert.deepEqual(latest.map((item: any) => item.citation.versionNumber), [2]);
    const history = (await search(tokenA, '違約金', '&history=true')).data.items;
    assert.deepEqual(history.map((item: any) => item.citation.versionNumber).sort(), [1, 2]);
  });

  test('跨組織：B 搜不到 A 的內容，引用與擷取端點 404', async () => {
    assert.deepEqual((await search(tokenB, '延期')).data.items, []);
    const hit = (await search(tokenA, '延期')).data.items[0];
    assert.equal((await call('GET', `/api/enterprise/v1/citations/${hit.citation.chunkId}`, tokenB)).status, 404);
    assert.equal((await call('POST', `/api/enterprise/v1/documents/${hit.citation.documentId}/versions/1/ingestions`, tokenB)).status, 404);
  });

  test('擷取冪等；壞檔記為 failed 並可重試；竄改 chunk 後引用 verified=false', async () => {
    const hit = (await search(tokenA, '延期')).data.items[0];
    const again = await call('POST', `/api/enterprise/v1/documents/${hit.citation.documentId}/versions/1/ingestions`, tokenA);
    assert.equal(again.status, 200);
    assert.equal(again.data.reused, true);
    // 通過內容政策檢頭（ZIP 簽章與必要檔名）但內容損壞的 DOCX
    const header = (name: string) => { const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(Buffer.byteLength(name), 26); return Buffer.concat([h, Buffer.from(name)]); };
    const broken = Buffer.concat([header('[Content_Types].xml'), header('word/document.xml'), Buffer.from('corrupt')]);
    const bad = await upload(tokenA, '壞檔', broken, DOCX, 'bad.docx');
    assert.equal(bad.status, 201);
    assert.deepEqual([bad.data.extraction.status, bad.data.extraction.errorCode, bad.data.extraction.attempt], ['failed', 'ENTERPRISE_EXTRACTION_FAILED', 1]);
    const retry = await call('POST', `/api/enterprise/v1/documents/${bad.data.document.id}/versions/1/ingestions`, tokenA);
    assert.equal(retry.status, 201);
    assert.equal(retry.data.extraction.attempt, 2);
    await admin.query("UPDATE enterprise.document_chunks SET text = text || ' 竄改' WHERE id=$1", [hit.citation.chunkId]);
    assert.equal((await call('GET', `/api/enterprise/v1/citations/${hit.citation.chunkId}`, tokenA)).data.verified, false);
  });

  test('查詢驗證與 runtime 權限：空查詢、超過 8 詞 400；runtime 不能改寫 chunk', async () => {
    assert.equal((await search(tokenA, '')).status, 400);
    assert.equal((await search(tokenA, 'a b c d e f g h i')).status, 400);
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(client.query("UPDATE enterprise.document_chunks SET text='x'"), { code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
