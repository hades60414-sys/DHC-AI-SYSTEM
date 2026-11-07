import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import express from 'express';
import { Pool } from 'pg';

import { createEnterpriseRouter } from '@/modules/enterprise-api/enterprise.routes.js';
import {
  bootstrapEnterpriseOrganization, createLocalDocumentBlobStore, runEnterpriseMigrations, setEnterpriseSubscriptionBySlug,
} from '@/modules/enterprise-persistence/index.js';

const database = process.env.E02A_TEST_DATABASE;
const PASSWORD = 'Synthetic-only-Passw0rd!';
const FIXTURE = path.resolve('docs/enterprise/scenarios/會計對帳');
const LEDGER = readFileSync(path.join(FIXTURE, '合成內部帳.csv'));
const RECEIPTS = readFileSync(path.join(FIXTURE, '合成收款明細.csv'));
const PERIOD = { periodStart: '2026-10-01', periodEnd: '2026-10-28' };

/**
 * V5 ACC-MATCH-v1 匯出經完整 HTTP → PostgreSQL：三種格式的內容 hash、匯出紀錄與稽核、並行匯出、來源改版標示、
 * 來源遺失拒絕（不留紀錄）、撤權後舊 session 失效、跨組織、訂閱到期仍可匯出。合成資料；Builder 工程驗證，不是 UAT PASS。
 */
