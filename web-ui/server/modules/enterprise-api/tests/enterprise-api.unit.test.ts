import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';

import express from 'express';

import type { EnterprisePrincipal } from '@/shared/index.js';

import { resolveDeploymentMode } from '../deployment-mode.js';
import { createEnterpriseAuth, createFailureLimiter, requirePermission, sendEnterpriseError } from '../enterprise-http.js';
import { enterpriseApiFence, enterpriseLegacyGate } from '../enterprise-runtime.js';

const enterpriseEnv = {
  DHC_DEPLOYMENT_MODE: 'enterprise', ENTERPRISE_DB_HOST: 'db', ENTERPRISE_DB_NAME: 'x', ENTERPRISE_DB_USER: 'dhc_app',
  ENTERPRISE_DB_PASSWORD: 'p', ENTERPRISE_BLOB_ROOT: '/srv/blobs',
};

describe('resolveDeploymentMode（fail closed）', () => {
  test('ASTRA-012：企業 image（DHC_IMAGE_PROFILE=enterprise）拒絕以個人模式啟動', () => {
    assert.throws(() => resolveDeploymentMode({ DHC_IMAGE_PROFILE: 'enterprise' }), /only runs with DHC_DEPLOYMENT_MODE=enterprise/);
    assert.throws(() => resolveDeploymentMode({ DHC_IMAGE_PROFILE: 'enterprise', DHC_DEPLOYMENT_MODE: 'personal' }), /only runs with/);
    assert.equal(resolveDeploymentMode({ DHC_IMAGE_PROFILE: 'full' }), 'personal');
  });
  test('預設 personal；企業模式需要完整設定與 dhc_app', () => {
    assert.equal(resolveDeploymentMode({}), 'personal');
    assert.equal(resolveDeploymentMode(enterpriseEnv), 'enterprise');
    for (const key of ['ENTERPRISE_DB_HOST', 'ENTERPRISE_DB_NAME', 'ENTERPRISE_DB_PASSWORD', 'ENTERPRISE_BLOB_ROOT']) {
      assert.throws(() => resolveDeploymentMode({ ...enterpriseEnv, [key]: '' }), new RegExp(key));
    }
    assert.throws(() => resolveDeploymentMode({ ...enterpriseEnv, ENTERPRISE_DB_USER: 'dhc_migrator' }), /dhc_app/);
    assert.throws(() => resolveDeploymentMode({ DHC_DEPLOYMENT_MODE: 'Enterprise' }), /must be/);
  });
  test('企業模式拒絕 platform；personal 的 platform 需 opt-in 且 loopback', () => {
    assert.throws(() => resolveDeploymentMode({ ...enterpriseEnv, VITE_IS_PLATFORM: 'true' }), /refuses/);
    assert.throws(() => resolveDeploymentMode({ VITE_IS_PLATFORM: 'true' }), /loopback-only/);
    assert.throws(() => resolveDeploymentMode({ VITE_IS_PLATFORM: 'true', DHC_ALLOW_PLATFORM_FIRST_USER: 'loopback-only', HOST: '0.0.0.0' }), /loopback/);
    assert.equal(resolveDeploymentMode({ VITE_IS_PLATFORM: 'true', DHC_ALLOW_PLATFORM_FIRST_USER: 'loopback-only' }), 'personal');
  });
});

const principal: EnterprisePrincipal = {
  organizationId: '00000000-0000-4000-8000-000000000001', userAccountId: 'u', memberId: 'm', sessionId: 's', email: 'a@example.invalid',
  roles: ['employee'], permissions: ['documents.read'], expiresAt: new Date(Date.now() + 60_000),
};

