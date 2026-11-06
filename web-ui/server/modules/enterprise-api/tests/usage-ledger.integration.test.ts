import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import express from 'express';
import { Pool } from 'pg';

import { createEnterpriseRouter } from '@/modules/enterprise-api/enterprise.routes.js';
import {
  bootstrapEnterpriseOrganization, createEnterpriseRunWorker, createLocalDocumentBlobStore, runEnterpriseMigrations, setEnterpriseSubscriptionBySlug,
} from '@/modules/enterprise-persistence/index.js';

const database = process.env.E02A_TEST_DATABASE;
const PASSWORD = 'Synthetic-only-Passw0rd!';
type Mode = 'ok' | 'no-usage' | 'hang' | 'drop' | 'http400' | 'http503';

/**
 * ASTRA-008：attempt 級用量帳。每次 HTTP 呼叫一筆（先預留、後結算），保存價格快照；
 * 逾時／斷線／回應不完整＝unknown（成本 NULL、預留額度持續計入預算），不記成 0；
 * 預算以「最壞情況預留」在 provider 鎖下檢查，並行時最後一份額度只有一個 Run 拿到；崩潰留下的預留會轉成 unknown；
 * 管理員對帳後才 final。全部以 loopback 假 provider 執行，不呼叫付費 API。
 */
