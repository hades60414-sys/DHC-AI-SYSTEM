import assert from 'node:assert/strict';
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
  bootstrapEnterpriseOrganization, createEnterpriseRunWorker, createLocalDocumentBlobStore, runEnterpriseMigrations, setEnterpriseSubscriptionBySlug,
} from '@/modules/enterprise-persistence/index.js';

const database = process.env.E02A_TEST_DATABASE;
const PASSWORD = 'Synthetic-only-Passw0rd!';
const SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
const MODEL_TEXT = '依來源 [1]，合成丙專案交付期限為 1/15。';

/**
 * ASTRA-004 / DEC-RUN-01：Run 綁定申請者建立當下的 auth_epoch。
 * 模型呼叫「進行中」申請者被降權／停權 → 結果不發布，存成 QUARANTINED；通知審查者與管理員，提醒申請者這是需授權的硬邊界；
 * 只有管理員（且不是申請者本人）可在重新驗證申請者目前權限後放行；重新啟用帳號不會復活舊 Run。
 */
describe('ASTRA-004 Run 撤權隔離（實際 PostgreSQL、loopback 假模型）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 8 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  const worker = createEnterpriseRunWorker(runtime, { secretKey: SECRET_KEY, timeoutMs: 10_000 });
  let server: http.Server;
  let fakeLlm: http.Server;
  let base = '';
  let blobRoot = '';
  let llmCalls = 0;
  // 閘門：測試可讓假模型收到請求後暫停，等測試改完權限再放行
  let hold = false;
  let arrived: (() => void) | null = null;
  let release: (() => void) | null = null;
  const token: Record<string, string> = {};
  const member: Record<string, string> = {};
  const email: Record<string, string> = {};

  async function call(method: string, route: string, who: string, json?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token[who]}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: json === undefined ? undefined : JSON.stringify(json) });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, data: (type.includes('json') ? await response.json() : await response.text()) as any };
  }
  const login = async (who: string) => {
    token[who] = (await (await fetch(base + '/api/enterprise/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationSlug: 'gamma', email: email[who], password: PASSWORD }) })).json() as any).token;
  };
  let keys = 0;
  const startRun = async (who: string) => (await call('POST', '/api/enterprise/v1/runs/draft-generation', who, { title: '隔離測試', query: '交付期限', providerKey: 'local' },
    { 'idempotency-key': `revoke-key-${(keys += 1).toString().padStart(4, '0')}` })).data.run.id as string;
  const runOf = async (id: string) => (await call('GET', `/api/enterprise/v1/runs/${id}`, 'admin')).data;
  const setRoles = (who: string, roles: string[]) => call('PUT', `/api/enterprise/v1/members/${member[who]}/roles`, 'admin', { roles });

  /** 在模型呼叫進行中執行 during()，再放行模型回覆，等 worker 完成。 */
  async function duringModelCall(during: () => Promise<unknown>) {
    hold = true;
    const reached = new Promise<void>(resolve => { arrived = resolve; });
    const ticking = worker.tick();
    await reached;
    await during();
    release!();
    hold = false;
    return ticking;
  }

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    await bootstrapEnterpriseOrganization(migrator, { slug: 'gamma', name: 'gamma', adminEmail: 'admin@gamma.example.invalid', adminPassword: PASSWORD });
    await setEnterpriseSubscriptionBySlug(migrator, { slug: 'gamma', planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    const llm = express();
    llm.use(express.json());
    llm.post('/v1/chat/completions', async (_req, res) => {
      llmCalls += 1;
      if (hold) {
        const gate = new Promise<void>(resolve => { release = resolve; });
        arrived?.();
        await gate;
      }
      res.json({ choices: [{ message: { content: MODEL_TEXT } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    });
    fakeLlm = http.createServer(llm);
    await new Promise<void>(resolve => fakeLlm.listen(0, '127.0.0.1', resolve));
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-revoke-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: runtime, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024, secretKey: SECRET_KEY }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    email.admin = 'admin@gamma.example.invalid';
    await login('admin');
    for (const [name, roles] of [['admin2', ['org_admin']], ['approver', ['approver']], ['employee', ['employee']]] as const) {
      email[name] = `${name}@gamma.example.invalid`;
      member[name] = (await call('POST', '/api/enterprise/v1/members', 'admin', { email: email[name], password: PASSWORD, roles })).data.id;
      await login(name);
    }
    member.admin = (await call('GET', '/api/enterprise/v1/identity/me', 'admin')).data.memberId;
    const llmUrl = `http://127.0.0.1:${(fakeLlm.address() as AddressInfo).port}/v1`;
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { key: 'local', kind: 'openai_compatible', baseUrl: llmUrl, model: 'synthetic', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 10_000_000 })).status, 200);
    const upload = await fetch(base + '/api/enterprise/v1/documents', { method: 'POST', body: Buffer.from('合成丙專案 交付期限 1/15'),
      headers: { authorization: `Bearer ${token.employee}`, 'content-type': 'text/plain', 'x-dhc-title': encodeURIComponent('丙專案'), 'x-dhc-filename': 'c.txt' } });
    assert.equal(upload.status, 201);
  });
  after(async () => {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => fakeLlm.close(resolve))]);
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  async function assertNotPublished(runId: string) {
    const run = await runOf(runId);
    assert.equal(run.status, 'quarantined');
    assert.equal(run.errorCode, 'ENTERPRISE_PRINCIPAL_REVOKED');
    const revisions = await admin.query('SELECT count(*)::int AS n FROM enterprise.draft_revisions WHERE draft_id=$1', [run.draftId]);
    assert.equal(revisions.rows[0].n, 0, '隔離結果不得進入草稿修訂');
    const draft = await call('GET', `/api/enterprise/v1/drafts/${run.draftId}`, 'admin');
    assert.equal(draft.data.draft.status, 'quarantined');
    assert.equal(draft.data.revision ?? null, null);
    assert.notEqual((await call('GET', `/api/enterprise/v1/drafts/${run.draftId}/export?format=docx`, 'admin')).status, 200, '隔離結果不得匯出');
    assert.notEqual((await call('POST', `/api/enterprise/v1/drafts/${run.draftId}/submit`, 'admin')).status, 201, '隔離結果不得送審');
    return run;
  }

  test('模型呼叫進行中降權為 auditor：不發布，存 QUARANTINED；通知審查者、管理員與申請者', async () => {
    const runId = await startRun('employee');
    await duringModelCall(async () => {
      assert.equal((await setRoles('employee', ['auditor'])).status, 200);
      assert.equal((await call('GET', '/api/enterprise/v1/identity/me', 'employee')).status, 401);
    });
    await assertNotPublished(runId);
    const usage = await admin.query("SELECT status FROM enterprise.model_usage WHERE run_id=$1", [runId]);
    assert.deepEqual(usage.rows.map(row => row.status), ['succeeded'], '已發生的模型用量仍記帳');
    const audits = await admin.query("SELECT action FROM enterprise.audit_events WHERE resource_id=$1 ORDER BY occurred_at", [runId]);
    assert.ok(audits.rows.some(row => row.action === 'run.quarantined'));
    await login('employee');
    const mine = (await call('GET', '/api/enterprise/v1/notifications', 'employee')).data.items.filter((n: any) => n.subjectId === runId);
    assert.equal(mine.length, 1);
    assert.match(mine[0].message, /硬邊界/);
    assert.ok(!JSON.stringify(mine).includes('交付期限為'), '通知不含模型內容');
    const approverInbox = (await call('GET', '/api/enterprise/v1/notifications', 'approver')).data.items.filter((n: any) => n.subjectId === runId);
    const adminInbox = (await call('GET', '/api/enterprise/v1/notifications', 'admin')).data.items.filter((n: any) => n.subjectId === runId);
    assert.equal(approverInbox.length, 1, '具 approvals.decide 的審查者收到通知');
    assert.equal(adminInbox.length, 1, '管理員收到 org_admin 角色通知（可放行）');
    // 隔離內容只給管理員看
    assert.equal((await call('GET', `/api/enterprise/v1/runs/${runId}/quarantine`, 'approver')).status, 403);
    const held = await call('GET', `/api/enterprise/v1/runs/${runId}/quarantine`, 'admin');
    assert.deepEqual([held.status, held.data.status, held.data.body], [200, 'held', MODEL_TEXT]);
    // 放行：申請者目前是 auditor（無 tasks.write）→ 拒絕
    const refused = await call('POST', `/api/enterprise/v1/runs/${runId}/quarantine/release`, 'admin');
    assert.deepEqual([refused.status, refused.data.error.code], [409, 'ENTERPRISE_PRINCIPAL_REVOKED']);
    assert.equal((await runOf(runId)).status, 'quarantined');
    // 恢復員工角色後由管理員放行 → 草稿 revision 1、Run succeeded、通知申請者
    assert.equal((await setRoles('employee', ['employee'])).status, 200);
    await login('employee');
    assert.equal((await call('POST', `/api/enterprise/v1/runs/${runId}/quarantine/release`, 'approver')).status, 403, '審查者預設不能放行');
    const released = await call('POST', `/api/enterprise/v1/runs/${runId}/quarantine/release`, 'admin');
    assert.equal(released.status, 200);
    const run = await runOf(runId);
    assert.equal(run.status, 'succeeded');
    const draft = await call('GET', `/api/enterprise/v1/drafts/${run.draftId}`, 'employee');
    assert.deepEqual([draft.data.draft.status, draft.data.revision.revision, draft.data.revision.body], ['draft', 1, MODEL_TEXT]);
    assert.equal((await call('POST', `/api/enterprise/v1/runs/${runId}/quarantine/release`, 'admin')).status, 409, '只能放行一次');
    const releaseAudit = await admin.query("SELECT actor_member_id FROM enterprise.audit_events WHERE resource_id=$1 AND action='run.quarantine_released'", [runId]);
    assert.deepEqual(releaseAudit.rows.map(row => row.actor_member_id), [member.admin]);
  });

  test('模型呼叫進行中停權：隔離；重新啟用帳號不會復活舊 Run；管理員可丟棄並清除內容', async () => {
    const runId = await startRun('employee');
    await duringModelCall(async () => {
      assert.equal((await call('POST', `/api/enterprise/v1/members/${member.employee}/disable`, 'admin')).status, 200);
    });
    await assertNotPublished(runId);
    assert.equal((await call('POST', `/api/enterprise/v1/members/${member.employee}/enable`, 'admin')).status, 200);
    await login('employee');
    assert.equal((await worker.tick()), 0, '沒有可再執行的 Run');
    await assertNotPublished(runId);
    const discarded = await call('POST', `/api/enterprise/v1/runs/${runId}/quarantine/discard`, 'admin');
    assert.equal(discarded.status, 200);
    const row = await admin.query('SELECT status, body FROM enterprise.run_quarantine WHERE run_id=$1', [runId]);
    assert.deepEqual(row.rows[0], { status: 'discarded', body: null });
    assert.equal((await runOf(runId)).status, 'failed');
    assert.equal((await call('POST', `/api/enterprise/v1/runs/${runId}/quarantine/release`, 'admin')).status, 409);
  });

  test('管理員自己的 Run 被另一位管理員降權後，本人不能放行自己的隔離結果', async () => {
    const runId = await startRun('admin2');
    await duringModelCall(async () => {
      assert.equal((await setRoles('admin2', ['org_admin', 'auditor'])).status, 200, '角色變更（即使仍保有權限）也使 epoch 失效');
    });
    await assertNotPublished(runId);
    await login('admin2');
    assert.equal((await call('POST', `/api/enterprise/v1/runs/${runId}/quarantine/release`, 'admin2')).status, 403, '放行者不得為申請者');
    assert.equal((await call('POST', `/api/enterprise/v1/runs/${runId}/quarantine/release`, 'admin')).status, 200);
  });

  test('排隊中就被改角色：不呼叫模型、直接失敗（不進隔離）', async () => {
    const before = llmCalls;
    const runId = await startRun('employee');
    assert.equal((await setRoles('employee', ['approver'])).status, 200);
    await worker.tick();
    const run = await runOf(runId);
    assert.deepEqual([run.status, run.errorCode], ['failed', 'ENTERPRISE_PRINCIPAL_REVOKED']);
    assert.equal(llmCalls, before);
    assert.equal((await setRoles('employee', ['employee'])).status, 200);
    await login('employee');
  });

  test('舊 session（epoch 已變）不能建立 Run；正常 Run 仍成功；取消仍有效', async () => {
    const stale = token.employee;
    assert.equal((await setRoles('employee', ['employee'])).status, 200);
    token.stale = stale;
    assert.equal((await call('POST', '/api/enterprise/v1/runs/draft-generation', 'stale', { title: 't', query: '交付期限', providerKey: 'local' }, { 'idempotency-key': 'stale-key-0001' })).status, 401);
    await login('employee');
    const ok = await startRun('employee');
    await worker.tick();
    assert.equal((await runOf(ok)).status, 'succeeded');
    const cancelled = await startRun('employee');
    assert.equal((await call('POST', `/api/enterprise/v1/runs/${cancelled}/cancel`, 'employee')).status, 200);
    await worker.tick();
    assert.equal((await runOf(cancelled)).status, 'cancelled');
  });
});