async function withApp(configure: (app: express.Express) => void, run: (base: string) => Promise<void>) {
  const app = express();
  configure(app);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('enterprise HTTP 守門', () => {
  test('只接受 Bearer header；query 憑證 400；未知 token 401；權限不足 403', async () => {
    const seen: string[] = [];
    await withApp(app => {
      app.use(enterpriseLegacyGate);
      const auth = createEnterpriseAuth(async token => { seen.push(token); return token === 'good' ? principal : null; });
      app.get('/api/enterprise/v1/read', auth, requirePermission('documents.read'), (_req, res) => { res.json({ ok: true }); });
      app.get('/api/enterprise/v1/admin', auth, requirePermission('members.manage'), (_req, res) => { res.json({ ok: true }); });
      app.get('/api/user/preferences', (_req, res) => { res.json({ leaked: true }); });
    }, async base => {
      const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });
      assert.equal((await get('/api/enterprise/v1/read')).status, 401);
      assert.equal((await get('/api/enterprise/v1/read', { authorization: 'Bearer bad' })).status, 401);
      assert.equal((await get('/api/enterprise/v1/read', { authorization: 'Basic good' })).status, 401);
      const queryToken = await get('/api/enterprise/v1/read?access_token=good', { authorization: 'Bearer good' });
      assert.equal(queryToken.status, 400);
      assert.equal(((await queryToken.json()) as { error: { code: string } }).error.code, 'ENTERPRISE_CREDENTIAL_IN_URL');
      const ok = await get('/api/enterprise/v1/read', { authorization: 'Bearer good' });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('cache-control'), 'no-store');
      assert.equal((await get('/api/enterprise/v1/admin', { authorization: 'Bearer good' })).status, 403);
      const legacy = await get('/api/user/preferences', { authorization: 'Bearer good' });
      assert.equal(legacy.status, 403);
      assert.equal(((await legacy.json()) as { error: { code: string } }).error.code, 'ENTERPRISE_LEGACY_ENTRY_DISABLED');
      assert.deepEqual(seen.filter(token => token !== 'good' && token !== 'bad'), []);
    });
  });

  test('未預期錯誤不外洩內部訊息；已知代碼對應正確狀態', async () => {
    await withApp(app => {
      app.get('/boom', (_req, res) => sendEnterpriseError(res, new Error('connect ECONNREFUSED 10.0.0.1 password=secret')));
      app.get('/conflict', (_req, res) => sendEnterpriseError(res, new Error('ENTERPRISE_VERSION_CONFLICT')));
      app.get('/bad', (_req, res) => sendEnterpriseError(res, new Error('ENTERPRISE_INVALID_EMAIL')));
    }, async base => {
      const boom = await fetch(base + '/boom');
      const text = await boom.text();
      assert.equal(boom.status, 500);
      assert.ok(!text.includes('secret') && !text.includes('10.0.0.1'));
      assert.equal((await fetch(base + '/conflict')).status, 409);
      assert.equal((await fetch(base + '/bad')).status, 400);
    });
  });
});

test('SEC-FIX-01：legacy gate 依正規化路徑判斷（大小寫、編碼、斜線、反斜線、點段、所有方法）', async () => {
  await withApp(app => {
    app.use(enterpriseLegacyGate);
    // 模擬「若 legacy router 仍被掛載」：gate 必須在它之前攔下所有別名
    app.all('/api/user/preferences', (_req, res) => { res.json({ leaked: true }); });
    app.get('/api/enterprise/v1/ping', (_req, res) => { res.json({ ok: true }); });
    app.use(enterpriseApiFence);
    app.get('*', (_req, res) => { res.send('spa'); });
  }, async base => {
    const call = async (method: string, path: string) => {
      const http = await import('node:http');
      const url = new URL(base);
      return new Promise<number>((resolve, reject) => {
        const request = http.request({ host: url.hostname, port: url.port, method, path }, response => { response.resume(); resolve(response.statusCode ?? 0); });
        request.on('error', reject);
        request.end();
      });
    };
    for (const path of ['/api/user/preferences', '/API/user/preferences', '/Api/User/Preferences', '/%61pi/user/preferences', '/%41PI/user/preferences',
      '//api/user/preferences', '/api//user/preferences', '/api\\user/preferences', '/api/user/preferences/', '/api', '/API']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
        assert.equal(await call(method, path), 403, `${method} ${path}`);
      }
    }
    for (const path of ['/api/enterprise/v1/../user/preferences', '/api/./user', '/%E0%A4%A']) assert.equal(await call('GET', path), 400, path);
    assert.equal(await call('GET', '/api/enterprise/v1/ping'), 200);
    assert.equal(await call('GET', '/API/ENTERPRISE/V1/ping'), 200, '企業路由大小寫別名仍走企業路由（仍需各自的 auth）');
    assert.equal(await call('GET', '//api/enterprise/v1/ping'), 404, '未被企業 router 處理的 /api 別名由 fence 終止，不落到 SPA');
    assert.equal(await call('GET', '/office'), 200);
  });
});

test('企業模式根路徑導向 /office（員工不會落到原工作台）', async () => {
  await withApp(app => { app.use(enterpriseLegacyGate); app.get('/', (_req, res) => { res.send('legacy workspace'); }); }, async base => {
    const response = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/office');
  });
});

test('失敗限流：視窗內達上限封鎖，視窗過後解除', () => {
  let now = 0;
  const limiter = createFailureLimiter({ limit: 3, windowMs: 1000, now: () => now });
  for (let i = 0; i < 3; i += 1) limiter.recordFailure(['ip:1']);
  assert.equal(limiter.isBlocked(['ip:1']), true);
  assert.equal(limiter.isBlocked(['ip:2']), false);
  now = 1001;
  assert.equal(limiter.isBlocked(['ip:1']), false);
});
