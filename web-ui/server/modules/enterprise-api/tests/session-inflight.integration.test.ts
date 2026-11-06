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
/** authenticate() 讀 session 狀態的查詢（findSessionState）。 */
const SESSION_LOOKUP = 's.member_auth_epoch AS "sessionEpoch"';

/** 第一個 session 查詢（＝目標請求的認證）完成後暫停，直到 release()。 */
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
        if (armed && typeof args[0] === 'string' && args[0].includes(SESSION_LOOKUP)) {
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

/**
 * RISK-SESSION-INFLIGHT（Astra 未確診風險）：請求通過認證（principal 已含舊權限）之後、特權交易開始之前，
 * 另一位管理員把呼叫者降權並提交。特權交易不得以舊權限寫入（provider 外送政策、用量對帳）。
 * 以 barrier 確定性重現時序；不用已被反駁的慢送 body 假說。路由與正式 server（enterprise-runtime.ts）相同：同一個
 * createEnterpriseRouter 與連線池，前置的全域 middleware 不存取資料庫，因此不影響這個資料庫層時間窗。
 */
describe('RISK-SESSION-INFLIGHT 認證後降權（實際 PostgreSQL、確定性 barrier、完整 HTTP 路由）', { skip: !database }, () => {
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
  const memberId: Record<string, string> = {};

  async function call(method: string, route: string, who: string, json?: unknown) {
    const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token[who]}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
      body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: response.status, data: (await response.json().catch(() => null)) as any };
  }
  const login = async (who: string, email: string) => {
    const session = (await (await fetch(base + '/api/enterprise/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationSlug: 'inflight', email, password: PASSWORD }) })).json() as any);
    token[who] = session.token;
    memberId[who] = (await call('GET', '/api/enterprise/v1/identity/me', who)).data.memberId;
  };
  const upsert = (who: string, deployment: string) => call('PUT', '/api/enterprise/v1/models/providers', who, { key: 'cloud', kind: 'mock', deployment, monthlyBudgetMicros: 0 });
  const deploymentNow = async () => (await admin.query("SELECT deployment FROM enterprise.model_providers WHERE organization_id=$1 AND key='cloud'", [organizationId])).rows[0]?.deployment;

  /** 目標請求認證後停住 → admin2 把 victim 降成 employee 並提交 → 放行目標請求。 */
  async function demoteDuring<T>(victim: string, request: () => Promise<T>) {
    const paused = barrier.pauseNext();
    const pending = request();
    await paused;
    const demoted = await call('PUT', `/api/enterprise/v1/members/${memberId[victim]}/roles`, 'admin2', { roles: ['employee'] });
    assert.equal(demoted.status, 200, JSON.stringify(demoted.data));
    barrier.release();
    return pending;
  }
  async function restore(victim: string) {
    assert.equal((await call('PUT', `/api/enterprise/v1/members/${memberId[victim]}/roles`, 'admin2', { roles: ['org_admin'] })).status, 200);
    await login(victim, `${victim}@inflight.example.invalid`);
  }

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    organizationId = (await bootstrapEnterpriseOrganization(migrator, { slug: 'inflight', name: 'inflight', adminEmail: 'admin2@inflight.example.invalid', adminPassword: PASSWORD })).organizationId;
    await setEnterpriseSubscriptionBySlug(migrator, { slug: 'inflight', planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-inflight-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: barrier.pool, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024 }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await login('admin2', 'admin2@inflight.example.invalid');
    assert.equal((await call('POST', '/api/enterprise/v1/members', 'admin2', { email: 'victim@inflight.example.invalid', password: PASSWORD, roles: ['org_admin'] })).status, 201);
    await login('victim', 'victim@inflight.example.invalid');
    assert.equal((await upsert('admin2', 'LOCAL_ONLY')).status, 200);
  });
  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('正向對照：未被降權的管理員可以改 provider 外送政策', async () => {
    assert.equal((await upsert('victim', 'LOCAL_ONLY')).status, 200);
  });

  test('認證後被降權：provider 外送政策（LOCAL_ONLY → CLOUD_ALLOWED）不得以舊權限寫入', async t => {
    try {
      const result = await demoteDuring('victim', () => upsert('victim', 'CLOUD_ALLOWED'));
      t.diagnostic(`provider upsert after demotion: HTTP ${result.status} ${JSON.stringify(result.data)}`);
      assert.equal(await deploymentNow(), 'LOCAL_ONLY', `降權後仍寫入：HTTP ${result.status}`);
      assert.ok([401, 403].includes(result.status), `HTTP ${result.status}`);
    } finally {
      await restore('victim');
      await admin.query("UPDATE enterprise.model_providers SET deployment='LOCAL_ONLY' WHERE organization_id=$1 AND key='cloud'", [organizationId]);
    }
  });

  test('認證後被降權：用量對帳不得以舊權限寫入', async t => {
    const provider = (await admin.query("SELECT id FROM enterprise.model_providers WHERE organization_id=$1 AND key='cloud'", [organizationId])).rows[0].id;
    const usage = (await admin.query(`INSERT INTO enterprise.model_usage(organization_id,provider_id,member_id,status,error_code,reserved_micros,cost_micros,reconciled_state)
      VALUES ($1,$2,$3,'unknown','ENTERPRISE_PROVIDER_TIMEOUT',1000,NULL,'pending_reconciliation') RETURNING id`, [organizationId, provider, memberId.admin2])).rows[0].id;
    try {
      const result = await demoteDuring('victim', () => call('POST', `/api/enterprise/v1/usage/${usage}/reconcile`, 'victim', { outcome: 'not_charged', note: '降權後嘗試' }));
      t.diagnostic(`reconcile after demotion: HTTP ${result.status} ${JSON.stringify(result.data)}`);
      const row = (await admin.query('SELECT reconciled_state AS state FROM enterprise.model_usage WHERE id=$1', [usage])).rows[0];
      assert.equal(row.state, 'pending_reconciliation', `降權後仍對帳：HTTP ${result.status}`);
      assert.ok([401, 403].includes(result.status), `HTTP ${result.status}`);
    } finally {
      await restore('victim');
    }
  });

  test('正向對照：降權在特權交易提交之後才發生 → 寫入有效（合法先後順序）', async () => {
    assert.equal((await upsert('victim', 'CLOUD_ALLOWED')).status, 200);
    assert.equal((await call('PUT', `/api/enterprise/v1/members/${memberId.victim}/roles`, 'admin2', { roles: ['employee'] })).status, 200);
    assert.equal(await deploymentNow(), 'CLOUD_ALLOWED');
    assert.equal((await upsert('victim', 'LOCAL_ONLY')).status, 401, '降權後舊 session 立即失效');
    await restore('victim');
    assert.equal((await upsert('victim', 'LOCAL_ONLY')).status, 200);
  });
});
