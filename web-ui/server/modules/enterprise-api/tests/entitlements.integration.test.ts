import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import express from 'express';
import { Pool } from 'pg';

import { createEnterpriseRouter } from '@/modules/enterprise-api/enterprise.routes.js';
import {
  bootstrapEnterpriseOrganization, createEnterpriseRunWorker, createLocalDocumentBlobStore, runEnterpriseMigrations, setEnterpriseSubscriptionBySlug,
} from '@/modules/enterprise-persistence/index.js';

const database = process.env.E02A_TEST_DATABASE;
const PASSWORD = 'Synthetic-only-Passw0rd!';

/**
 * ASTRA-006：配額檢查與寫入同一交易、同一把組織鎖；儲存以去重後新增 bytes 計算。
 * ASTRA-014：沒有／到期／取消的訂閱，所有商務寫入一致拒絕；安全撤權、取消、讀取、匯出保留；續約恢復。
 */
describe('ASTRA-006／014 權益與到期政策（實際 PostgreSQL）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 12 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  const worker = createEnterpriseRunWorker(runtime, { timeoutMs: 5000 });
  let server: http.Server;
  let base = '';
  let blobRoot = '';
  let organizationId = '';
  const token: Record<string, string> = {};
  const member: Record<string, string> = {};

  async function call(method: string, route: string, who: string, json?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token[who]}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: json === undefined ? undefined : JSON.stringify(json) });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, data: (type.includes('json') ? await response.json() : await response.text()) as any };
  }
  const login = async (who: string, email: string) => {
    token[who] = (await (await fetch(base + '/api/enterprise/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationSlug: 'quota', email, password: PASSWORD }) })).json() as any).token;
  };
  const upload = async (who: string, text: string | Buffer, title = '配額測試') => {
    const response = await fetch(base + '/api/enterprise/v1/documents', { method: 'POST', body: Buffer.isBuffer(text) ? text : Buffer.from(text),
      headers: { authorization: `Bearer ${token[who]}`, 'content-type': 'text/plain', 'x-dhc-title': encodeURIComponent(title), 'x-dhc-filename': 'q.txt' } });
    return { status: response.status, data: await response.json() as any };
  };
  const usedBytes = async () => Number((await admin.query('SELECT coalesce(sum(byte_size),0)::bigint AS n FROM enterprise.document_blobs WHERE organization_id=$1', [organizationId])).rows[0].n);
  const setLimits = (fields: Record<string, number | string>) => admin.query(
    `UPDATE enterprise.subscriptions SET ${Object.keys(fields).map((key, i) => `${key}=$${i + 2}`).join(',')} WHERE organization_id=$1`, [organizationId, ...Object.values(fields)]);
  const setStatus = (status: string) => setLimits({ status });
  let keys = 0;
  const runRequest = (who: string) => call('POST', '/api/enterprise/v1/runs/draft-generation', who, { title: 't', query: '配額', providerKey: 'mock' },
    { 'idempotency-key': `quota-key-${(keys += 1).toString().padStart(4, '0')}` });

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    await bootstrapEnterpriseOrganization(migrator, { slug: 'quota', name: 'quota', adminEmail: 'admin@quota.example.invalid', adminPassword: PASSWORD });
    await setEnterpriseSubscriptionBySlug(migrator, { slug: 'quota', planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    organizationId = (await admin.query("SELECT id FROM enterprise.organizations WHERE slug='quota'")).rows[0].id;
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-quota-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: runtime, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024 }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await login('admin', 'admin@quota.example.invalid');
    for (const [name, roles] of [['approver', ['approver']], ['employee', ['employee']]] as const) {
      member[name] = (await call('POST', '/api/enterprise/v1/members', 'admin', { email: `${name}@quota.example.invalid`, password: PASSWORD, roles })).data.id;
      await login(name, `${name}@quota.example.invalid`);
    }
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { key: 'mock', kind: 'mock', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 0 })).status, 200);
  });
  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  describe('ASTRA-006 儲存', () => {
    test('剩 N-1 bytes 上傳 N bytes：拒絕且不留下 blob；剛好 N 可以', async () => {
      assert.equal((await upload('employee', '配額 基準')).status, 201);
      const used = await usedBytes();
      await setLimits({ storage_limit_bytes: used + 9 });
      // 這兩個儲存測試刻意沿用「剛好用完」的狀態；最後一個儲存測試的 finally 會恢復上限。
      const blobsBefore = (await readdir(blobRoot, { recursive: true })).length;
      const over = await upload('employee', '0123456789'); // 10 bytes > 剩 9
      assert.deepEqual([over.status, over.data.error?.code], [413, 'ENTERPRISE_STORAGE_LIMIT']);
      assert.equal(await usedBytes(), used);
      assert.equal((await readdir(blobRoot, { recursive: true })).length, blobsBefore, '超額時不寫 blob 檔');
      assert.equal((await upload('employee', '012345678')).status, 201, '剛好用完可以');
      assert.equal(await usedBytes(), used + 9);
    });

    test('已滿時：完全相同內容（去重，新增 0 bytes）仍可建立；新內容的新版本被拒', async () => {
      const dedup = await upload('employee', '012345678', '同內容另一份文件');
      assert.equal(dedup.status, 201);
      const version = await fetch(`${base}/api/enterprise/v1/documents/${dedup.data.document.id}/versions`, { method: 'POST', body: Buffer.from('x'),
        headers: { authorization: `Bearer ${token.employee}`, 'content-type': 'text/plain', 'x-dhc-filename': 'v2.txt', 'if-match': '"1"' } });
      assert.equal(version.status, 413);
    });

    test('並行上傳：兩份各自放得下、合起來超過 → 只有一份成功，用量不超限', async () => {
      const used = await usedBytes();
      await setLimits({ storage_limit_bytes: used + 15 });
      try {
        const results = await Promise.all([upload('employee', 'AAAAAAAAAA'), upload('approver', 'BBBBBBBBBB')]);
        assert.deepEqual(results.map(r => r.status).sort(), [201, 413]);
        assert.ok(await usedBytes() <= used + 15);
      } finally {
        await setLimits({ storage_limit_bytes: 100 * 1024 ** 3 });
      }
    });
  });

  describe('ASTRA-006 席位與 Run', () => {
    test('最後一席：兩個並行新增成員只有一個成功', async () => {
      const seats = (await admin.query("SELECT count(*)::int AS n FROM enterprise.org_members WHERE organization_id=$1 AND status='active'", [organizationId])).rows[0].n;
      await setLimits({ seat_limit: seats + 1 });
      try {
        const results = await Promise.all(['s1', 's2'].map(name => call('POST', '/api/enterprise/v1/members', 'admin', { email: `${name}@quota.example.invalid`, password: PASSWORD, roles: ['employee'] })));
        assert.deepEqual(results.map(r => r.status).sort(), [201, 403]);
      } finally {
        await setLimits({ seat_limit: 10 });
      }
    });

    test('最後一個 Run：並行建立只有一個成功', async () => {
      const runs = (await admin.query("SELECT count(*)::int AS n FROM enterprise.runs WHERE organization_id=$1 AND created_at >= date_trunc('month', now())", [organizationId])).rows[0].n;
      await setLimits({ monthly_run_limit: runs + 1 });
      try {
        const results = await Promise.all([runRequest('employee'), runRequest('approver'), runRequest('admin')]);
        assert.deepEqual(results.map(r => r.status).sort(), [202, 429, 429]);
      } finally {
        await setLimits({ monthly_run_limit: 3000 });
        while (await worker.tick()) { /* 清空佇列，避免影響後續測試 */ }
      }
    });
  });

  describe('ASTRA-014 到期寫入矩陣', () => {
    let draftId = '';
    let approvalId = '';
    let approvedDraftId = '';
    let approvalConfirm: Record<string, unknown> = {};
    let queuedRun = '';

    before(async () => {
      const make = async () => {
        const run = await runRequest('employee');
        await worker.tick();
        return (await call('GET', `/api/enterprise/v1/runs/${run.data.run.id}`, 'employee')).data.draftId as string;
      };
      draftId = await make();
      const pendingDraft = await make();
      const pendingSubmit = (await call('POST', `/api/enterprise/v1/drafts/${pendingDraft}/submit`, 'employee', { expectedRevision: 1 })).data;
      approvalId = pendingSubmit.approvalId;
      approvalConfirm = { expectedRevision: pendingSubmit.revision, expectedSha256: pendingSubmit.revisionSha256 };
      approvedDraftId = await make();
      const approval = (await call('POST', `/api/enterprise/v1/drafts/${approvedDraftId}/submit`, 'employee', { expectedRevision: 1 })).data;
      assert.equal((await call('POST', `/api/enterprise/v1/approvals/${approval.approvalId}/decision`, 'approver', { decision: 'approve', expectedRevision: approval.revision, expectedSha256: approval.revisionSha256 })).status, 200);
      queuedRun = (await runRequest('employee')).data.run.id;
    });

    for (const status of ['expired', 'cancelled', 'none']) {
      test(`訂閱 ${status}：商務寫入全部 402，安全與資料取得操作保留`, async () => {
        let saved: Record<string, unknown> | null = null;
        if (status === 'none') {
          // 不用 TEMP TABLE（連線池每次可能拿到不同連線）；把原列存在記憶體，結束時原樣寫回
          saved = (await admin.query('SELECT * FROM enterprise.subscriptions WHERE organization_id=$1', [organizationId])).rows[0];
          await admin.query('DELETE FROM enterprise.subscriptions WHERE organization_id=$1', [organizationId]);
        } else {
          await setStatus(status);
        }
        try {
          const draft = (await call('GET', `/api/enterprise/v1/drafts/${draftId}`, 'employee')).data;
          const blocked: Array<[string, Promise<{ status: number; data: any }>]> = [
            ['document.write', upload('employee', `到期上傳 ${status}`)],
            ['run.create', runRequest('employee')],
            ['member.create', call('POST', '/api/enterprise/v1/members', 'admin', { email: `late-${status}@quota.example.invalid`, password: PASSWORD, roles: ['employee'] })],
            ['draft.revise', call('PUT', `/api/enterprise/v1/drafts/${draftId}`, 'employee', { body: `修改 [1] ${status}`, expectedRevision: draft.draft.currentRevision })],
            ['draft.submit', call('POST', `/api/enterprise/v1/drafts/${draftId}/submit`, 'employee', { expectedRevision: draft.draft.currentRevision })],
            ['approval.decide', call('POST', `/api/enterprise/v1/approvals/${approvalId}/decision`, 'approver', { ...approvalConfirm, decision: 'approve' })],
            ['provider.upsert', call('PUT', '/api/enterprise/v1/models/providers', 'admin', { key: 'mock2', kind: 'mock', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 0 })],
          ];
          for (const [action, pending] of blocked) {
            const response = await pending;
            assert.deepEqual([response.status, response.data.error?.code], [402, 'ENTERPRISE_SUBSCRIPTION_INACTIVE'], action);
          }
          // 允許：讀取、匯出、取消、停權、改角色、通知
          assert.equal((await call('GET', `/api/enterprise/v1/drafts/${draftId}`, 'employee')).status, 200, 'read');
          assert.equal((await call('GET', `/api/enterprise/v1/drafts/${approvedDraftId}/export?format=markdown`, 'employee')).status, 200, 'export');
          assert.equal((await call('GET', '/api/enterprise/v1/notifications', 'employee')).status, 200, 'notifications');
          assert.equal((await call('PUT', `/api/enterprise/v1/members/${member.approver}/roles`, 'admin', { roles: ['approver'] })).status, 200, 'member.roles');
          await login('approver', 'approver@quota.example.invalid');
          if (status === 'expired') {
            // 到期後佇列中的 Run 不執行、不呼叫模型
            await worker.tick();
            const run = (await call('GET', `/api/enterprise/v1/runs/${queuedRun}`, 'admin')).data;
            assert.deepEqual([run.status, run.errorCode], ['failed', 'ENTERPRISE_SUBSCRIPTION_INACTIVE']);
          }
          const cancellable = (await admin.query("SELECT id FROM enterprise.runs WHERE organization_id=$1 AND status='queued' LIMIT 1", [organizationId])).rows[0];
          if (cancellable) assert.equal((await call('POST', `/api/enterprise/v1/runs/${cancellable.id}/cancel`, 'admin')).status, 200, 'run.cancel');
        } finally {
          if (status === 'none' && saved) {
            const row = saved;
            const columns = Object.keys(row);
            const placeholders = columns.map((_, index) => '$' + String(index + 1)).join(',');
            await admin.query(`INSERT INTO enterprise.subscriptions (${columns.join(',')}) VALUES (${placeholders})`, columns.map(column => row[column]));
          }
          await setStatus('active');
        }
      });
    }

    test('停權在到期時仍可執行（安全撤權）；續約後寫入恢復', async () => {
      await setStatus('expired');
      try {
        assert.equal((await call('POST', `/api/enterprise/v1/members/${member.approver}/disable`, 'admin')).status, 200);
      } finally {
        await setStatus('active');
      }
      assert.equal((await call('POST', `/api/enterprise/v1/members/${member.approver}/enable`, 'admin')).status, 200);
      assert.equal((await upload('employee', '續約後上傳')).status, 201);
      assert.equal((await runRequest('employee')).status, 202);
    });
  });
});
