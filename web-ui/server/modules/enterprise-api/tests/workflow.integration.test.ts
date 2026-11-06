import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import express from 'express';
import JSZip from 'jszip';
import { Pool } from 'pg';

import {
  bootstrapEnterpriseOrganization, createEnterpriseRunWorker, createLocalDocumentBlobStore, runEnterpriseMigrations, setEnterpriseSubscriptionBySlug,
} from '@/modules/enterprise-persistence/index.js';

import { createEnterpriseRouter } from '../enterprise.routes.js';

const database = process.env.E02A_TEST_DATABASE;
const PASSWORD = 'Synthetic-only-Passw0rd!';
const SECRET_KEY = randomBytes(32).toString('base64');

// DOC-03 / RUN-01 / MODEL-01 / PLAN-01：草稿生成 Run、審批、匯出、模型政策、方案權益（真 PostgreSQL；模型只用 mock 與本機假伺服器）。
describe('文書流程：Run → 草稿 → 修改 → 審批 → 匯出（實際 PostgreSQL，合成資料）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 8 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  const worker = createEnterpriseRunWorker(runtime, { secretKey: SECRET_KEY, timeoutMs: 2000 });
  let server: http.Server;
  let fakeLlm: http.Server;
  let llmUrl = '';
  let llmMode: 'ok' | 'fail' = 'ok';
  const llmCalls: Array<{ authorization?: string; body: any }> = [];
  let base = '';
  let blobRoot = '';
  const token: Record<string, string> = {};
  const member: Record<string, string> = {};

  async function call(method: string, route: string, who: string, options: { json?: unknown; body?: Buffer; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { authorization: `Bearer ${token[who]}`, ...(options.headers ?? {}) };
    let body: string | Buffer | undefined = options.body;
    if (options.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.json); }
    const response = await fetch(base + route, { method, headers, body });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, headers: response.headers, data: (type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())) as any };
  }
  const login = async (slug: string, email: string) => (await (await fetch(base + '/api/enterprise/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationSlug: slug, email, password: PASSWORD }) })).json() as any).token;
  const upload = (who: string, title: string, text: string, classification = 'internal') => call('POST', '/api/enterprise/v1/documents', who, {
    body: Buffer.from(text), headers: { 'content-type': 'text/plain', 'x-dhc-title': encodeURIComponent(title), 'x-dhc-filename': 'a.txt', 'x-dhc-classification': classification } });
  let keyCounter = 0;
  const startRun = (who: string, query: string, providerKey: string, title = '合成草稿') => call('POST', '/api/enterprise/v1/runs/draft-generation', who, {
    json: { title, query, providerKey }, headers: { 'idempotency-key': `test-key-${(keyCounter += 1).toString().padStart(4, '0')}` } });
  const run = (id: string) => call('GET', `/api/enterprise/v1/runs/${id}`, 'admin');

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    await bootstrapEnterpriseOrganization(migrator, { slug: 'alpha', name: 'alpha', adminEmail: 'admin@alpha.example.invalid', adminPassword: PASSWORD });
    await bootstrapEnterpriseOrganization(migrator, { slug: 'beta', name: 'beta', adminEmail: 'admin@beta.example.invalid', adminPassword: PASSWORD });
    const llm = express();
    llm.use(express.json());
    // ASTRA-002：同一 fake server 上的 307 端點，指向 IPv4-mapped loopback 的 collector 路徑
    llm.post('/redirect/v1/chat/completions', (_req, res) => { res.redirect(307, `http://[::ffff:127.0.0.1]:${(fakeLlm.address() as AddressInfo).port}/v1/chat/completions`); });
    llm.post('/v1/chat/completions', (req, res) => {
      llmCalls.push({ authorization: req.headers.authorization, body: req.body });
      if (llmMode === 'fail') return res.status(503).json({ error: 'synthetic outage with internal detail' });
      res.json({ choices: [{ message: { content: '依來源 [1]，合成甲專案交付期限為 12/20。' } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } });
    });
    fakeLlm = http.createServer(llm);
    await new Promise<void>(resolve => fakeLlm.listen(0, '127.0.0.1', resolve));
    llmUrl = `http://127.0.0.1:${(fakeLlm.address() as AddressInfo).port}/v1`;
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-wf-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: runtime, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024, secretKey: SECRET_KEY }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    token.admin = await login('alpha', 'admin@alpha.example.invalid');
    token.beta = await login('beta', 'admin@beta.example.invalid');
    for (const [name, roles] of [['approver', ['approver']], ['employee', ['employee']]] as const) {
      const created = await call('POST', '/api/enterprise/v1/members', 'admin', { json: { email: `${name}@alpha.example.invalid`, password: PASSWORD, roles } });
      member[name] = created.data.id;
      token[name] = await login('alpha', `${name}@alpha.example.invalid`);
    }
  });
  after(async () => {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => fakeLlm.close(resolve))]);
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('模型 provider：只有管理員可設定；BYOK 加密保存、不回傳；LOCAL_ONLY 拒絕外部主機', async () => {
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'employee', { json: { key: 'mock', kind: 'mock', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 0 } })).status, 403);
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { json: { key: 'mock', kind: 'mock', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 0 } })).status, 200);
    const local = await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { json: {
      key: 'local-llm', kind: 'openai_compatible', baseUrl: llmUrl, model: 'synthetic-7b', deployment: 'LOCAL_ONLY', apiKey: 'sk-synthetic-local-999',
      inputPriceMicrosPerMtok: 1_000_000, outputPriceMicrosPerMtok: 2_000_000, monthlyBudgetMicros: 100_000 } });
    assert.equal(local.status, 200);
    assert.equal(local.data.hasApiKey, true);
    assert.ok(!JSON.stringify(local.data).includes('sk-synthetic'));
    const stored = (await admin.query("SELECT api_key_ciphertext FROM enterprise.model_providers WHERE key='local-llm'")).rows[0].api_key_ciphertext;
    assert.match(stored, /^v1\./);
    assert.ok(!stored.includes('sk-synthetic'));
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { json: { key: 'leak', kind: 'openai_compatible', baseUrl: 'https://api.example.com/v1', model: 'x', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 0 } })).status, 403);
    // ASTRA-002：CLOUD_ALLOWED 指向 loopback／私有位址是 SSRF 設定錯誤，設定時就拒絕
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { json: { key: 'cloud', kind: 'openai_compatible', baseUrl: llmUrl, model: 'x', deployment: 'CLOUD_ALLOWED', monthlyBudgetMicros: 1_000_000 } })).status, 403);
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { json: { key: 'cloud', kind: 'openai_compatible', baseUrl: 'https://cloud-llm.example.test/v1', model: 'x', deployment: 'CLOUD_ALLOWED', monthlyBudgetMicros: 1_000_000 } })).status, 200);
    // redirect allowlist：LOCAL_ONLY 不能列公網主機；格式錯誤 400；合法變更留獨立稽核
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { json: { key: 'redir', kind: 'openai_compatible', baseUrl: `${llmUrl.replace('/v1', '')}/redirect/v1`, model: 'x', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 1_000_000, redirectAllowlist: ['8.8.8.8:80'] } })).status, 403);
    assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { json: { key: 'redir', kind: 'openai_compatible', baseUrl: `${llmUrl.replace('/v1', '')}/redirect/v1`, model: 'x', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 1_000_000, redirectAllowlist: ['*.internal:80'] } })).status, 400);
    const redir = await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { json: { key: 'redir', kind: 'openai_compatible', baseUrl: `${llmUrl.replace('/v1', '')}/redirect/v1`, model: 'x', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 1_000_000, redirectAllowlist: ['llm.internal:8080'] } });
    assert.equal(redir.status, 200);
    assert.deepEqual(redir.data.redirectAllowlist, ['llm.internal:8080']);
    const changed = await admin.query("SELECT count(*)::int AS n FROM enterprise.audit_events WHERE action='model_provider.redirect_allowlist_changed' AND resource_id=$1", [redir.data.id]);
    assert.equal(changed.rows[0].n, 1);
    await call('PUT', '/api/enterprise/v1/models/providers', 'admin', { json: { key: 'tiny-budget', kind: 'openai_compatible', baseUrl: llmUrl, model: 'x', deployment: 'LOCAL_ONLY', inputPriceMicrosPerMtok: 1_000_000, monthlyBudgetMicros: 1 } });
    const list = await call('GET', '/api/enterprise/v1/models/providers', 'employee');
    assert.ok(!JSON.stringify(list.data).includes('v1.'));
  });

  test('Run 需要 Idempotency-Key；同 key 回傳原 Run；mock 生成草稿含可驗證引用', async () => {
    await upload('employee', '專案週報', '合成甲專案 交付期限 12/20\n負責人 合成乙');
    assert.equal((await call('POST', '/api/enterprise/v1/runs/draft-generation', 'employee', { json: { title: 't', query: '交付期限', providerKey: 'mock' } })).status, 400);
    const headers = { 'idempotency-key': 'weekly-report-0001' };
    const first = await call('POST', '/api/enterprise/v1/runs/draft-generation', 'employee', { json: { title: '週報草稿', query: '交付期限', providerKey: 'mock' }, headers });
    assert.equal(first.status, 202);
    const again = await call('POST', '/api/enterprise/v1/runs/draft-generation', 'employee', { json: { title: '週報草稿', query: '交付期限', providerKey: 'mock' }, headers });
    assert.equal(again.status, 200);
    assert.equal(again.data.run.id, first.data.run.id);
    assert.equal(await worker.tick(), 1);
    const done = await call('GET', `/api/enterprise/v1/runs/${first.data.run.id}`, 'employee');
    assert.equal(done.data.status, 'succeeded');
    const draft = await call('GET', `/api/enterprise/v1/drafts/${done.data.draftId}`, 'employee');
    assert.equal(draft.data.draft.status, 'draft');
    assert.equal(draft.data.revision.source, 'model');
    assert.ok(draft.data.revision.citations.length >= 1);
    const citation = await call('GET', `/api/enterprise/v1/citations/${draft.data.revision.citations[0].chunkId}`, 'employee');
    assert.equal(citation.data.verified, true);
    member.draft = done.data.draftId;
  });

  test('沒有來源不呼叫模型；本機 OpenAI-compatible 送出解密後金鑰並依價格快照記成本', async () => {
    const before = llmCalls.length;
    const none = await startRun('employee', '完全不存在的主題詞', 'local-llm');
    await worker.tick();
    assert.deepEqual([(await run(none.data.run.id)).data.status, (await run(none.data.run.id)).data.errorCode], ['failed', 'ENTERPRISE_NO_SOURCES']);
    assert.equal(llmCalls.length, before);
    const ok = await startRun('employee', '交付期限', 'local-llm');
    await worker.tick();
    assert.equal((await run(ok.data.run.id)).data.status, 'succeeded');
    assert.equal(llmCalls.at(-1)!.authorization, 'Bearer sk-synthetic-local-999');
    assert.match(llmCalls.at(-1)!.body.messages[1].content, /\[1\] 合成甲專案 交付期限 12\/20/);
    const usage = await call('GET', '/api/enterprise/v1/usage', 'admin');
    const row = usage.data.items.find((item: any) => item.key === 'local-llm');
    assert.equal(row.spentMicros, String(1000 * 1 + 200 * 2)); // 1000 tok × 1 USD/Mtok + 200 tok × 2 USD/Mtok = 1400 micro-USD
  });

  test('機密文件不得送雲端；超出預算拒絕；兩者都不呼叫模型', async () => {
    await upload('employee', '人事機密', '合成員工 薪資調整 機密', 'confidential');
    const before = llmCalls.length;
    const denied = await startRun('employee', '薪資調整', 'cloud');
    await worker.tick();
    assert.equal((await run(denied.data.run.id)).data.errorCode, 'ENTERPRISE_EGRESS_DENIED');
    const notified = (await call('GET', '/api/enterprise/v1/notifications', 'admin')).data.items.filter((n: any) => n.subjectId === denied.data.run.id);
    assert.equal(notified.length, 1, '分級外送被拒也通知管理員');
    const budget = await startRun('employee', '交付期限', 'tiny-budget');
    await worker.tick();
    assert.equal((await run(budget.data.run.id)).data.errorCode, 'ENTERPRISE_BUDGET_EXCEEDED');
    assert.equal(llmCalls.length, before);
  });

  test('ASTRA-002：provider 回 307 到未核准位址 → Run 失敗、collector 沒收到 prompt、通知管理員與申請者、不重試', async () => {
    await upload('employee', '轉址測試', '合成轉址 交付期限 12/31');
    const before = llmCalls.length;
    const redirected = await startRun('employee', '交付期限', 'redir');
    await worker.tick();
    const result = await run(redirected.data.run.id);
    assert.deepEqual([result.data.status, result.data.errorCode, result.data.attempts], ['failed', 'ENTERPRISE_EGRESS_REDIRECT_DENIED', 1]);
    assert.equal(llmCalls.length, before, 'redirect 目標未收到任何請求');
    const usage = await admin.query("SELECT status, error_code FROM enterprise.model_usage WHERE run_id=$1", [redirected.data.run.id]);
    assert.deepEqual(usage.rows, [{ status: 'denied', error_code: 'ENTERPRISE_EGRESS_REDIRECT_DENIED' }]);
    const adminInbox = (await call('GET', '/api/enterprise/v1/notifications', 'admin')).data.items.filter((n: any) => n.subjectId === redirected.data.run.id);
    const employeeInbox = (await call('GET', '/api/enterprise/v1/notifications', 'employee')).data.items.filter((n: any) => n.subjectId === redirected.data.run.id);
    const approverInbox = (await call('GET', '/api/enterprise/v1/notifications', 'approver')).data.items.filter((n: any) => n.subjectId === redirected.data.run.id);
    assert.deepEqual(adminInbox.map((n: any) => [n.audience, n.severity, n.code]), [['role', 'critical', 'ENTERPRISE_EGRESS_REDIRECT_DENIED']]);
    assert.deepEqual(employeeInbox.map((n: any) => [n.audience, n.severity]), [['direct', 'warning']]);
    assert.match(employeeInbox[0].message, /硬邊界/);
    assert.equal(approverInbox.length, 0);
    assert.ok(!JSON.stringify([...adminInbox, ...employeeInbox]).includes('127.0.0.1'), '通知不含位址');
    // 已讀以成員為單位；看不到的通知不能標已讀
    assert.equal((await call('POST', `/api/enterprise/v1/notifications/${adminInbox[0].id}/read`, 'admin')).data.read, true);
    assert.equal((await call('POST', `/api/enterprise/v1/notifications/${adminInbox[0].id}/read`, 'employee')).status, 404);
    assert.ok((await call('GET', '/api/enterprise/v1/notifications', 'admin')).data.items.find((n: any) => n.id === adminInbox[0].id).readAt);
    assert.equal((await call('GET', '/api/enterprise/v1/notifications', 'beta')).data.items.length, 0, '跨組織看不到');
  });

  test('撤權：申請者在 Run 執行前被停權 → Run 失敗、不呼叫模型；取消 queued Run 不再執行', async () => {
    const before = llmCalls.length;
    const pending = await startRun('employee', '交付期限', 'local-llm');
    await call('POST', `/api/enterprise/v1/members/${member.employee}/disable`, 'admin');
    await worker.tick();
    assert.deepEqual([(await run(pending.data.run.id)).data.status, (await run(pending.data.run.id)).data.errorCode], ['failed', 'ENTERPRISE_PRINCIPAL_REVOKED']);
    assert.equal(llmCalls.length, before);
    await call('POST', `/api/enterprise/v1/members/${member.employee}/enable`, 'admin');
    token.employee = await login('alpha', 'employee@alpha.example.invalid');
    const queued = await startRun('employee', '交付期限', 'local-llm');
    assert.equal((await call('POST', `/api/enterprise/v1/runs/${queued.data.run.id}/cancel`, 'employee')).data.status, 'cancelled');
    assert.equal(await worker.tick(), 0);
    assert.equal(llmCalls.length, before);
  });

  test('暫時性失敗重試至 3 次後失敗；錯誤不含 provider 內容', async () => {
    llmMode = 'fail';
    try {
      const flaky = await startRun('employee', '交付期限', 'local-llm');
      for (let attempt = 1; attempt <= 3; attempt += 1) await worker.tick();
      const state = (await run(flaky.data.run.id)).data;
      assert.deepEqual([state.status, state.attempts, state.errorCode], ['failed', 3, 'ENTERPRISE_PROVIDER_HTTP_ERROR']);
      assert.ok(!JSON.stringify(state).includes('internal detail'));
    } finally {
      llmMode = 'ok';
    }
  });

  test('草稿修改、送審、職責分離、一次性決定、鎖定；匯出只限已核准', async () => {
    const id = member.draft;
    const edited = await call('PUT', `/api/enterprise/v1/drafts/${id}`, 'employee', { json: { expectedRevision: 1, body: '人工修訂：合成甲專案交付期限 12/20 [1]' } });
    assert.equal(edited.data.revision, 2);
    assert.equal((await call('PUT', `/api/enterprise/v1/drafts/${id}`, 'employee', { json: { expectedRevision: 1, body: 'stale' } })).status, 409);
    assert.equal((await call('PUT', `/api/enterprise/v1/drafts/${id}`, 'approver', { json: { expectedRevision: 2, body: '他人改稿' } })).status, 404);
    assert.equal((await call('GET', `/api/enterprise/v1/drafts/${id}/export?format=docx`, 'employee')).status, 409);
    const submitted = await call('POST', `/api/enterprise/v1/drafts/${id}/submit`, 'employee', { json: { expectedRevision: 2 } });
    const confirm = { expectedRevision: submitted.data.revision, expectedSha256: submitted.data.revisionSha256 };
    assert.equal(submitted.status, 201);
    assert.equal((await call('PUT', `/api/enterprise/v1/drafts/${id}`, 'employee', { json: { expectedRevision: 2, body: '送審後再改' } })).status, 409);
    assert.equal((await call('POST', `/api/enterprise/v1/approvals/${submitted.data.approvalId}/decision`, 'employee', { json: { ...confirm, decision: 'approve' } })).status, 403);
    const approved = await call('POST', `/api/enterprise/v1/approvals/${submitted.data.approvalId}/decision`, 'approver', { json: { ...confirm, decision: 'approve', comment: '內容正確' } });
    assert.equal(approved.data.status, 'approved');
    assert.equal((await call('POST', `/api/enterprise/v1/approvals/${submitted.data.approvalId}/decision`, 'approver', { json: { ...confirm, decision: 'reject' } })).status, 409);
    // 審核者自己的草稿不能自己核准
    const own = await startRun('approver', '交付期限', 'mock', '審核者自己的草稿');
    await worker.tick();
    const ownSubmit = await call('POST', `/api/enterprise/v1/drafts/${(await run(own.data.run.id)).data.draftId}/submit`, 'approver', { json: { expectedRevision: 1 } });
    const self = await call('POST', `/api/enterprise/v1/approvals/${ownSubmit.data.approvalId}/decision`, 'approver', { json: { decision: 'approve', expectedRevision: 1, expectedSha256: ownSubmit.data.revisionSha256 } });
    assert.equal(self.status, 403);
    assert.equal(self.data.error.code, 'ENTERPRISE_SELF_APPROVAL_FORBIDDEN');
    // 匯出 DOCX：可解析、含正文與來源附錄、SHA 與紀錄一致
    const docx = await call('GET', `/api/enterprise/v1/drafts/${id}/export?format=docx`, 'employee');
    assert.equal(docx.status, 200);
    const xml = await (await JSZip.loadAsync(docx.data)).file('word/document.xml')!.async('string');
    assert.match(xml, /人工修訂：合成甲專案交付期限 12\/20/);
    assert.match(xml, /— 來源 —/);
    assert.equal(docx.headers.get('x-dhc-content-sha256'), createHash('sha256').update(docx.data).digest('hex'));
    const recorded = await admin.query('SELECT revision, format, sha256 FROM enterprise.draft_exports WHERE draft_id=$1', [id]);
    assert.deepEqual(recorded.rows.map(row => [row.revision, row.format, row.sha256]), [[2, 'docx', docx.headers.get('x-dhc-content-sha256')]]);
    assert.deepEqual([docx.headers.get('x-dhc-approved-revision'), docx.headers.get('x-dhc-approval-id')], ['2', submitted.data.approvalId]);
    const markdown = await call('GET', `/api/enterprise/v1/drafts/${id}/export?format=markdown`, 'employee');
    assert.match(markdown.data.toString('utf8'), /^# 週報草稿/);
  });

  test('跨組織：beta 看不到 alpha 的 Run、草稿、審批', async () => {
    const runs = await call('GET', '/api/enterprise/v1/runs', 'beta');
    assert.deepEqual(runs.data.items, []);
    assert.equal((await call('GET', `/api/enterprise/v1/drafts/${member.draft}`, 'beta')).status, 404);
    const pending = await call('GET', '/api/enterprise/v1/approvals', 'admin');
    if (pending.data.items[0]) assert.equal((await call('POST', `/api/enterprise/v1/approvals/${pending.data.items[0].id}/decision`, 'beta', { json: { decision: 'approve' } })).status, 404);
  });

  test('方案權益：席位上限、Run 上限、到期唯讀但可讀可匯出；客戶端無法改訂閱', async () => {
    const subscription = await call('GET', '/api/enterprise/v1/subscription', 'admin');
    assert.equal(subscription.data.subscription.planKey, 'pilot');
    assert.equal(subscription.data.usage.activeSeats, 3);
    const seat = await call('POST', '/api/enterprise/v1/members', 'admin', { json: { email: 'fourth@alpha.example.invalid', password: PASSWORD, roles: ['employee'] } });
    assert.equal(seat.status, 403);
    assert.equal(seat.data.error.code, 'ENTERPRISE_SEAT_LIMIT');
    await admin.query("UPDATE enterprise.subscriptions SET monthly_run_limit=(SELECT count(*) FROM enterprise.runs r JOIN enterprise.organizations o ON o.id=r.organization_id WHERE o.slug='alpha') WHERE organization_id=(SELECT id FROM enterprise.organizations WHERE slug='alpha')");
    const limited = await startRun('employee', '交付期限', 'mock');
    assert.equal(limited.status, 429);
    await setEnterpriseSubscriptionBySlug(migrator, { slug: 'alpha', planKey: 'pilot', status: 'expired', periodStart: '2026-10-01', periodEnd: '2026-10-21', reason: 'test expiry', actor: 'test' });
    assert.equal((await upload('employee', '到期後上傳', '內容')).status, 402);
    assert.equal((await startRun('employee', '交付期限', 'mock')).status, 402);
    assert.equal((await call('GET', '/api/enterprise/v1/documents', 'employee')).status, 200);
    assert.equal((await call('GET', `/api/enterprise/v1/drafts/${member.draft}/export?format=markdown`, 'employee')).status, 200);
    const events = await admin.query("SELECT actor, reason FROM enterprise.subscription_events WHERE organization_id=(SELECT id FROM enterprise.organizations WHERE slug='alpha') ORDER BY created_at");
    assert.deepEqual(events.rows.map(row => row.actor), ['bootstrap', 'test']);
    await assert.rejects(runtime.query("UPDATE enterprise.subscriptions SET status='active'"), { code: '42501' });
    // beta 不受 alpha 狀態影響，也看不到 alpha 用量
    const betaUsage = await call('GET', '/api/enterprise/v1/subscription', 'beta');
    assert.equal(betaUsage.data.usage.runsThisMonth, 0);
  });
});
