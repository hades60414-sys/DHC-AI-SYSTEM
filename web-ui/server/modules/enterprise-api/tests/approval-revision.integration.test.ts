import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import express from 'express';
import { Pool, type PoolClient } from 'pg';

import { createEnterpriseRouter } from '@/modules/enterprise-api/enterprise.routes.js';
import {
  bootstrapEnterpriseOrganization, createEnterpriseRunWorker, createLocalDocumentBlobStore, runEnterpriseMigrations, setEnterpriseSubscriptionBySlug,
} from '@/modules/enterprise-persistence/index.js';

const database = process.env.E02A_TEST_DATABASE;
const PASSWORD = 'Synthetic-only-Passw0rd!';
const SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
const DRAFT_READ = 'FROM enterprise.drafts d WHERE d.organization_id=$1 AND d.id=$2';

/**
 * 可控 barrier 連線池：pauseNext() 後，第一個執行「讀草稿列」的查詢在查詢完成（若有列鎖則已持有）後暫停，直到 release()。
 * 其他查詢不受影響。release 另有逾時，修復後另一交易會在列鎖上等待，不能讓測試本身死鎖。
 */
function barrierPool(runtime: Pool) {
  let armed = false;
  let arrived!: () => void;
  let arrival = Promise.resolve();
  let release!: () => void;
  let gate = Promise.resolve();
  const wrap = (client: PoolClient) => new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== 'query') return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]) => {
        const result = await (target.query as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (armed && typeof args[0] === 'string' && args[0].includes(DRAFT_READ)) {
          armed = false;
          arrived();
          await gate;
        }
        return result;
      };
    },
  });
  const pool = new Proxy(runtime, {
    get(target, prop, receiver) {
      if (prop === 'connect') return async () => wrap(await target.connect());
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    pool,
    pauseNext() {
      armed = true;
      arrival = new Promise<void>(resolve => { arrived = resolve; });
      gate = new Promise<void>(resolve => { release = resolve; });
      return arrival;
    },
    release: () => release(),
  };
}

const settleWithin = <T>(promise: Promise<T>, ms: number) => Promise.race([promise.then(() => 'settled' as const), new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), ms))]);

/**
 * ASTRA-V3-NEW-001：改稿與送審必須原子化；待審、核准、匯出都綁同一個不可變修訂與內容 hash。
 * 兩種交錯（送審讀到舊版後改稿提交、改稿讀到舊狀態後送審提交）都不得產生「待審 revision ≠ current revision」的狀態。
 */
