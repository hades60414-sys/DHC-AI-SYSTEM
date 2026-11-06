import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import express from 'express';
import { Pool } from 'pg';

import { bootstrapEnterpriseOrganization, createLocalDocumentBlobStore, runEnterpriseMigrations, setEnterpriseSubscriptionBySlug } from '@/modules/enterprise-persistence/index.js';

import { createEnterpriseRouter } from '../enterprise.routes.js';
import { enterpriseLegacyGate } from '../enterprise-runtime.js';

const database = process.env.E02A_TEST_DATABASE;
const directory = path.resolve('db/enterprise/migrations');
const PASSWORD = 'Synthetic-only-Passw0rd!';
const sha = (content: Buffer) => createHash('sha256').update(content).digest('hex');

// IAM-01 / SEC-01 / DOC-01 對外 API 合約：真 PostgreSQL＋真 express router，從原始 HTTP 驗證（不經 UI）。
describe('enterprise /api/enterprise/v1 合約（實際 PostgreSQL，合成資料）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 6 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  let server: http.Server;
  let base = '';
  let blobRoot = '';
  const tokens: Record<string, string> = {};
  const memberIds: Record<string, string> = {};

  async function call(method: string, route: string, options: { token?: string; json?: unknown; body?: Buffer; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    let body: string | Buffer | undefined;
    if (options.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.json); }
    if (options.body) body = options.body;
    const response = await fetch(base + route, { method, headers, body });
    const type = response.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data: data as any, headers: response.headers };
  }
  const login = (organizationSlug: string, email: string, password = PASSWORD) =>
    call('POST', '/api/enterprise/v1/auth/login', { json: { organizationSlug, email, password } });
  const upload = (token: string, title: string, content: Buffer, mediaType = 'text/plain', filename = '合成.txt') =>
    call('POST', '/api/enterprise/v1/documents', {
      token, body: content,
      headers: { 'content-type': mediaType, 'x-dhc-title': encodeURIComponent(title), 'x-dhc-filename': encodeURIComponent(filename) },
    });

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory, direction: 'up' });
    await bootstrapEnterpriseOrganization(migrator, { slug: 'alpha', name: '合成甲公司', adminEmail: 'admin@alpha.example.invalid', adminPassword: PASSWORD });
    await bootstrapEnterpriseOrganization(migrator, { slug: 'beta', name: '合成乙公司', adminEmail: 'admin@beta.example.invalid', adminPassword: PASSWORD });
    // PLAN-01 之後預設為 3 席 Pilot；本組測試需要超過 3 個成員，改用供應商端路徑設為 Team（10 席）。
    for (const slug of ['alpha', 'beta']) {
      await setEnterpriseSubscriptionBySlug(migrator, { slug, planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test fixture', actor: 'test' });
    }
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-api-')), 'blobs');
    const app = express();
    app.use(enterpriseLegacyGate);
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: runtime, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024 }));
    app.get('/api/user/preferences', (_req, res) => { res.json({ legacy: true }); });
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('bootstrap：同 slug 重複初始化拒絕；runtime 不能建立組織或角色', async () => {
    await assert.rejects(bootstrapEnterpriseOrganization(migrator, { slug: 'alpha', name: 'x', adminEmail: 'x@example.invalid', adminPassword: PASSWORD }), /ENTERPRISE_ORGANIZATION_EXISTS/);
    await assert.rejects(runtime.query("INSERT INTO enterprise.organizations(slug,name) VALUES ('gamma','x')"), { code: '42501' });
  });

  test('登入：成功取得 token；未知組織、未知帳號、錯密碼皆同一個 401 代碼', async () => {
    const ok = await login('alpha', 'ADMIN@alpha.example.invalid');
    assert.equal(ok.status, 200);
    assert.match(ok.data.token, /^dhcs1\./);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    tokens.alphaAdmin = ok.data.token;
    tokens.betaAdmin = (await login('beta', 'admin@beta.example.invalid')).data.token;
    for (const attempt of [login('nope', 'admin@alpha.example.invalid'), login('alpha', 'ghost@alpha.example.invalid'), login('alpha', 'admin@alpha.example.invalid', 'wrong-password-123')]) {
      const result = await attempt;
      assert.equal(result.status, 401);
      assert.equal(result.data.error.code, 'ENTERPRISE_INVALID_CREDENTIALS');
    }
    const me = await call('GET', '/api/enterprise/v1/identity/me', { token: tokens.alphaAdmin });
    assert.equal(me.status, 200);
    assert.deepEqual(me.data.roles, ['org_admin']);
    assert.ok(me.data.permissions.includes('members.manage'));
  });

  test('無憑證、偽造 token、竄改 secret、URL 中的 token、legacy 入口：全部拒絕', async () => {
    assert.equal((await call('GET', '/api/enterprise/v1/identity/me')).status, 401);
    assert.equal((await call('GET', '/api/enterprise/v1/identity/me', { token: 'not-a-token' })).status, 401);
    const tampered = tokens.alphaAdmin.slice(0, -4) + (tokens.alphaAdmin.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    assert.equal((await call('GET', '/api/enterprise/v1/identity/me', { token: tampered })).status, 401);
    // 把 beta 的 session 換成 alpha 的組織 id：RLS scope 下找不到 session
    const [, betaOrg, betaSession, betaSecret] = tokens.betaAdmin.split('.');
    const [, alphaOrg] = tokens.alphaAdmin.split('.');
    assert.notEqual(betaOrg, alphaOrg);
    assert.equal((await call('GET', '/api/enterprise/v1/identity/me', { token: `dhcs1.${alphaOrg}.${betaSession}.${betaSecret}` })).status, 401);
    const inUrl = await call('GET', `/api/enterprise/v1/identity/me?access_token=${encodeURIComponent(tokens.alphaAdmin)}`);
    assert.equal(inUrl.status, 400);
    const legacy = await call('GET', '/api/user/preferences', { token: tokens.alphaAdmin });
    assert.equal(legacy.status, 403);
    assert.equal(legacy.data.error.code, 'ENTERPRISE_LEGACY_ENTRY_DISABLED');
  });

  test('成員管理：管理員建立員工與稽核者；角色權限由伺服器決定', async () => {
    const employee = await call('POST', '/api/enterprise/v1/members', { token: tokens.alphaAdmin, json: { email: 'staff@alpha.example.invalid', password: PASSWORD, roles: ['employee'] } });
    assert.equal(employee.status, 201);
    memberIds.employee = employee.data.id;
    const auditor = await call('POST', '/api/enterprise/v1/members', { token: tokens.alphaAdmin, json: { email: 'audit@alpha.example.invalid', password: PASSWORD, roles: ['auditor'] } });
    memberIds.auditor = auditor.data.id;
    assert.equal((await call('POST', '/api/enterprise/v1/members', { token: tokens.alphaAdmin, json: { email: 'staff@alpha.example.invalid', password: PASSWORD, roles: ['employee'] } })).status, 409);
    assert.equal((await call('POST', '/api/enterprise/v1/members', { token: tokens.alphaAdmin, json: { email: 'x@alpha.example.invalid', password: 'short', roles: ['employee'] } })).status, 400);
    assert.equal((await call('POST', '/api/enterprise/v1/members', { token: tokens.alphaAdmin, json: { email: 'y@alpha.example.invalid', password: PASSWORD, roles: ['superuser'] } })).status, 400);
    tokens.employee = (await login('alpha', 'staff@alpha.example.invalid')).data.token;
    tokens.auditor = (await login('alpha', 'audit@alpha.example.invalid')).data.token;
    assert.equal((await call('POST', '/api/enterprise/v1/members', { token: tokens.employee, json: { email: 'z@alpha.example.invalid', password: PASSWORD, roles: ['org_admin'] } })).status, 403);
    assert.equal((await call('GET', '/api/enterprise/v1/members', { token: tokens.employee })).status, 403);
    assert.equal((await call('GET', '/api/enterprise/v1/members', { token: tokens.auditor })).status, 200);
    // 跨組織：beta 管理員看不到也停不了 alpha 成員
    const betaList = await call('GET', '/api/enterprise/v1/members', { token: tokens.betaAdmin });
    assert.ok(betaList.data.items.every((row: { email: string }) => row.email.endsWith('@beta.example.invalid')));
    assert.equal((await call('POST', `/api/enterprise/v1/members/${memberIds.employee}/disable`, { token: tokens.betaAdmin })).status, 404);
  });

  test('文件：上傳、下載、版本前提與衝突；型別、大小、權限；跨組織 404', async () => {
    const content = Buffer.from('合成會議紀錄：第一版');
    const created = await upload(tokens.employee, '週會紀錄', content);
    assert.equal(created.status, 201);
    assert.equal(created.data.version.sha256, sha(content));
    const documentId = created.data.document.id;
    const download = await call('GET', `/api/enterprise/v1/documents/${documentId}/versions/1/content`, { token: tokens.employee });
    assert.equal(download.status, 200);
    assert.deepEqual(download.data, content);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(download.headers.get('x-dhc-content-sha256'), sha(content));
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
    const v2body = Buffer.from('第二版');
    const headers = { 'content-type': 'text/plain', 'x-dhc-filename': encodeURIComponent('v2.txt') };
    assert.equal((await call('POST', `/api/enterprise/v1/documents/${documentId}/versions`, { token: tokens.employee, body: v2body, headers })).status, 428);
    assert.equal((await call('POST', `/api/enterprise/v1/documents/${documentId}/versions`, { token: tokens.employee, body: v2body, headers: { ...headers, 'if-match': '"1"' } })).status, 201);
    assert.equal((await call('POST', `/api/enterprise/v1/documents/${documentId}/versions`, { token: tokens.employee, body: v2body, headers: { ...headers, 'if-match': '"1"' } })).status, 409);
    const detail = await call('GET', `/api/enterprise/v1/documents/${documentId}`, { token: tokens.employee });
    assert.deepEqual(detail.data.versions.map((row: { versionNumber: number }) => row.versionNumber), [1, 2]);
    assert.equal((await upload(tokens.employee, '假 PDF', Buffer.from('not pdf'), 'application/pdf', 'x.pdf')).status, 415);
    assert.equal((await upload(tokens.employee, 'HTML', Buffer.from('<script>'), 'text/html', 'x.html')).status, 415);
    assert.equal((await upload(tokens.employee, '太大', Buffer.alloc(1024 * 1024 + 1, 0x61))).status, 413);
    assert.equal((await upload(tokens.auditor, '稽核者不能寫', Buffer.from('x'))).status, 403);
    assert.equal((await call('GET', `/api/enterprise/v1/documents/${documentId}`, { token: tokens.betaAdmin })).status, 404);
    assert.equal((await call('GET', `/api/enterprise/v1/documents/${documentId}/versions/1/content`, { token: tokens.betaAdmin })).status, 404);
    const injected = await call('GET', `/api/enterprise/v1/documents/${documentId}`, { token: tokens.betaAdmin, headers: { 'x-organization-id': tokens.alphaAdmin.split('.')[1] } });
    assert.equal(injected.status, 404);
    const betaList = await call('GET', '/api/enterprise/v1/documents', { token: tokens.betaAdmin });
    assert.deepEqual(betaList.data.items, []);
  });

  test('撤權：停用員工後其既有 token 立即 401；角色變更使舊 token 失效；不能停用最後一位管理員', async () => {
    assert.equal((await call('GET', '/api/enterprise/v1/identity/me', { token: tokens.employee })).status, 200);
    const disabled = await call('POST', `/api/enterprise/v1/members/${memberIds.employee}/disable`, { token: tokens.alphaAdmin });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.data.member.status, 'disabled');
    assert.ok(disabled.data.revokedSessions >= 1);
    assert.equal((await call('GET', '/api/enterprise/v1/identity/me', { token: tokens.employee })).status, 401);
    assert.equal((await call('GET', '/api/enterprise/v1/documents', { token: tokens.employee })).status, 401);
    assert.equal((await login('alpha', 'staff@alpha.example.invalid')).status, 401);
    // 角色變更
    assert.equal((await call('PUT', `/api/enterprise/v1/members/${memberIds.auditor}/roles`, { token: tokens.alphaAdmin, json: { roles: ['employee'] } })).status, 200);
    assert.equal((await call('GET', '/api/enterprise/v1/identity/me', { token: tokens.auditor })).status, 401);
    const relogin = await login('alpha', 'audit@alpha.example.invalid');
    assert.deepEqual((await call('GET', '/api/enterprise/v1/identity/me', { token: relogin.data.token })).data.roles, ['employee']);
    // 最後一位管理員
    const me = await call('GET', '/api/enterprise/v1/identity/me', { token: tokens.alphaAdmin });
    const self = await call('POST', `/api/enterprise/v1/members/${me.data.memberId}/disable`, { token: tokens.alphaAdmin });
    assert.equal(self.status, 409);
    assert.equal(self.data.error.code, 'ENTERPRISE_LAST_ADMIN');
    // 重新啟用後可再登入
    assert.equal((await call('POST', `/api/enterprise/v1/members/${memberIds.employee}/enable`, { token: tokens.alphaAdmin })).status, 200);
    assert.equal((await login('alpha', 'staff@alpha.example.invalid')).status, 200);
  });

  test('稽核：管理員可讀本組織事件且含成員與 session 動作；員工不可讀', async () => {
    const events = await call('GET', '/api/enterprise/v1/audit-events?limit=100', { token: tokens.alphaAdmin });
    assert.equal(events.status, 200);
    const actions = new Set(events.data.items.map((row: { action: string }) => row.action));
    for (const action of ['organization.bootstrapped', 'session.created', 'member.created', 'member.disabled', 'member.roles_changed', 'document.created', 'document.version_created']) {
      assert.ok(actions.has(action), action);
    }
    const employeeToken = (await login('alpha', 'staff@alpha.example.invalid')).data.token;
    assert.equal((await call('GET', '/api/enterprise/v1/audit-events', { token: employeeToken })).status, 403);
  });

  test('登出後 token 失效', async () => {
    const session = (await login('beta', 'admin@beta.example.invalid')).data.token;
    assert.equal((await call('POST', '/api/enterprise/v1/auth/logout', { token: session })).status, 204);
    assert.equal((await call('GET', '/api/enterprise/v1/identity/me', { token: session })).status, 401);
  });

  test('登入失敗限流：同帳號連續 10 次錯誤後即使密碼正確也 429', async () => {
    // 限流同時以來源 IP 計數，先前案例的失敗也會累計，因此中途可能已是 429。
    for (let i = 0; i < 10; i += 1) assert.ok([401, 429].includes((await login('beta', 'admin@beta.example.invalid', `wrong-password-${i}xx`)).status));
    const blocked = await login('beta', 'admin@beta.example.invalid');
    assert.equal(blocked.status, 429);
  });
});
