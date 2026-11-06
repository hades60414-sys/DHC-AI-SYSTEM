import assert from 'node:assert/strict';
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
  bootstrapEnterpriseOrganization, createLocalDocumentBlobStore, runEnterpriseMigrations, setEnterpriseSubscriptionBySlug,
} from '@/modules/enterprise-persistence/index.js';

const database = process.env.E02A_TEST_DATABASE;
const PASSWORD = 'Synthetic-only-Passw0rd!';
const EXISTING_LOOKUP = 'idempotency_key=$3';

/** 第一個「以冪等 key 查既有 Run」的查詢完成後暫停，直到 release()（同 approval-revision 的 barrier 模式）。 */
function barrierPool(runtime: Pool) {
  let armed = false;
  let arrived!: () => void;
  let release!: () => void;
  let gate = Promise.resolve();
  const wrap = (client: PoolClient) => new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== 'query') return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]) => {
        const result = await (target.query as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (armed && typeof args[0] === 'string' && args[0].includes(EXISTING_LOOKUP)) {
          armed = false;
          arrived();
          await gate;
        }
        return result;
      };
    },
  });
  return {
    pool: new Proxy(runtime, { get(target, prop, receiver) { return prop === 'connect' ? async () => wrap(await target.connect()) : Reflect.get(target, prop, receiver); } }),
    pauseNext() {
      armed = true;
      gate = new Promise<void>(resolve => { release = resolve; });
      return new Promise<void>(resolve => { arrived = resolve; });
    },
    release: () => release(),
  };
}
const settleWithin = <T>(promise: Promise<T>, ms: number) => Promise.race([promise.then(() => 'settled' as const), new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), ms))]);

/**
 * ASTRA-V3-NEW-003：同一成員、同一 Idempotency-Key、同一內容的並行請求只能建立一個 Run，所有請求回同一個 Run（不得 500 或誤報 429）。
 * 同 key 不同內容 → 409；不同 key 照常受配額限制。
 */
describe('ASTRA-V3-NEW-003 Run 建立冪等（實際 PostgreSQL、確定性 barrier、完整 HTTP 路由）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 10 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  const barrier = barrierPool(runtime);
  let server: http.Server;
  let base = '';
  let blobRoot = '';
  let organizationId = '';
  const token: Record<string, string> = {};

  async function call(method: string, route: string, who: string, json?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token[who]}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: response.status, data: (await response.json()) as any };
  }
  const login = async (who: string, email: string) => {
    token[who] = (await (await fetch(base + '/api/enterprise/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationSlug: 'idem', email, password: PASSWORD }) })).json() as any).token;
  };
  const request = (key: string, query = '交付期限', who = 'employee') => call('POST', '/api/enterprise/v1/runs/draft-generation', who, { title: '冪等', query, providerKey: 'mock' },
    { 'idempotency-key': key });
  const countFor = async (key: string) => (await admin.query(`SELECT count(*)::int AS runs, count(DISTINCT draft_id)::int AS drafts FROM enterprise.runs WHERE idempotency_key=$1`, [key])).rows[0];
  const runsThisMonth = async () => (await admin.query("SELECT count(*)::int AS n FROM enterprise.runs WHERE organization_id=$1 AND created_at >= date_trunc('month', now())", [organizationId])).rows[0].n;
  const setRunLimit = (limit: number) => admin.query('UPDATE enterprise.subscriptions SET monthly_run_limit=$2 WHERE organization_id=$1', [organizationId, limit]);

  /** 第一個請求查完「無既有 Run」後停住；第二個同 key 請求跑完（或被鎖住逾時）再放行第一個。 */
  async function racePair(key: string) {
    const paused = barrier.pauseNext();
    const first = request(key);
    await paused;
    const second = request(key);
    const secondState = await settleWithin(second, 1500);
    barrier.release();
    return { results: await Promise.all([first, second]), secondState };
  }

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    organizationId = (await bootstrapEnterpriseOrganization(migrator, { slug: 'idem', name: 'idem', adminEmail: 'admin@idem.example.invalid', adminPassword: PASSWORD })).organizationId;
    await setEnterpriseSubscriptionBySlug(migrator, { slug: 'idem', planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-idem-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: barrier.pool, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024 }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await login('admin', 'admin@idem.example.invalid');
    for (const name of ['employee', 'other']) {
      assert.equal((await call('POST', '/api/enterprise/v1/members', 'admin', { email: `${name}@idem.example.invalid`, password: PASSWORD, roles: ['employee'] })).status, 201);
      await login(name, `${name}@idem.example.invalid`);
    }
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { key: 'mock', kind: 'mock', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 0 })).status, 200);
  });
  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('有額度：同 key 並行兩個請求 → 同一個 Run（一個 202、一個 200 reused），沒有 500，只有一個 Run 與一份草稿', async () => {
    await setRunLimit(1000);
    const { results: [a, b], secondState } = await racePair('idem-key-0001');
    assert.deepEqual([a.status, b.status].sort(), [200, 202], `statuses ${a.status}/${b.status}（第二個 ${secondState}）：${JSON.stringify([a.data, b.data])}`);
    assert.equal(a.data.run.id, b.data.run.id);
    assert.deepEqual(await countFor('idem-key-0001'), { runs: 1, drafts: 1 });
  });

  test('最後一個額度：同 key 並行 → 兩個都拿到同一個 Run（不得誤回 429）', async () => {
    await setRunLimit((await runsThisMonth()) + 1);
    const { results: [a, b] } = await racePair('idem-key-0002');
    assert.deepEqual([a.status, b.status].sort(), [200, 202], JSON.stringify([a.data, b.data]));
    assert.equal(a.data.run.id, b.data.run.id);
    assert.deepEqual(await countFor('idem-key-0002'), { runs: 1, drafts: 1 });
    // 對照：額度已滿時，不同 key 正常被擋；同 key 重試仍回原 Run
    const other = await request('idem-key-0003');
    assert.deepEqual([other.status, other.data.error?.code], [429, 'ENTERPRISE_RUN_LIMIT']);
    const retry = await request('idem-key-0002');
    assert.deepEqual([retry.status, retry.data.run.id, retry.data.reused], [200, a.data.run.id, true]);
    await setRunLimit(1000);
  });

  test('同 key 不同內容 → 409，不建立新 Run；不同成員可用同一個 key 字串（互相隔離）', async () => {
    const first = await request('idem-key-0004', '交付期限');
    assert.equal(first.status, 202);
    const changed = await request('idem-key-0004', '完全不同的需求');
    assert.deepEqual([changed.status, changed.data.error?.code], [409, 'ENTERPRISE_IDEMPOTENCY_KEY_REUSED']);
    const otherMember = await request('idem-key-0004', '交付期限', 'other');
    assert.equal(otherMember.status, 202);
    assert.notEqual(otherMember.data.run.id, first.data.run.id);
    assert.deepEqual(await countFor('idem-key-0004'), { runs: 2, drafts: 2 });
  });
});