describe('ASTRA-V3-NEW-001 審批版號原子性（實際 PostgreSQL、確定性 barrier、完整 HTTP 路由）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 10 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  const barrier = barrierPool(runtime);
  const worker = createEnterpriseRunWorker(runtime, { secretKey: SECRET_KEY, timeoutMs: 10_000 });
  let server: http.Server;
  let fakeLlm: http.Server;
  let base = '';
  let blobRoot = '';
  const token: Record<string, string> = {};
  let keys = 0;

  async function call(method: string, route: string, who: string, json?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token[who]}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: json === undefined ? undefined : JSON.stringify(json) });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, headers: response.headers, data: (type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())) as any };
  }
  const login = async (who: string, email: string) => {
    token[who] = (await (await fetch(base + '/api/enterprise/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationSlug: 'kappa', email, password: PASSWORD }) })).json() as any).token;
  };
  async function freshDraft() {
    const started = await call('POST', '/api/enterprise/v1/runs/draft-generation', 'employee', { title: '版號測試', query: '交付期限', providerKey: 'local' },
      { 'idempotency-key': `rev-key-${(keys += 1).toString().padStart(4, '0')}` });
    assert.equal(started.status, 202);
    await worker.tick();
    const run = (await call('GET', `/api/enterprise/v1/runs/${started.data.run.id}`, 'employee')).data;
    assert.equal(run.status, 'succeeded');
    return run.draftId as string;
  }
  const draftOf = async (draftId: string) => (await call('GET', `/api/enterprise/v1/drafts/${draftId}`, 'employee')).data;
  const revise = (draftId: string, expectedRevision: number, body: string) => call('PUT', `/api/enterprise/v1/drafts/${draftId}`, 'employee', { body, expectedRevision });
  const submit = (draftId: string, expectedRevision: number) => call('POST', `/api/enterprise/v1/drafts/${draftId}/submit`, 'employee', { expectedRevision });
  /** 不變量：待審 approval 的修訂必須等於 draft 的 current revision；狀態 submitted 時一定有且只有一筆 pending。 */
  async function invariant(draftId: string) {
    const row = (await admin.query(`SELECT d.status, d.current_revision AS current, a.revision AS pending
      FROM enterprise.drafts d LEFT JOIN enterprise.approvals a ON (a.organization_id,a.draft_id)=(d.organization_id,d.id) AND a.status='pending'
      WHERE d.id=$1`, [draftId])).rows[0];
    if (row.pending !== null) assert.equal(row.pending, row.current, `pending approval revision ${row.pending} != current ${row.current}（status ${row.status}）`);
    assert.equal(row.status === 'submitted', row.pending !== null, `status ${row.status} 與 pending ${row.pending} 不一致`);
    return row;
  }

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    await bootstrapEnterpriseOrganization(migrator, { slug: 'kappa', name: 'kappa', adminEmail: 'admin@kappa.example.invalid', adminPassword: PASSWORD });
    await setEnterpriseSubscriptionBySlug(migrator, { slug: 'kappa', planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    const llm = express();
    llm.use(express.json());
    llm.post('/v1/chat/completions', (_req, res) => { res.json({ choices: [{ message: { content: '依來源 [1]，交付期限 2/28。' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }); });
    fakeLlm = http.createServer(llm);
    await new Promise<void>(resolve => fakeLlm.listen(0, '127.0.0.1', resolve));
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-rev-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: barrier.pool, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024, secretKey: SECRET_KEY }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await login('admin', 'admin@kappa.example.invalid');
    for (const [name, roles] of [['approver', ['approver']], ['employee', ['employee']]] as const) {
      assert.equal((await call('POST', '/api/enterprise/v1/members', 'admin', { email: `${name}@kappa.example.invalid`, password: PASSWORD, roles })).status, 201);
      await login(name, `${name}@kappa.example.invalid`);
    }
    const llmUrl = `http://127.0.0.1:${(fakeLlm.address() as AddressInfo).port}/v1`;
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { key: 'local', kind: 'openai_compatible', baseUrl: llmUrl, model: 'synthetic', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 10_000_000 })).status, 200);
    const uploaded = await fetch(base + '/api/enterprise/v1/documents', { method: 'POST', body: Buffer.from('合成卡帕專案 交付期限 2/28'),
      headers: { authorization: `Bearer ${token.employee}`, 'content-type': 'text/plain', 'x-dhc-title': encodeURIComponent('卡帕專案'), 'x-dhc-filename': 'k.txt' } });
    assert.equal(uploaded.status, 201);
  });
  after(async () => {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => fakeLlm.close(resolve))]);
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('交錯一：送審先讀到 rev1 → 改稿提交 rev2 → 送審繼續：不得產生綁 rev1 的待審', async () => {
    const draftId = await freshDraft();
    const paused = barrier.pauseNext();
    const submitting = submit(draftId, 1);
    await paused;
    const revising = revise(draftId, 1, '依來源 [1]，交付期限改為 3/15。');
    const reviseState = await settleWithin(revising, 1500);
    barrier.release();
    const [submitted, revised] = await Promise.all([submitting, revising]);
    const row = await invariant(draftId);
    // 修復後：送審持有草稿列鎖，改稿等待後看到 submitted → 409；或改稿先完成、送審以 expectedRevision 1 被拒。只能一方成功。
    assert.equal([submitted.status, revised.status].filter(status => status < 300).length, 1, `submit ${submitted.status} revise ${revised.status}（改稿 ${reviseState}）`);
    if (submitted.status === 201) {
      assert.deepEqual([revised.status, revised.data.error?.code], [409, 'ENTERPRISE_DRAFT_LOCKED']);
      assert.deepEqual([row.status, row.current, row.pending], ['submitted', 1, 1]);
    }
  });

  test('交錯二：改稿先讀到 draft/rev1 → 送審提交 → 改稿繼續：不得把待審草稿改成 rev2', async () => {
    const draftId = await freshDraft();
    const paused = barrier.pauseNext();
    const revising = revise(draftId, 1, '依來源 [1]，交付期限改為 4/1。');
    await paused;
    const submitting = submit(draftId, 1);
    const submitState = await settleWithin(submitting, 1500);
    barrier.release();
    const [revised, submitted] = await Promise.all([revising, submitting]);
    const row = await invariant(draftId);
    assert.equal([submitted.status, revised.status].filter(status => status < 300).length, 1, `submit ${submitted.status} revise ${revised.status}（送審 ${submitState}）`);
    if (revised.status === 200) {
      assert.deepEqual([submitted.status, submitted.data.error?.code], [409, 'ENTERPRISE_VERSION_CONFLICT']);
      assert.deepEqual([row.status, row.current, row.pending], ['draft', 2, null]);
    }
  });

  test('送審必須指定 expectedRevision，舊版號被拒（409）', async () => {
    const draftId = await freshDraft();
    assert.equal((await revise(draftId, 1, '依來源 [1]，第二版。')).status, 200);
    const missing = await call('POST', `/api/enterprise/v1/drafts/${draftId}/submit`, 'employee');
    assert.deepEqual([missing.status, missing.data.error?.code], [409, 'ENTERPRISE_VERSION_CONFLICT']);
    const stale = await submit(draftId, 1);
    assert.deepEqual([stale.status, stale.data.error?.code], [409, 'ENTERPRISE_VERSION_CONFLICT']);
    await invariant(draftId);
  });

  test('審批端點回傳綁定的修訂內容與 hash；核准必須確認同一版號與 hash；匯出綁同一 approval', async () => {
    const draftId = await freshDraft();
    assert.equal((await revise(draftId, 1, '依來源 [1]，交付期限 5/5。')).status, 200);
    const submitted = await submit(draftId, 2);
    assert.equal(submitted.status, 201);
    assert.equal(submitted.data.revision, 2);
    assert.match(submitted.data.revisionSha256, /^[0-9a-f]{64}$/);
    const pending = (await call('GET', '/api/enterprise/v1/approvals', 'approver')).data.items.find((item: any) => item.id === submitted.data.approvalId);
    assert.deepEqual([pending.revision, pending.revisionSha256], [2, submitted.data.revisionSha256]);
    const detail = await call('GET', `/api/enterprise/v1/approvals/${submitted.data.approvalId}`, 'approver');
    assert.equal(detail.status, 200);
    assert.equal(detail.data.revision.revision, 2);
    assert.equal(detail.data.revision.body, '依來源 [1]，交付期限 5/5。');
    assert.equal(detail.data.approval.revisionSha256, submitted.data.revisionSha256);
    assert.equal(detail.data.revision.citationStatus, 'VALID');
    // 伺服器端 hash 可由回傳內容重算（body + 引用 metadata 的正規化 JSON）
    const recomputed = createHash('sha256').update(JSON.stringify({ body: detail.data.revision.body, citations: detail.data.revision.citations })).digest('hex');
    assert.equal(recomputed, submitted.data.revisionSha256);

    const noVersion = await call('POST', `/api/enterprise/v1/approvals/${submitted.data.approvalId}/decision`, 'approver', { decision: 'approve' });
    assert.deepEqual([noVersion.status, noVersion.data.error?.code], [409, 'ENTERPRISE_APPROVAL_STALE']);
    const wrongVersion = await call('POST', `/api/enterprise/v1/approvals/${submitted.data.approvalId}/decision`, 'approver', { decision: 'approve', expectedRevision: 1, expectedSha256: submitted.data.revisionSha256 });
    assert.deepEqual([wrongVersion.status, wrongVersion.data.error?.code], [409, 'ENTERPRISE_APPROVAL_STALE']);
    const wrongHash = await call('POST', `/api/enterprise/v1/approvals/${submitted.data.approvalId}/decision`, 'approver', { decision: 'approve', expectedRevision: 2, expectedSha256: '0'.repeat(64) });
    assert.deepEqual([wrongHash.status, wrongHash.data.error?.code], [409, 'ENTERPRISE_APPROVAL_STALE']);
    const decided = await call('POST', `/api/enterprise/v1/approvals/${submitted.data.approvalId}/decision`, 'approver', { decision: 'approve', expectedRevision: 2, expectedSha256: submitted.data.revisionSha256 });
    assert.deepEqual([decided.status, decided.data.status, decided.data.revision], [200, 'approved', 2]);
    const replay = await call('POST', `/api/enterprise/v1/approvals/${submitted.data.approvalId}/decision`, 'approver', { decision: 'approve', expectedRevision: 2, expectedSha256: submitted.data.revisionSha256 });
    assert.deepEqual([replay.status, replay.data.error?.code], [409, 'ENTERPRISE_APPROVAL_ALREADY_DECIDED']);

    const exported = await call('GET', `/api/enterprise/v1/drafts/${draftId}/export?format=markdown`, 'employee');
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get('x-dhc-approved-revision'), '2');
    assert.equal(exported.headers.get('x-dhc-approval-id'), submitted.data.approvalId);
    assert.match(exported.data.toString('utf8'), /交付期限 5\/5/);
    const record = (await admin.query('SELECT revision, approval_id AS "approvalId", sha256 FROM enterprise.draft_exports WHERE draft_id=$1', [draftId])).rows;
    assert.deepEqual(record.map(item => [item.revision, item.approvalId]), [[2, submitted.data.approvalId]]);
    assert.equal(record[0].sha256, exported.headers.get('x-dhc-content-sha256'));
  });

  test('作者不能自批；退回後改稿再送審為新 approval，舊 approval 不能被重用', async () => {
    const draftId = await freshDraft();
    const first = await submit(draftId, 1);
    assert.equal(first.status, 201);
    const self = await call('POST', `/api/enterprise/v1/approvals/${first.data.approvalId}/decision`, 'employee', { decision: 'approve', expectedRevision: 1, expectedSha256: first.data.revisionSha256 });
    assert.equal(self.status, 403);
    const rejected = await call('POST', `/api/enterprise/v1/approvals/${first.data.approvalId}/decision`, 'approver', { decision: 'reject', comment: '請補充', expectedRevision: 1, expectedSha256: first.data.revisionSha256 });
    assert.equal(rejected.status, 200);
    assert.equal((await revise(draftId, 1, '依來源 [1]，已補充。')).status, 200);
    const second = await submit(draftId, 2);
    assert.equal(second.status, 201);
    assert.notEqual(second.data.approvalId, first.data.approvalId);
    const reuse = await call('POST', `/api/enterprise/v1/approvals/${first.data.approvalId}/decision`, 'approver', { decision: 'approve', expectedRevision: 1, expectedSha256: first.data.revisionSha256 });
    assert.deepEqual([reuse.status, reuse.data.error?.code], [409, 'ENTERPRISE_APPROVAL_ALREADY_DECIDED']);
    await invariant(draftId);
  });

  test('送審後來源失效：審批端點顯示 INVALID，核准被拒', async () => {
    const draftId = await freshDraft();
    const submitted = await submit(draftId, 1);
    assert.equal(submitted.status, 201);
    const original = (await admin.query("SELECT id, text FROM enterprise.document_chunks WHERE organization_id=(SELECT organization_id FROM enterprise.drafts WHERE id=$1)", [draftId])).rows;
    await admin.query('ALTER TABLE enterprise.document_chunks NO FORCE ROW LEVEL SECURITY');
    await admin.query("UPDATE enterprise.document_chunks SET text = text || '（竄改）' WHERE organization_id=(SELECT organization_id FROM enterprise.drafts WHERE id=$1)", [draftId]);
    try {
      const detail = await call('GET', `/api/enterprise/v1/approvals/${submitted.data.approvalId}`, 'approver');
      assert.equal(detail.data.revision.citationStatus, 'INVALID');
      const decided = await call('POST', `/api/enterprise/v1/approvals/${submitted.data.approvalId}/decision`, 'approver', { decision: 'approve', expectedRevision: 1, expectedSha256: submitted.data.revisionSha256 });
      assert.deepEqual([decided.status, decided.data.error?.code], [409, 'ENTERPRISE_CITATION_INVALID']);
    } finally {
      for (const chunk of original) await admin.query('UPDATE enterprise.document_chunks SET text=$2 WHERE id=$1', [chunk.id, chunk.text]);
      await admin.query('ALTER TABLE enterprise.document_chunks FORCE ROW LEVEL SECURITY');
    }
  });
});