describe('V5 ACC-MATCH-v1 對帳匯出（實際 PostgreSQL、完整 HTTP 路由）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 12 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  let server: http.Server;
  let base = '';
  let blobRoot = '';
  const org: Record<string, string> = {};
  const token: Record<string, string> = {};
  const memberId: Record<string, string> = {};
  let reconciliation: any;
  let ledgerDoc: { documentId: string; versionNumber: number; sha256: string };

  async function call(method: string, route: string, who: string, json?: unknown) {
    const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token[who]}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
      body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: response.status, data: (await response.json()) as any };
  }
  async function download(who: string, id: string, format: string) {
    const response = await fetch(`${base}/api/enterprise/v1/reconciliations/${id}/export?format=${format}`, { headers: { authorization: `Bearer ${token[who]}` } });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, body, headers: response.headers, json: () => JSON.parse(body.toString('utf8')) };
  }
  const login = async (who: string, slug: string, email: string) => {
    token[who] = (await (await fetch(base + '/api/enterprise/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationSlug: slug, email, password: PASSWORD }) })).json() as any).token;
  };
  async function upload(who: string, title: string, content: Buffer) {
    const response = await fetch(base + '/api/enterprise/v1/documents', { method: 'POST', body: content,
      headers: { authorization: `Bearer ${token[who]}`, 'content-type': 'text/csv', 'x-dhc-title': encodeURIComponent(title), 'x-dhc-filename': encodeURIComponent(`${title}.csv`) } });
    const data = await response.json() as any;
    assert.equal(response.status, 201, JSON.stringify(data));
    const documentId = data.document?.id ?? data.id;
    const versions = (await call('GET', `/api/enterprise/v1/documents/${documentId}/versions`, who)).data.items;
    return { documentId, versionNumber: versions[0].versionNumber, sha256: versions[0].sha256 };
  }
  const reconcile = async (who: string, ledger: { documentId: string; versionNumber: number }, receipts: { documentId: string; versionNumber: number }) => {
    const response = await call('POST', '/api/enterprise/v1/reconciliations', who, { ledger, receipts, ...PERIOD });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.reconciliation;
  };
  const count = async (sql: string, values: unknown[] = []) => (await admin.query(sql, values)).rows[0].n as number;
  const exportsOf = (id: string) => count('SELECT count(*)::int AS n FROM enterprise.reconciliation_exports WHERE reconciliation_id=$1', [id]);

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    for (const slug of ['acc', 'other']) {
      org[slug] = (await bootstrapEnterpriseOrganization(migrator, { slug, name: slug, adminEmail: `admin@${slug}.example.invalid`, adminPassword: PASSWORD })).organizationId;
      await setEnterpriseSubscriptionBySlug(migrator, { slug, planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    }
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-recon-export-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: runtime, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024 }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await login('admin', 'acc', 'admin@acc.example.invalid');
    await login('other', 'other', 'admin@other.example.invalid');
    for (const [name, roles] of [['clerk', ['employee']], ['auditor', ['auditor']], ['temp', ['employee']]] as const) {
      const created = await call('POST', '/api/enterprise/v1/members', 'admin', { email: `${name}@acc.example.invalid`, password: PASSWORD, roles });
      assert.equal(created.status, 201);
      memberId[name] = created.data.id ?? created.data.member?.id;
      await login(name, 'acc', `${name}@acc.example.invalid`);
    }
    ledgerDoc = await upload('clerk', '合成內部帳', LEDGER);
    const receipts = await upload('clerk', '合成收款明細', RECEIPTS);
    reconciliation = await reconcile('clerk', ledgerDoc, receipts);
  });
  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('三種格式：內容 SHA-256 與標頭一致、JSON 與已存結果一致；每次匯出留匯出紀錄與稽核；稽核者可匯出', async () => {
    const json = await download('clerk', reconciliation.id, 'json');
    assert.equal(json.status, 200);
    assert.equal(json.headers.get('x-dhc-content-sha256'), createHash('sha256').update(json.body).digest('hex'));
    assert.equal(json.headers.get('x-dhc-sources-superseded'), 'false');
    assert.equal(json.headers.get('cache-control'), 'no-store');
    const doc = json.json();
    assert.deepEqual([doc.reconciliation.id, doc.reconciliation.resultSha256, doc.counts.cases, doc.cases.length], [reconciliation.id, reconciliation.resultSha256, 9, 9]);
    assert.deepEqual(doc.cases, reconciliation.result.cases);
    const csv = await download('auditor', reconciliation.id, 'csv');
    assert.deepEqual([csv.status, csv.headers.get('content-type')], [200, 'text/csv; charset=utf-8']);
    assert.equal(csv.body.toString('utf8').trim().split('\r\n').length, 10);
    const md = await download('clerk', reconciliation.id, 'markdown');
    assert.match(md.body.toString('utf8'), /# 對帳結果匯出（ACC-MATCH-v1）/);
    const stored = (await admin.query('SELECT format, sha256, byte_size, sources_superseded FROM enterprise.reconciliation_exports WHERE reconciliation_id=$1 ORDER BY exported_at, format', [reconciliation.id])).rows;
    assert.deepEqual(stored.map(row => [row.format, row.byte_size, row.sources_superseded]).sort(), [['csv', csv.body.length, false], ['json', json.body.length, false], ['markdown', md.body.length, false]].sort());
    assert.ok(stored.some(row => row.sha256 === json.headers.get('x-dhc-content-sha256')));
    for (const format of ['json', 'csv', 'markdown']) {
      assert.equal(await count('SELECT count(*)::int AS n FROM enterprise.audit_events WHERE action=$1 AND resource_id=$2', [`reconciliation.exported_${format}`, reconciliation.id]), 1);
    }
    assert.equal((await download('clerk', reconciliation.id, 'xlsx')).status, 400);
  });

  test('並行匯出：6 個同時請求 → 同一份 bytes、6 筆匯出紀錄、6 筆稽核', async () => {
    const before = await exportsOf(reconciliation.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => download('clerk', reconciliation.id, 'csv')));
    assert.ok(results.every(item => item.status === 200));
    assert.equal(new Set(results.map(item => createHash('sha256').update(item.body).digest('hex'))).size, 1);
    assert.equal(await exportsOf(reconciliation.id), before + 6);
    assert.equal(await count("SELECT count(*)::int AS n FROM enterprise.audit_events WHERE action='reconciliation.exported_csv' AND resource_id=$1", [reconciliation.id]), 7);
  });

  test('來源改版：內部帳上傳新版本後，舊對帳仍可匯出且明確標示 superseded；結果與 hash 不變', async () => {
    const response = await fetch(`${base}/api/enterprise/v1/documents/${ledgerDoc.documentId}/versions`, { method: 'POST', body: Buffer.from(`${LEDGER.toString('utf8')}`.replace('I001', 'I001X')),
      headers: { authorization: `Bearer ${token.clerk}`, 'content-type': 'text/csv', 'if-match': `"${ledgerDoc.versionNumber}"`, 'x-dhc-filename': encodeURIComponent('合成內部帳.csv') } });
    assert.equal(response.status, 201);
    const exported = await download('clerk', reconciliation.id, 'json');
    const doc = exported.json();
    assert.equal(exported.headers.get('x-dhc-sources-superseded'), 'true');
    assert.deepEqual([doc.sourcesSuperseded, doc.sources[0].versionNumber, doc.sources[0].latestVersionNumber, doc.sources[0].sha256, doc.reconciliation.resultSha256],
      [true, ledgerDoc.versionNumber, ledgerDoc.versionNumber + 1, ledgerDoc.sha256, reconciliation.resultSha256]);
    assert.match((await download('clerk', reconciliation.id, 'markdown')).body.toString('utf8'), /來源文件已有新版本/);
  });

  test('跨組織與撤權：他組織 404；改角色後舊 session 401；停權 401；皆不留匯出紀錄', async () => {
    const before = await exportsOf(reconciliation.id);
    assert.equal((await download('other', reconciliation.id, 'json')).status, 404);
    const oldToken = token.temp;
    assert.equal((await call('PUT', `/api/enterprise/v1/members/${memberId.temp}/roles`, 'admin', { roles: ['auditor'] })).status, 200);
    token.temp = oldToken;
    assert.equal((await download('temp', reconciliation.id, 'json')).status, 401);
    await login('temp', 'acc', 'temp@acc.example.invalid');
    assert.equal((await download('temp', reconciliation.id, 'json')).status, 200);
    assert.equal((await call('POST', `/api/enterprise/v1/members/${memberId.temp}/disable`, 'admin')).status, 200);
    assert.equal((await download('temp', reconciliation.id, 'json')).status, 401);
    assert.equal(await exportsOf(reconciliation.id), before + 1);
  });

  test('V5.3 golden（跨側同列ID，人工手算）：真 PG 儲存結果與 JSON／CSV／Markdown 三種匯出一致', async () => {
    const golden = path.join(FIXTURE, 'golden');
    const expected = JSON.parse(readFileSync(path.join(golden, '跨側同列ID_預期.json'), 'utf8'));
    const ledger = await upload('clerk', '金樣內部帳', readFileSync(path.join(golden, '跨側同列ID_內部帳.csv')));
    const receipts = await upload('clerk', '金樣收款明細', readFileSync(path.join(golden, '跨側同列ID_收款明細.csv')));
    const response = await call('POST', '/api/enterprise/v1/reconciliations', 'clerk', { ledger: { documentId: ledger.documentId, versionNumber: ledger.versionNumber },
      receipts: { documentId: receipts.documentId, versionNumber: receipts.versionNumber }, ...expected.period });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const stored = (await call('GET', `/api/enterprise/v1/reconciliations/${response.data.reconciliation.id}`, 'clerk')).data;
    const pick = (item: any) => ({ documentId: item.documentId, category: item.category, ledgerRowIds: item.ledgerRowIds, receiptRowIds: item.receiptRowIds, differenceMinor: item.differenceMinor, isolated: item.isolated });
    assert.deepEqual(stored.result.cases.map(pick), expected.cases);
    const strip = (rows: any[]) => rows.map(({ derivation: _d, ...rest }) => rest);
    assert.deepEqual(stored.result.totals, strip(expected.totals));
    for (const [key, value] of Object.entries(expected.counts)) assert.equal(stored.result.counts[key], value, key);
    const json = (await download('clerk', stored.id, 'json')).json();
    assert.deepEqual([json.totals, json.cases.map(pick)], [strip(expected.totals), expected.cases]);
    const csvText = (await download('clerk', stored.id, 'csv')).body.toString('utf8').replace(/^\uFEFF/, '');
    const [header, ...rows] = csvText.trim().split('\r\n').map(line => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replace(/""/g, '"')));
    assert.equal(rows.length, expected.cases.length);
    const at = (name: string) => header.indexOf(name);
    assert.deepEqual(rows.map(row => [row[at('單據ID')], row[at('分類代碼')], row[at('差額_最小單位')], row[at('隔離')]]),
      expected.cases.map((item: any) => [item.documentId, item.category, item.differenceMinor ?? '', item.isolated ? 'Y' : 'N']));
    const md = (await download('clerk', stored.id, 'markdown')).body.toString('utf8');
    for (const total of expected.totals) assert.match(md, new RegExp(`\\| ${total.currency} \\| ${total.ledgerSourceMinor} \\| ${total.receiptSourceMinor} \\| ${total.isolatedLedgerMinor} \\| ${total.isolatedReceiptMinor} \\| ${total.exactMatchMinor} \\|`));
  });

  test('訂閱到期：匯出屬資料取得，仍可執行', async () => {
    await admin.query("UPDATE enterprise.subscriptions SET status='expired' WHERE organization_id=$1", [org.acc]);
    try {
      assert.equal((await download('clerk', reconciliation.id, 'csv')).status, 200);
    } finally {
      await admin.query("UPDATE enterprise.subscriptions SET status='active' WHERE organization_id=$1", [org.acc]);
    }
  });

  test('來源遺失：收款明細 blob 被刪 → 409 SOURCE_UNAVAILABLE，不產生匯出紀錄與稽核', async () => {
    const ledger = await upload('clerk', '遺失測試內部帳', Buffer.from(LEDGER.toString('utf8').replace('I001', 'L001')));
    const receipts = await upload('clerk', '遺失測試收款', Buffer.from(RECEIPTS.toString('utf8').replace('R001', 'Q001')));
    const lost = await reconcile('clerk', ledger, receipts);
    await unlink(path.join(blobRoot, org.acc.toLowerCase(), receipts.sha256.slice(0, 2), receipts.sha256));
    const response = await download('clerk', lost.id, 'json');
    assert.deepEqual([response.status, response.json().error.code], [409, 'ENTERPRISE_SOURCE_UNAVAILABLE']);
    assert.equal(await exportsOf(lost.id), 0);
    assert.equal(await count("SELECT count(*)::int AS n FROM enterprise.audit_events WHERE action LIKE 'reconciliation.exported_%' AND resource_id=$1", [lost.id]), 0);
  });
});
