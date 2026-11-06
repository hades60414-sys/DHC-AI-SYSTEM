import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const CSV = readFileSync(path.resolve('docs/enterprise/scenarios/營運週報/合成營運明細.csv'));
const HEADER = CSV.toString('utf8').split('\n')[0];

/**
 * V5 OPS-REPORT-v1 經完整 HTTP → PostgreSQL：冪等與並行重送、拒收留痕、版本變更、同檔名跨組織隔離（含直接 RLS）、
 * 停權／降權、來源損毀（失敗不留列）、訂閱到期。合成資料、無模型、無外部連線；Builder 工程驗證，不是客戶 UAT PASS。
 */
describe('V5 OPS-REPORT-v1 營運週報（實際 PostgreSQL、完整 HTTP 路由）', { skip: !database }, () => {
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
      headers: { authorization: `Bearer ${token[who]}`, 'content-type': 'text/csv', 'x-dhc-title': encodeURIComponent(title), 'x-dhc-filename': encodeURIComponent('合成營運明細.csv') } });
    const data = await response.json() as any;
    assert.equal(response.status, 201, JSON.stringify(data));
    const documentId = data.document?.id ?? data.id;
    const versions = (await call('GET', `/api/enterprise/v1/documents/${documentId}/versions`, who)).data.items;
    return { documentId, versionNumber: versions[0].versionNumber, sha256: versions[0].sha256 };
  }
  const ref = (doc: { documentId: string; versionNumber: number }) => ({ documentId: doc.documentId, versionNumber: doc.versionNumber });
  const report = (who: string, sources = [docs.ops], week = '2026-W43', datasets = ['BASE']) =>
    call('POST', '/api/enterprise/v1/ops-reports', who, { sources: sources.map(ref), week, datasets });
  const count = async (sql: string, values: unknown[] = []) => (await admin.query(sql, values)).rows[0].n as number;
  const claim = (row: any, id: string) => row.result.claims.find((item: any) => item.claimId === id);
  const csvOf = (rows: string[]) => Buffer.from(`${HEADER}\n${rows.join('\n')}\n`, 'utf8');

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    for (const slug of ['ops', 'other']) {
      org[slug] = (await bootstrapEnterpriseOrganization(migrator, { slug, name: slug, adminEmail: `admin@${slug}.example.invalid`, adminPassword: PASSWORD })).organizationId;
      await setEnterpriseSubscriptionBySlug(migrator, { slug, planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    }
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-ops-api-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: runtime, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024 }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await login('admin', 'ops', 'admin@ops.example.invalid');
    await login('other', 'other', 'admin@other.example.invalid');
    for (const [name, roles] of [['clerk', ['employee']], ['auditor', ['auditor']], ['temp', ['employee']]] as const) {
      const created = await call('POST', '/api/enterprise/v1/members', 'admin', { email: `${name}@ops.example.invalid`, password: PASSWORD, roles });
      assert.equal(created.status, 201);
      memberId[name] = created.data.id ?? created.data.member?.id;
      await login(name, 'ops', `${name}@ops.example.invalid`);
    }
    docs.ops = await upload('clerk', '合成營運明細', CSV);
  });
  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('正常週：14 項主張由伺服器計算、來源綁定版本與 hash、結果 hash 可重算；重送回同一筆（不加倍）；稽核者可讀不可建', async () => {
    const first = await report('clerk');
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const row = first.data.opsReport;
    assert.deepEqual([row.status, row.ruleVersion, row.isoWeek, row.periodStart, row.periodEnd, row.datasets], ['completed', 'OPS-REPORT-v1', '2026-W43', '2026-10-19', '2026-10-25', ['BASE']]);
    assert.deepEqual(row.sources.map((item: any) => item.sha256), [docs.ops.sha256]);
    assert.deepEqual(['OP-CLM-01', 'OP-CLM-04', 'OP-CLM-09', 'OP-CLM-11', 'OP-CLM-12', 'OP-CLM-14'].map(id => claim(row, id).display), ['210', '16.67', '93.75', '0.89', null, '66.67']);
    assert.ok(row.result.claims.flatMap((item: any) => item.sources).every((source: any) => source.sha256 === docs.ops.sha256));
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(',')}}` : JSON.stringify(value);
    assert.equal(createHash('sha256').update(canonical(row.result)).digest('hex'), row.resultSha256);
    const again = await report('clerk');
    assert.deepEqual([again.status, again.data.reused, again.data.opsReport.id], [200, true, row.id]);
    assert.equal(await count("SELECT count(*)::int AS n FROM enterprise.ops_reports WHERE organization_id=$1 AND status='completed' AND iso_week='2026-W43'", [org.ops]), 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM enterprise.audit_events WHERE action='ops_report.completed' AND resource_type='ops_report' AND resource_id=$1", [row.id]), 1);
    assert.equal((await call('GET', `/api/enterprise/v1/ops-reports/${row.id}`, 'auditor')).data.resultSha256, row.resultSha256);
    assert.equal((await report('auditor')).status, 403);
    const listed = (await call('GET', '/api/enterprise/v1/ops-reports', 'clerk')).data.items;
    assert.ok(listed.some((item: any) => item.id === row.id && item.result === undefined), '列表不帶完整結果');
  });

  test('並行重送：同輸入 6 個同時請求 → 恰一筆成功結果、一筆稽核、一個 201', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => report('clerk', [docs.ops], '2026-W42')));
    assert.deepEqual(responses.map(item => item.status).sort(), [200, 200, 200, 200, 200, 201]);
    assert.equal(new Set(responses.map(item => item.data.opsReport.id)).size, 1);
    const id = responses[0].data.opsReport.id;
    assert.equal(await count("SELECT count(*)::int AS n FROM enterprise.ops_reports WHERE organization_id=$1 AND iso_week='2026-W42'", [org.ops]), 1);
    assert.equal(await count('SELECT count(*)::int AS n FROM enterprise.ops_report_sources WHERE ops_report_id=$1', [id]), 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM enterprise.audit_events WHERE resource_id=$1", [id]), 1);
  });

  test('來源衝突與多來源：選 BASE＋NEG-CONFLICT → CONFLICT；兩個來源調換順序是同一份結果', async () => {
    const conflict = await report('clerk', [docs.ops], '2026-W43', ['NEG-CONFLICT', 'BASE']);
    assert.equal(conflict.status, 201);
    assert.deepEqual([claim(conflict.data.opsReport, 'OP-CLM-01').status, conflict.data.opsReport.datasets], ['CONFLICT', ['BASE', 'NEG-CONFLICT']]);
    docs.extra = await upload('clerk', '補充據點', csvOf(['SYNTHETIC,BASE,EXTRA-W43-D,2026-W43,2026-10-19,2026-10-25,SYN-D,虛構丁站,5,4,4,1,30,SYN-OWNER-D,SYN-SNAPSHOT-02']));
    const ab = await report('clerk', [docs.ops, docs.extra]);
    const ba = await report('clerk', [docs.extra, docs.ops]);
    assert.deepEqual([ab.status, ba.status, ba.data.reused, ba.data.opsReport.id], [201, 200, true, ab.data.opsReport.id]);
    assert.equal(claim(ab.data.opsReport, 'OP-CLM-01').display, '214');
    assert.equal(claim(ab.data.opsReport, 'OP-CLM-02').status, 'UNKNOWN', '丁站沒有前週資料，前週同據點合計不可得');
  });

  test('拒收留痕：結構錯誤 → 201 rejected（錯誤清單與稽核），不產生主張；請求錯誤 → 4xx 且不寫入', async () => {
    const bad = await upload('clerk', '壞營運明細', Buffer.from(CSV.toString('utf8').replace(',84,80,76,20,960,', ',84,8.5,76,20,960,')));
    const rejected = await report('clerk', [bad]);
    assert.deepEqual([rejected.status, rejected.data.opsReport.status, rejected.data.opsReport.result.claims], [201, 'rejected', undefined]);
    assert.deepEqual(rejected.data.opsReport.result.errors, [{ source: 0, line: 2, recordId: 'OPS-BASE-W42-A', code: 'INVALID_週完成件數' }]);
    assert.equal(await count("SELECT count(*)::int AS n FROM enterprise.audit_events WHERE action='ops_report.rejected' AND resource_id=$1", [rejected.data.opsReport.id]), 1);
    const before = await count('SELECT count(*)::int AS n FROM enterprise.ops_reports');
    for (const [body, status] of [
      [{ sources: [ref(docs.ops)], week: '2026-W60', datasets: ['BASE'] }, 400],
      [{ sources: [ref(docs.ops)], week: '2026-10-19', datasets: ['BASE'] }, 400],
      [{ sources: [ref(docs.ops), ref(docs.ops)], week: '2026-W43', datasets: ['BASE'] }, 400],
      [{ sources: [ref(docs.ops)], week: '2026-W43', datasets: [] }, 400],
      [{ sources: [ref(docs.ops)], week: '2026-W43' }, 400],
      [{ sources: [], week: '2026-W43', datasets: ['BASE'] }, 400],
      [{ sources: [ref(docs.ops)], week: '2026-W43', datasets: ['BASE'], ruleVersion: 'OPS-REPORT-v2' }, 400],
      [{ sources: [{ ...ref(docs.ops), versionNumber: 9 }], week: '2026-W43', datasets: ['BASE'] }, 404],
    ] as const) {
      assert.equal((await call('POST', '/api/enterprise/v1/ops-reports', 'clerk', body)).status, status, JSON.stringify(body));
    }
    assert.equal(await count('SELECT count(*)::int AS n FROM enterprise.ops_reports'), before);
  });

  test('版本變更：同文件新版本產生新結果並綁新 hash；舊結果維持原版本、原數值', async () => {
    const original = (await report('clerk')).data.opsReport;
    const revisedCsv = Buffer.from(CSV.toString('utf8').replace(',55,50,,15,660,', ',55,50,48,15,660,'));
    const response = await fetch(`${base}/api/enterprise/v1/documents/${docs.ops.documentId}/versions`, { method: 'POST', body: revisedCsv,
      headers: { authorization: `Bearer ${token.clerk}`, 'content-type': 'text/csv', 'if-match': `"${docs.ops.versionNumber}"`, 'x-dhc-filename': encodeURIComponent('合成營運明細.csv') } });
    assert.equal(response.status, 201, await response.clone().text());
    const v2 = { ...docs.ops, versionNumber: docs.ops.versionNumber + 1, sha256: createHash('sha256').update(revisedCsv).digest('hex') };
    const revised = await report('clerk', [v2]);
    assert.equal(revised.status, 201);
    assert.notEqual(revised.data.opsReport.id, original.id);
    assert.deepEqual([revised.data.opsReport.sources[0].sha256, claim(revised.data.opsReport, 'OP-CLM-12').display], [v2.sha256, '94.29']);
    const reread = (await call('GET', `/api/enterprise/v1/ops-reports/${original.id}`, 'clerk')).data;
    assert.deepEqual([reread.sources[0].sha256, claim(reread, 'OP-CLM-12').status, reread.resultSha256], [docs.ops.sha256, 'UNKNOWN', original.resultSha256]);
  });

  test('跨組織：另一組織上傳同檔名不同內容 → 各自結果；讀不到、也不能引用本組織版本；直接 RLS 也看不到', async () => {
    const theirs = await upload('other', '合成營運明細', csvOf(['SYNTHETIC,BASE,OTHER-W43-A,2026-W43,2026-10-19,2026-10-25,SYN-A,其他甲站,9,9,9,0,10,OTHER-OWNER,OTHER-SNAP']));
    const their = await report('other', [theirs]);
    assert.deepEqual([their.status, claim(their.data.opsReport, 'OP-CLM-01').display], [201, '9']);
    const mine = (await call('GET', '/api/enterprise/v1/ops-reports', 'clerk')).data.items;
    assert.ok(!mine.some((item: any) => item.id === their.data.opsReport.id));
    assert.ok((await call('GET', '/api/enterprise/v1/ops-reports', 'other')).data.items.every((item: any) => item.id === their.data.opsReport.id));
    assert.equal((await call('GET', `/api/enterprise/v1/ops-reports/${mine[0].id}`, 'other')).status, 404);
    assert.equal((await report('other', [docs.ops])).status, 404);
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('dhc.organization_id',$1,true)", [org.other]);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM enterprise.ops_reports WHERE organization_id=$1', [org.ops])).rows[0].n, 0);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM enterprise.ops_report_sources WHERE organization_id=$1', [org.ops])).rows[0].n, 0);
      await assert.rejects(client.query(`INSERT INTO enterprise.ops_reports(organization_id,rule_version,iso_week,period_start,period_end,datasets,input_key,status,result,result_sha256,created_by_member_id)
        VALUES ($1,'OPS-REPORT-v1','2026-W43','2026-10-19','2026-10-25','{BASE}',$2,'rejected','{}',$2,$3)`, [org.ops, 'f'.repeat(64), memberId.clerk]), /row-level security/);
      await client.query('ROLLBACK');
      await assert.rejects(client.query('UPDATE enterprise.ops_reports SET status=status'), /permission denied/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  test('撤權：降為稽核者 → 403；停權 → 既有 session 401；都不寫入', async () => {
    const before = await count('SELECT count(*)::int AS n FROM enterprise.ops_reports');
    assert.equal((await call('PUT', `/api/enterprise/v1/members/${memberId.temp}/roles`, 'admin', { roles: ['auditor'] })).status, 200);
    await login('temp', 'ops', 'temp@ops.example.invalid');
    assert.equal((await report('temp', [docs.ops], '2026-W41')).status, 403);
    assert.equal((await call('PUT', `/api/enterprise/v1/members/${memberId.temp}/roles`, 'admin', { roles: ['employee'] })).status, 200);
    await login('temp', 'ops', 'temp@ops.example.invalid');
    assert.equal((await call('POST', `/api/enterprise/v1/members/${memberId.temp}/disable`, 'admin')).status, 200);
    assert.equal((await report('temp', [docs.ops], '2026-W41')).status, 401);
    assert.equal(await count('SELECT count(*)::int AS n FROM enterprise.ops_reports'), before);
  });

  test('失敗：來源 blob 遭竄改 → 500 BLOB_INTEGRITY，交易回退（無結果列、無來源列、無稽核）', async () => {
    const content = csvOf(['SYNTHETIC,BASE,TAMPER-W43-A,2026-W43,2026-10-19,2026-10-25,SYN-A,虛構甲站,1,1,1,0,1,SYN-OWNER-A,SYN-SNAPSHOT-09']);
    const doc = await upload('clerk', '將被竄改', content);
    await writeFile(path.join(blobRoot, org.ops.toLowerCase(), doc.sha256.slice(0, 2), doc.sha256), Buffer.from('tampered'));
    const counts = async () => [await count('SELECT count(*)::int AS n FROM enterprise.ops_reports'), await count('SELECT count(*)::int AS n FROM enterprise.ops_report_sources'),
      await count("SELECT count(*)::int AS n FROM enterprise.audit_events WHERE resource_type='ops_report'")];
    const before = await counts();
    const failed = await report('clerk', [doc]);
    assert.deepEqual([failed.status, failed.data.error?.code], [500, 'ENTERPRISE_BLOB_INTEGRITY']);
    assert.deepEqual(await counts(), before);
  });

  test('訂閱到期：建立週報 402；讀取既有結果保留', async () => {
    await admin.query("UPDATE enterprise.subscriptions SET status='expired' WHERE organization_id=$1", [org.ops]);
    try {
      const response = await report('clerk', [docs.ops], '2026-W40');
      assert.deepEqual([response.status, response.data.error?.code], [402, 'ENTERPRISE_SUBSCRIPTION_INACTIVE']);
      assert.equal((await call('GET', '/api/enterprise/v1/ops-reports', 'clerk')).status, 200);
    } finally {
      await admin.query("UPDATE enterprise.subscriptions SET status='active' WHERE organization_id=$1", [org.ops]);
    }
  });
});
