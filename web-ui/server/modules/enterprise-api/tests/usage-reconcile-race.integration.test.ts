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

/**
 * ASTRA-V3-NEW-002：飛行中（reserved）的模型呼叫不能被對帳提早釋放預算；已 final 的帳不能被晚到的 worker 覆寫。
 * 假 provider 以可控閘門延遲回應（loopback、合成資料、不呼叫付費 API）。
 */
describe('ASTRA-V3-NEW-002 用量對帳與飛行中預留（實際 PostgreSQL、延遲 provider）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 12 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  const workerA = createEnterpriseRunWorker(runtime, { timeoutMs: 20_000 });
  const workerB = createEnterpriseRunWorker(runtime, { timeoutMs: 20_000 });
  let server: http.Server;
  let fakeLlm: http.Server;
  let base = '';
  let blobRoot = '';
  let llmUrl = '';
  let hold: Promise<void> | null = null;
  let received: () => void = () => {};
  const token: Record<string, string> = {};
  let keys = 0;

  async function call(method: string, route: string, who: string, json?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token[who]}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: json === undefined ? undefined : JSON.stringify(json) });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, data: (type.includes('json') ? await response.json() : await response.text()) as any };
  }
  const login = async (who: string, email: string) => {
    token[who] = (await (await fetch(base + '/api/enterprise/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationSlug: 'recon', email, password: PASSWORD }) })).json() as any).token;
  };
  const provider = (budget: number) => call('PUT', '/api/enterprise/v1/models/providers', 'admin', {
    key: 'slow', kind: 'openai_compatible', baseUrl: llmUrl, model: 'synthetic', deployment: 'LOCAL_ONLY', inputPriceMicrosPerMtok: 1_000_000, outputPriceMicrosPerMtok: 2_000_000,
    monthlyBudgetMicros: budget, priceSource: '合成價目表 2026-11' });
  const startRun = async () => (await call('POST', '/api/enterprise/v1/runs/draft-generation', 'employee', { title: '對帳競態', query: '交付期限', providerKey: 'slow' },
    { 'idempotency-key': `recon-key-${(keys += 1).toString().padStart(4, '0')}` })).data.run.id as string;
  const usageOf = async (runId: string) => (await admin.query(`SELECT id, status, cost_micros::text AS cost, reserved_micros::bigint AS reserved, reconciled_state AS state, usage_source AS source,
      reconcile_note AS note FROM enterprise.model_usage WHERE run_id=$1 ORDER BY created_at`, [runId])).rows;
  const runOf = async (runId: string) => (await admin.query('SELECT status, error_code AS "errorCode", draft_id AS "draftId" FROM enterprise.runs WHERE id=$1', [runId])).rows[0];
  /** 開啟閘門：下一個 provider 請求會停住，直到回傳的 release()。 */
  function holdProvider() {
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { received = resolve; });
    return { arrived, release: () => { hold = null; release(); } };
  }
  async function drain() {
    for (let i = 0; i < 20 && (await workerB.tick()) > 0; i += 1) { /* 清空 */ }
  }

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    await bootstrapEnterpriseOrganization(migrator, { slug: 'recon', name: 'recon', adminEmail: 'admin@recon.example.invalid', adminPassword: PASSWORD });
    await setEnterpriseSubscriptionBySlug(migrator, { slug: 'recon', planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    const llm = express();
    llm.use(express.json());
    llm.post('/v1/chat/completions', async (_req, res) => {
      const gate = hold;
      received();
      if (gate) await gate;
      res.json({ choices: [{ message: { content: '依來源 [1]，交付期限 6/6。' } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } });
    });
    fakeLlm = http.createServer(llm);
    await new Promise<void>(resolve => fakeLlm.listen(0, '127.0.0.1', resolve));
    llmUrl = `http://127.0.0.1:${(fakeLlm.address() as AddressInfo).port}/v1`;
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-recon-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: runtime, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024 }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await login('admin', 'admin@recon.example.invalid');
    assert.equal((await call('POST', '/api/enterprise/v1/members', 'admin', { email: 'employee@recon.example.invalid', password: PASSWORD, roles: ['employee'] })).status, 201);
    await login('employee', 'employee@recon.example.invalid');
    assert.equal((await provider(100_000_000)).status, 200);
    const upload = await fetch(base + '/api/enterprise/v1/documents', { method: 'POST', body: Buffer.from('合成己專案 交付期限 6/6'),
      headers: { authorization: `Bearer ${token.employee}`, 'content-type': 'text/plain', 'x-dhc-title': encodeURIComponent('己專案'), 'x-dhc-filename': 'r.txt' } });
    assert.equal(upload.status, 201);
  });
  after(async () => {
    fakeLlm.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => fakeLlm.close(resolve))]);
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('飛行中 reserved 不能對帳成 not_charged；預算仍計入，並行 Run B 被預算擋下；A 完成後結算正常', async () => {
    await drain();
    await provider(100_000_000);
    const gate = holdProvider();
    const runA = await startRun();
    const ticking = workerA.tick();
    await gate.arrived;
    const [usageA] = await usageOf(runA);
    assert.equal(usageA.status, 'reserved');
    // 預算只夠一筆預留：A 仍飛行時 B 必須被擋
    await provider(Number(usageA.reserved) + Math.floor(Number(usageA.reserved) / 2));
    const early = await call('POST', `/api/enterprise/v1/usage/${usageA.id}/reconcile`, 'admin', { outcome: 'not_charged', note: '誤判未計費' });
    assert.deepEqual([early.status, early.data.error?.code], [409, 'ENTERPRISE_USAGE_IN_FLIGHT']);
    const runB = await startRun();
    await workerB.tick();
    assert.deepEqual([(await runOf(runB)).status, (await runOf(runB)).errorCode], ['failed', 'ENTERPRISE_BUDGET_EXCEEDED']);
    gate.release();
    await ticking;
    const [settled] = await usageOf(runA);
    assert.deepEqual([settled.status, settled.cost, settled.state, settled.source], ['succeeded', '1400', 'final', 'provider_reported']);
    assert.equal((await runOf(runA)).status, 'succeeded');
    await provider(100_000_000);
  });

  test('逾時清理後晚到的 worker：不得覆寫人工對帳結果，也不得把已失敗的 Run／草稿改成成功', async () => {
    await drain();
    const gate = holdProvider();
    const runA = await startRun();
    const ticking = workerA.tick();
    await gate.arrived;
    // 模擬 worker A 卡住超過逾時：另一個 worker 的清理把 Run 標成逾時失敗、預留轉成 unknown
    await admin.query("UPDATE enterprise.runs SET started_at = now() - interval '1 day' WHERE id=$1", [runA]);
    await admin.query("UPDATE enterprise.model_usage SET created_at = now() - interval '1 day' WHERE run_id=$1", [runA]);
    await workerB.tick();
    const [swept] = await usageOf(runA);
    assert.deepEqual([swept.status, swept.state], ['unknown', 'pending_reconciliation']);
    assert.equal((await runOf(runA)).errorCode, 'ENTERPRISE_RUN_TIMEOUT');
    const reconciled = await call('POST', `/api/enterprise/v1/usage/${swept.id}/reconcile`, 'admin', { outcome: 'charged', costMicros: 5000, note: '依供應商帳單' });
    assert.equal(reconciled.status, 200);
    gate.release();
    await ticking;
    const [final] = await usageOf(runA);
    assert.deepEqual([final.status, final.cost, final.state, final.source, final.note], ['succeeded', '5000', 'final', 'reconciled', '依供應商帳單']);
    const run = await runOf(runA);
    assert.deepEqual([run.status, run.errorCode], ['failed', 'ENTERPRISE_RUN_TIMEOUT']);
    const draft = (await admin.query('SELECT status, current_revision AS rev FROM enterprise.drafts WHERE id=$1', [run.draftId])).rows[0];
    assert.deepEqual([draft.status, draft.rev], ['failed', 0]);
    const late = (await admin.query("SELECT count(*)::int AS n FROM enterprise.audit_events WHERE action='run.late_result_discarded' AND resource_id=$1", [runA])).rows[0].n;
    assert.equal(late, 1, '晚到結果要留下稽核紀錄');
  });

  test('正向：unknown 對帳 not_charged 釋放預留；已 final 不能再對帳', async () => {
    await drain();
    const gate = holdProvider();
    const runA = await startRun();
    const ticking = workerA.tick();
    await gate.arrived;
    await admin.query("UPDATE enterprise.runs SET started_at = now() - interval '1 day' WHERE id=$1", [runA]);
    await admin.query("UPDATE enterprise.model_usage SET created_at = now() - interval '1 day' WHERE run_id=$1", [runA]);
    await workerB.tick();
    gate.release();
    await ticking;
    const [unknown] = await usageOf(runA);
    assert.equal(unknown.status, 'unknown');
    const done = await call('POST', `/api/enterprise/v1/usage/${unknown.id}/reconcile`, 'admin', { outcome: 'not_charged', note: '供應商確認未計費' });
    assert.deepEqual([done.status, done.data.costMicros], [200, '0']);
    const again = await call('POST', `/api/enterprise/v1/usage/${unknown.id}/reconcile`, 'admin', { outcome: 'charged', costMicros: 1, note: '重複' });
    assert.deepEqual([again.status, again.data.error?.code], [409, 'ENTERPRISE_USAGE_ALREADY_RECONCILED']);
  });
});