describe('ASTRA-008 用量帳與預算（實際 PostgreSQL、loopback 假 provider）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 12 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  const worker = createEnterpriseRunWorker(runtime, { timeoutMs: 300 });
  const worker2 = createEnterpriseRunWorker(runtime, { timeoutMs: 300 });
  let server: http.Server;
  let fakeLlm: http.Server;
  let base = '';
  let blobRoot = '';
  let llmUrl = '';
  let mode: Mode = 'ok';
  let calls = 0;
  const token: Record<string, string> = {};

  async function call(method: string, route: string, who: string, json?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token[who]}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: json === undefined ? undefined : JSON.stringify(json) });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, data: (type.includes('json') ? await response.json() : await response.text()) as any };
  }
  const login = async (who: string, email: string) => {
    token[who] = (await (await fetch(base + '/api/enterprise/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationSlug: 'ledger', email, password: PASSWORD }) })).json() as any).token;
  };
  const provider = (key: string, extra: Record<string, unknown> = {}) => call('PUT', '/api/enterprise/v1/models/providers', 'admin', {
    key, kind: 'openai_compatible', baseUrl: llmUrl, model: 'synthetic', deployment: 'LOCAL_ONLY', inputPriceMicrosPerMtok: 1_000_000, outputPriceMicrosPerMtok: 2_000_000,
    monthlyBudgetMicros: 100_000_000, priceSource: '合成價目表 2026-11', ...extra });
  let keys = 0;
  const startRun = async (providerKey: string) => (await call('POST', '/api/enterprise/v1/runs/draft-generation', 'employee', { title: '帳務', query: '交付期限', providerKey },
    { 'idempotency-key': `ledger-key-${(keys += 1).toString().padStart(4, '0')}` })).data.run.id as string;
  const attempts = async (runId: string) => (await admin.query(`SELECT status, run_attempt, input_tokens, output_tokens, cost_micros::text AS cost, reserved_micros::text AS reserved,
      usage_source, reconciled_state, price_version, price_source, input_price_micros_per_mtok::text AS "inPrice", error_code
    FROM enterprise.model_usage WHERE run_id=$1 ORDER BY created_at, run_attempt`, [runId])).rows;
  const runOf = async (id: string) => (await call('GET', `/api/enterprise/v1/runs/${id}`, 'admin')).data;
  /** worker 依建立時間處理；每個情境前先以 ok 模式清空佇列，確保下一次 tick 處理的是目標 Run。 */
  async function drain() {
    const saved = mode;
    mode = 'ok';
    for (let i = 0; i < 20 && (await worker.tick()) > 0; i += 1) { /* 清空 */ }
    mode = saved;
  }

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    await bootstrapEnterpriseOrganization(migrator, { slug: 'ledger', name: 'ledger', adminEmail: 'admin@ledger.example.invalid', adminPassword: PASSWORD });
    await setEnterpriseSubscriptionBySlug(migrator, { slug: 'ledger', planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    const llm = express();
    llm.use(express.json());
    llm.post('/v1/chat/completions', (req, res) => {
      calls += 1;
      if (mode === 'hang') return; // 不回應，讓 worker 逾時
      if (mode === 'drop') { req.socket.destroy(); return; }
      if (mode === 'http400') return res.status(400).json({ error: 'bad' });
      if (mode === 'http503') return res.status(503).json({ error: 'busy' });
      res.json({ choices: [{ message: { content: '依來源 [1]，交付期限 3/3。' } }], ...(mode === 'ok' ? { usage: { prompt_tokens: 1000, completion_tokens: 200 } } : {}) });
    });
    fakeLlm = http.createServer(llm);
    await new Promise<void>(resolve => fakeLlm.listen(0, '127.0.0.1', resolve));
    llmUrl = `http://127.0.0.1:${(fakeLlm.address() as AddressInfo).port}/v1`;
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-ledger-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: runtime, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024 }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await login('admin', 'admin@ledger.example.invalid');
    assert.equal((await call('POST', '/api/enterprise/v1/members', 'admin', { email: 'employee@ledger.example.invalid', password: PASSWORD, roles: ['employee'] })).status, 201);
    await login('employee', 'employee@ledger.example.invalid');
    assert.equal((await provider('llm')).status, 200);
    const upload = await fetch(base + '/api/enterprise/v1/documents', { method: 'POST', body: Buffer.from('合成戊專案 交付期限 3/3'),
      headers: { authorization: `Bearer ${token.employee}`, 'content-type': 'text/plain', 'x-dhc-title': encodeURIComponent('戊專案'), 'x-dhc-filename': 'l.txt' } });
    assert.equal(upload.status, 201);
  });
  after(async () => {
    fakeLlm.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => fakeLlm.close(resolve))]);
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });
  beforeEach(() => { mode = 'ok'; calls = 0; });

  test('成功且 provider 回報用量：final 成本＝快照價格計算；保存價格版本與來源；預留不再計入', async () => {
    const runId = await startRun('llm');
    await worker.tick();
    assert.equal((await runOf(runId)).status, 'succeeded');
    const rows = await attempts(runId);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].status, rows[0].run_attempt, rows[0].cost, rows[0].usage_source, rows[0].reconciled_state, rows[0].price_version, rows[0].price_source, rows[0].inPrice],
      ['succeeded', 1, String(1000 * 1 + 200 * 2), 'provider_reported', 'final', 1, '合成價目表 2026-11', '1000000']);
    assert.ok(Number(rows[0].reserved) >= 1400, '預留為最壞情況上界');
  });

  test('改價格：provider price_version +1；新呼叫用新快照，舊紀錄不變', async () => {
    const before = await startRun('llm');
    await worker.tick();
    assert.equal((await provider('llm', { inputPriceMicrosPerMtok: 3_000_000, priceSource: '合成價目表 2026-12' })).data.priceVersion, 2);
    const afterRun = await startRun('llm');
    await worker.tick();
    const [old] = await attempts(before);
    const [fresh] = await attempts(afterRun);
    assert.deepEqual([old.price_version, old.cost], [1, '1400']);
    assert.deepEqual([fresh.price_version, fresh.cost, fresh.price_source], [2, String(1000 * 3 + 200 * 2), '合成價目表 2026-12']);
    assert.equal((await provider('llm', { inputPriceMicrosPerMtok: 3_000_000, priceSource: '合成價目表 2026-12' })).data.priceVersion, 2, '價格沒變不升版');
    await provider('llm');
  });

  test('成功但沒有回報用量：以上界估算、非零、標記待對帳', async () => {
    mode = 'no-usage';
    const runId = await startRun('llm');
    await worker.tick();
    const [row] = await attempts(runId);
    assert.deepEqual([row.status, row.usage_source, row.reconciled_state], ['succeeded', 'estimated', 'pending_reconciliation']);
    assert.ok(Number(row.cost) > 0);
  });

  test('逾時：attempt 記為 unknown（成本 NULL、預留仍計入預算），重試成功另記一筆；每次 HTTP 呼叫恰好一筆', async () => {
    await drain();
    mode = 'hang';
    const runId = await startRun('llm');
    await worker.tick();
    assert.equal((await runOf(runId)).status, 'queued');
    mode = 'ok';
    await worker.tick();
    assert.equal((await runOf(runId)).status, 'succeeded');
    const rows = await attempts(runId);
    assert.deepEqual(rows.map(row => [row.status, row.run_attempt, row.cost, row.reconciled_state]),
      [['unknown', 1, null, 'pending_reconciliation'], ['succeeded', 2, '1400', 'final']]);
    assert.equal(calls, 2, '沒有隱藏的 gateway 內部重試');
    const usage = (await call('GET', '/api/enterprise/v1/usage', 'admin')).data.items.find((item: any) => item.key === 'llm');
    assert.ok(Number(usage.unknownOrReservedMicros) >= Number(rows[0].reserved));
    assert.ok(usage.pendingReconciliation >= 1);
  });

  test('送出後連線被切斷：unknown；HTTP 400：failed、0、final、不重試；503：可重試', async () => {
    await drain();
    mode = 'drop';
    const dropped = await startRun('llm');
    await worker.tick();
    assert.deepEqual((await attempts(dropped)).map(row => [row.status, row.error_code]), [['unknown', 'ENTERPRISE_PROVIDER_CONNECTION_LOST']]);
    await drain();
    mode = 'http400';
    const bad = await startRun('llm');
    await worker.tick();
    assert.equal((await runOf(bad)).status, 'failed');
    assert.deepEqual((await attempts(bad)).map(row => [row.status, row.cost, row.reconciled_state]), [['failed', '0', 'final']]);
    await drain();
    mode = 'http503';
    const busy = await startRun('llm');
    await worker.tick();
    assert.equal((await runOf(busy)).status, 'queued');
    await drain();
  });

  test('連不上（未送出）：failed、0、final', async () => {
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { key: 'down', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'x',
      deployment: 'LOCAL_ONLY', inputPriceMicrosPerMtok: 1_000_000, monthlyBudgetMicros: 100_000_000 })).status, 200);
    await drain();
    const runId = await startRun('down');
    await worker.tick();
    assert.deepEqual((await attempts(runId)).map(row => [row.status, row.cost, row.reconciled_state, row.error_code]), [['failed', '0', 'final', 'ENTERPRISE_PROVIDER_UNREACHABLE']]);
  });

  test('預算最後額度：兩個 worker 並行，只有一個 Run 拿到預留；未知消耗以預留額度計入', async () => {
    assert.equal((await provider('tight', { monthlyBudgetMicros: 1 })).status, 200);
    await drain();
    const probe = await startRun('tight');
    await worker.tick();
    const [denied] = await attempts(probe);
    assert.equal(denied.status, 'denied');
    const reserve = Number(denied.reserved);
    assert.ok(reserve > 0);
    // 預算剛好容納一份預留
    assert.equal((await provider('tight', { monthlyBudgetMicros: reserve + Math.floor(reserve / 2) })).status, 200);
    mode = 'hang';
    const a = await startRun('tight');
    const b = await startRun('tight');
    await Promise.all([worker.tick(), worker2.tick()]);
    const rows = [...await attempts(a), ...await attempts(b)];
    assert.deepEqual(rows.map(row => row.status).sort(), ['denied', 'unknown']);
    const states = [(await runOf(a)), (await runOf(b))].map(run => run.errorCode).sort();
    assert.deepEqual(states, ['ENTERPRISE_BUDGET_EXCEEDED', 'ENTERPRISE_PROVIDER_TIMEOUT']);
  });

  test('worker 崩潰留下的 reserved：逾時清理轉為 unknown（不是 0）', async () => {
    const providerId = (await admin.query("SELECT id FROM enterprise.model_providers WHERE key='llm'")).rows[0].id;
    const orgId = (await admin.query("SELECT id FROM enterprise.organizations WHERE slug='ledger'")).rows[0].id;
    const memberId = (await admin.query("SELECT id FROM enterprise.org_members WHERE organization_id=$1 LIMIT 1", [orgId])).rows[0].id;
    await admin.query('ALTER TABLE enterprise.model_usage NO FORCE ROW LEVEL SECURITY');
    let id = '';
    try {
      id = (await admin.query(`INSERT INTO enterprise.model_usage(organization_id,provider_id,member_id,status,cost_micros,reserved_micros,reconciled_state,created_at)
        VALUES ($1,$2,$3,'reserved',NULL,5000,'pending_reconciliation', now() - interval '1 hour') RETURNING id`, [orgId, providerId, memberId])).rows[0].id;
    } finally {
      await admin.query('ALTER TABLE enterprise.model_usage FORCE ROW LEVEL SECURITY');
    }
    await worker.tick();
    const row = (await admin.query('SELECT status, cost_micros, error_code FROM enterprise.model_usage WHERE id=$1', [id])).rows[0];
    assert.deepEqual(row, { status: 'unknown', cost_micros: null, error_code: 'ENTERPRISE_WORKER_INTERRUPTED' });
  });

  test('對帳：只有 billing.manage；待對帳筆設定實際用量後 final；不能重複對帳', async () => {
    const pending = (await admin.query("SELECT id FROM enterprise.model_usage WHERE reconciled_state='pending_reconciliation' AND status='unknown' LIMIT 1")).rows[0].id;
    assert.equal((await call('POST', `/api/enterprise/v1/usage/${pending}/reconcile`, 'employee', { outcome: 'charged', inputTokens: 10, outputTokens: 5, note: 'x' })).status, 403);
    const done = await call('POST', `/api/enterprise/v1/usage/${pending}/reconcile`, 'admin', { outcome: 'charged', inputTokens: 1000, outputTokens: 0, note: '依供應商帳單' });
    assert.equal(done.status, 200);
    const row = (await admin.query('SELECT status, cost_micros::text AS cost, reconciled_state, reconciled_by_member_id IS NOT NULL AS by FROM enterprise.model_usage WHERE id=$1', [pending])).rows[0];
    assert.equal(row.status, 'succeeded');
    assert.equal(row.reconciled_state, 'final');
    assert.ok(Number(row.cost) > 0);
    assert.equal(row.by, true);
    assert.equal((await call('POST', `/api/enterprise/v1/usage/${pending}/reconcile`, 'admin', { outcome: 'not_charged', note: 'x' })).status, 409);
    const audit = await admin.query("SELECT count(*)::int AS n FROM enterprise.audit_events WHERE action='model_usage.reconciled' AND resource_id=$1", [pending]);
    assert.equal(audit.rows[0].n, 1);
  });
});
