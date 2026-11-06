import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
 * W6-B（DEC-W6-SCOPE-01）：ACC-MATCH-v1 對帳經完整 HTTP → PostgreSQL。對應 ACC-UAT-01（導入與重送不加倍）、02（結構拒收）、
 * 03–07（分類由引擎單元測試對 oracle 逐欄驗證，這裡驗證持久化後一致）、13（跨組織）。合成資料、無模型、無外部連線。
 * 這是 Builder 的工程驗證，不是客戶 UAT PASS。
 */
describe('W6-B ACC-MATCH-v1 對帳（實際 PostgreSQL、完整 HTTP 路由）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 8 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  let server: http.Server;
  let base = '';
  let blobRoot = '';
  let organizationId = '';
  const token: Record<string, string> = {};
  const docs: Record<string, { documentId: string; versionNumber: number; sha256: string }> = {};

  async function call(method: string, route: string, who: string, json?: unknown) {
    const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token[who]}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
      body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: response.status, data: (await response.json()) as any };
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
    const versions = (await call('GET', `/api/enterprise/v1/documents/${data.document?.id ?? data.id}/versions`, who)).data.items;
    return { documentId: data.document?.id ?? data.id, versionNumber: versions[0].versionNumber, sha256: versions[0].sha256 };
  }
  const reconcile = (who: string, ledger = docs.ledger, receipts = docs.receipts, period = PERIOD) => call('POST', '/api/enterprise/v1/reconciliations', who,
    { ledger: { documentId: ledger.documentId, versionNumber: ledger.versionNumber }, receipts: { documentId: receipts.documentId, versionNumber: receipts.versionNumber }, ...period });

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    for (const slug of ['acc', 'other']) {
      const created = await bootstrapEnterpriseOrganization(migrator, { slug, name: slug, adminEmail: `admin@${slug}.example.invalid`, adminPassword: PASSWORD });
      if (slug === 'acc') organizationId = created.organizationId;
      await setEnterpriseSubscriptionBySlug(migrator, { slug, planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    }
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-recon-api-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: runtime, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024 }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await login('admin', 'acc', 'admin@acc.example.invalid');
    await login('other', 'other', 'admin@other.example.invalid');
    for (const [name, roles] of [['clerk', ['employee']], ['auditor', ['auditor']]] as const) {
      assert.equal((await call('POST', '/api/enterprise/v1/members', 'admin', { email: `${name}@acc.example.invalid`, password: PASSWORD, roles })).status, 201);
      await login(name, 'acc', `${name}@acc.example.invalid`);
    }
    docs.ledger = await upload('clerk', '合成內部帳', LEDGER);
    docs.receipts = await upload('clerk', '合成收款明細', RECEIPTS);
  });
  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('ACC-UAT-01/03–07：導入兩份固定 CSV → 9 案件（完全匹配 3、六類例外各 1），來源指回版本與 hash；重送回同一結果（不加倍）', async () => {
    const first = await reconcile('clerk');
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const row = first.data.reconciliation;
    assert.equal(row.status, 'completed');
    assert.deepEqual([row.ruleVersion, row.ledgerSha256, row.receiptsSha256, row.periodStart, row.periodEnd],
      ['ACC-MATCH-v1', docs.ledger.sha256, docs.receipts.sha256, '2026-10-01', '2026-10-28']);
    const counts = row.result.counts;
    assert.deepEqual([counts.cases, counts.ledgerRows, counts.receiptRows, counts.EXACT_MATCH, counts.AMOUNT_DIFFERENCE, counts.CURRENCY_MISMATCH,
      counts.MISSING_RECEIPT, counts.MISSING_INTERNAL, counts.DUPLICATE_DOCUMENT_ID, counts.DUPLICATE_RECEIPT_ID, counts.UNSUPPORTED], [9, 9, 9, 3, 1, 1, 1, 1, 1, 1, 0]);
    const case004 = row.result.cases.find((item: any) => item.caseId === 'ACC-CASE-004');
    assert.deepEqual([case004.category, case004.differenceMinor], ['AMOUNT_DIFFERENCE', '-5000']);
    assert.ok(row.result.cases.flatMap((item: any) => item.sources).every((source: any) =>
      source.sha256 === (source.side === 'ledger' ? docs.ledger.sha256 : docs.receipts.sha256)));
    // 獨立重算：依契約把回傳 JSON 的物件鍵排序後取 SHA-256（不呼叫伺服器的實作）
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(',')}}` : JSON.stringify(value);
    assert.equal(createHash('sha256').update(canonical(row.result)).digest('hex'), row.resultSha256, '結果 hash 可由回傳 JSON 重算');
    const again = await reconcile('clerk');
    assert.deepEqual([again.status, again.data.reused, again.data.reconciliation.id], [200, true, row.id]);
    const stored = (await admin.query("SELECT count(*)::int AS n FROM enterprise.reconciliations WHERE organization_id=$1 AND status='completed'", [organizationId])).rows[0].n;
    assert.equal(stored, 1);
    const audit = (await admin.query("SELECT count(*)::int AS n FROM enterprise.audit_events WHERE action='reconciliation.completed' AND resource_id=$1", [row.id])).rows[0].n;
    assert.equal(audit, 1);
    // 稽核者可讀、不可建立
    assert.equal((await call('GET', `/api/enterprise/v1/reconciliations/${row.id}`, 'auditor')).data.resultSha256, row.resultSha256);
    assert.equal((await reconcile('auditor')).status, 403);
  });

  test('ACC-UAT-02：結構錯誤整批拒收（記錄錯誤與稽核，不產生案件），原始文件版本不變', async () => {
    const bad = await upload('clerk', '壞內部帳', Buffer.from(LEDGER.toString('utf8').replace(',2,100000,', ',2,1000.50,')));
    const rejected = await reconcile('clerk', bad);
    assert.equal(rejected.status, 201);
    assert.equal(rejected.data.reconciliation.status, 'rejected');
    assert.deepEqual(rejected.data.reconciliation.result.errors[0], { side: 'ledger', line: 2, rowId: 'I001', code: 'AMOUNT_NOT_POSITIVE_INTEGER' });
    assert.equal(rejected.data.reconciliation.result.cases, undefined);
    const outside = await reconcile('clerk', docs.ledger, docs.receipts, { periodStart: '2026-10-02', periodEnd: '2026-10-28' });
    assert.ok(outside.data.reconciliation.result.errors.some((error: any) => error.code === 'DATE_OUTSIDE_PERIOD'));
    const version = (await call('GET', `/api/enterprise/v1/documents/${docs.ledger.documentId}/versions`, 'clerk')).data.items[0];
    assert.equal(version.sha256, docs.ledger.sha256);
  });

  test('請求驗證：同一版本當兩邊、未知版本、錯規則版本 → 4xx，不寫入', async () => {
    const before = (await admin.query('SELECT count(*)::int AS n FROM enterprise.reconciliations')).rows[0].n;
    assert.equal((await reconcile('clerk', docs.ledger, docs.ledger)).status, 400);
    assert.equal((await reconcile('clerk', { ...docs.ledger, versionNumber: 9 })).status, 404);
    const wrongRule = await call('POST', '/api/enterprise/v1/reconciliations', 'clerk', { ledger: docs.ledger, receipts: docs.receipts, ...PERIOD, ruleVersion: 'ACC-MATCH-v2' });
    assert.equal(wrongRule.status, 400);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM enterprise.reconciliations')).rows[0].n, before);
  });

  test('V5.2 ASTRA-ROLL-006：不存在日期與反向期間在查 DB 前 400（不再 500）、不寫入；閏日合法', async () => {
    const before = (await admin.query('SELECT count(*)::int AS n FROM enterprise.reconciliations')).rows[0].n;
    for (const period of [{ periodStart: '2026-02-30', periodEnd: '2026-03-31' }, { periodStart: '2026-10-01', periodEnd: '2026-13-01' }, { periodStart: '2026-10-28', periodEnd: '2026-10-01' }, { periodStart: '2027-02-29', periodEnd: '2027-03-01' }]) {
      const response = await reconcile('clerk', docs.ledger, docs.receipts, period);
      assert.deepEqual([response.status, response.data.error?.code], [400, 'ENTERPRISE_INVALID_RECONCILIATION'], JSON.stringify(period));
    }
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM enterprise.reconciliations')).rows[0].n, before);
    const leap = await reconcile('clerk', docs.ledger, docs.receipts, { periodStart: '2028-02-29', periodEnd: '2028-03-01' });
    assert.equal(leap.status, 201, '閏日是合法期間（fixture 日期在期間外 → 拒收結果，但不是 400／500）');
    assert.equal(leap.data.reconciliation.status, 'rejected');
  });

  test('ACC-UAT-13（API 部分）：另一組織讀不到、也不能拿本組織的文件版本對帳', async () => {
    const list = (await call('GET', '/api/enterprise/v1/reconciliations', 'other')).data.items;
    assert.deepEqual(list, []);
    const mine = (await call('GET', '/api/enterprise/v1/reconciliations', 'clerk')).data.items[0];
    assert.equal((await call('GET', `/api/enterprise/v1/reconciliations/${mine.id}`, 'other')).status, 404);
    assert.equal((await reconcile('other')).status, 404);
  });

  test('訂閱到期：建立對帳 402（商務寫入）；讀取既有結果保留', async () => {
    await admin.query("UPDATE enterprise.subscriptions SET status='expired' WHERE organization_id=$1", [organizationId]);
    try {
      const response = await reconcile('clerk', docs.ledger, docs.receipts, { periodStart: '2026-10-01', periodEnd: '2026-10-31' });
      assert.deepEqual([response.status, response.data.error?.code], [402, 'ENTERPRISE_SUBSCRIPTION_INACTIVE']);
      assert.equal((await call('GET', '/api/enterprise/v1/reconciliations', 'clerk')).status, 200);
    } finally {
      await admin.query("UPDATE enterprise.subscriptions SET status='active' WHERE organization_id=$1", [organizationId]);
    }
  });
});
