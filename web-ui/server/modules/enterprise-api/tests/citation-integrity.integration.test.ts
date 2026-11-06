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
const SECRET_KEY = Buffer.alloc(32, 9).toString('base64');

/**
 * ASTRA-007：引用編號必須對應伺服器寫入的引用 metadata，且來源片段在本組織存在、版本一致、hash 未漂移。
 * 無效或沒有引用的修訂不能送審、核准或匯出；人工修改後重驗；來源事後漂移會讓既有核准無法匯出。
 * 不宣稱能自動證明自然語言主張的語義正確。
 */
describe('ASTRA-007 引用完整性（實際 PostgreSQL、loopback 假模型）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 8 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  const worker = createEnterpriseRunWorker(runtime, { secretKey: SECRET_KEY, timeoutMs: 10_000 });
  let server: http.Server;
  let fakeLlm: http.Server;
  let base = '';
  let blobRoot = '';
  let modelText = '';
  const token: Record<string, string> = {};

  async function call(method: string, route: string, who: string, json?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token[who]}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: json === undefined ? undefined : JSON.stringify(json) });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, data: (type.includes('json') ? await response.json() : await response.text()) as any };
  }
  const login = async (who: string, slug: string, email: string) => {
    token[who] = (await (await fetch(base + '/api/enterprise/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationSlug: slug, email, password: PASSWORD }) })).json() as any).token;
  };
  const upload = (who: string, title: string, text: string) => fetch(base + '/api/enterprise/v1/documents', { method: 'POST', body: Buffer.from(text),
    headers: { authorization: `Bearer ${token[who]}`, 'content-type': 'text/plain', 'x-dhc-title': encodeURIComponent(title), 'x-dhc-filename': 'c.txt' } });
  let keys = 0;
  /** 讓假模型回 text，跑完 worker，回傳草稿。 */
  async function generate(text: string, who = 'employee', provider = 'local') {
    modelText = text;
    const started = await call('POST', '/api/enterprise/v1/runs/draft-generation', who, { title: '引用測試', query: '交付期限', providerKey: provider },
      { 'idempotency-key': `cite-key-${(keys += 1).toString().padStart(4, '0')}` });
    assert.equal(started.status, 202);
    await worker.tick();
    const run = (await call('GET', `/api/enterprise/v1/runs/${started.data.run.id}`, who)).data;
    assert.equal(run.status, 'succeeded');
    return (await call('GET', `/api/enterprise/v1/drafts/${run.draftId}`, who)).data;
  }
  const revise = (draft: any, body: string) => call('PUT', `/api/enterprise/v1/drafts/${draft.draft.id}`, 'employee', { body, expectedRevision: draft.draft.currentRevision });
  /** 送審帶作者眼前的版號（ASTRA-V3-NEW-001 契約）。 */
  const submit = async (draftId: string) => call('POST', `/api/enterprise/v1/drafts/${draftId}/submit`, 'employee', { expectedRevision: (await draftOf(draftId)).draft.currentRevision });
  /** 審批者確認的版號與 hash（取自送審回應）。 */
  const confirm = (submitted: { data: { revision: number; revisionSha256: string } }) => ({ expectedRevision: submitted.data.revision, expectedSha256: submitted.data.revisionSha256 });
  const draftOf = async (draftId: string) => (await call('GET', `/api/enterprise/v1/drafts/${draftId}`, 'employee')).data;

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
    for (const slug of ['delta', 'omega']) {
      await bootstrapEnterpriseOrganization(migrator, { slug, name: slug, adminEmail: `admin@${slug}.example.invalid`, adminPassword: PASSWORD });
      await setEnterpriseSubscriptionBySlug(migrator, { slug, planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    }
    const llm = express();
    llm.use(express.json());
    llm.post('/v1/chat/completions', (_req, res) => { res.json({ choices: [{ message: { content: modelText } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }); });
    fakeLlm = http.createServer(llm);
    await new Promise<void>(resolve => fakeLlm.listen(0, '127.0.0.1', resolve));
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-cite-')), 'blobs');
    const app = express();
    app.use('/api/enterprise/v1', createEnterpriseRouter({ pool: runtime, blobStore: createLocalDocumentBlobStore(blobRoot), maxDocumentBytes: 1024 * 1024, secretKey: SECRET_KEY }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await login('admin', 'delta', 'admin@delta.example.invalid');
    await login('omega', 'omega', 'admin@omega.example.invalid');
    for (const [name, roles] of [['approver', ['approver']], ['employee', ['employee']]] as const) {
      assert.equal((await call('POST', '/api/enterprise/v1/members', 'admin', { email: `${name}@delta.example.invalid`, password: PASSWORD, roles })).status, 201);
      await login(name, 'delta', `${name}@delta.example.invalid`);
    }
    const llmUrl = `http://127.0.0.1:${(fakeLlm.address() as AddressInfo).port}/v1`;
    for (const who of ['admin', 'omega']) {
      assert.equal((await call('PUT', '/api/enterprise/v1/models/providers', who, { key: 'local', kind: 'openai_compatible', baseUrl: llmUrl, model: 'synthetic', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 10_000_000 })).status, 200);
    }
    assert.equal((await upload('employee', '丁專案', '合成丁專案 交付期限 2/28')).status, 201);
    assert.equal((await upload('omega', '他組織', '合成他組織 交付期限 9/9')).status, 201);
  });
  after(async () => {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => fakeLlm.close(resolve))]);
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('模型捏造 [999]：修訂標記 INVALID、列出原因；送審被拒', async () => {
    const draft = await generate('依來源 [1]，交付期限 2/28；另據 [999] 已延期。');
    assert.equal(draft.revision.citationStatus, 'INVALID');
    assert.deepEqual(draft.revision.citationReport.invalid, [{ index: 999, reason: 'MISSING_METADATA' }]);
    assert.deepEqual(draft.revision.citationReport.cited, [1, 999], 'cited＝內文出現的全部標記；無效者另列於 invalid');
    const refused = await submit(draft.draft.id);
    assert.deepEqual([refused.status, refused.data.error?.code], [409, 'ENTERPRISE_CITATION_INVALID']);
    assert.equal((await draftOf(draft.draft.id)).draft.status, 'draft');
  });

  test('全形括號［2］同樣視為引用並驗證', async () => {
    const draft = await generate('交付期限 2/28［2］。');
    assert.equal(draft.revision.citationStatus, 'INVALID');
    assert.deepEqual(draft.revision.citationReport.invalid, [{ index: 2, reason: 'MISSING_METADATA' }]);
  });

  test('沒有任何引用的模型輸出：UNCITED（來源不足的明確狀態），不能送審', async () => {
    const draft = await generate('交付期限應為 2/28。');
    assert.equal(draft.revision.citationStatus, 'UNCITED');
    assert.equal((await submit(draft.draft.id)).data.error?.code, 'ENTERPRISE_CITATION_INVALID');
  });

  test('人工修正為 [1] → VALID，可送審、核准、匯出；人工加上 [5] → INVALID', async () => {
    const draft = await generate('依來源 [1] 與 [999]。');
    const fixed = await revise(draft, '依來源 [1]，交付期限 2/28。');
    assert.equal(fixed.status, 200);
    assert.equal(fixed.data.citationStatus, 'VALID');
    const again = await revise(await draftOf(draft.draft.id), '依來源 [1]，另見 [5]。');
    assert.deepEqual([again.data.citationStatus, again.data.citationReport.invalid], ['INVALID', [{ index: 5, reason: 'MISSING_METADATA' }]]);
    const valid = await revise(await draftOf(draft.draft.id), '依來源 [1]，交付期限 2/28。');
    assert.equal(valid.data.citationStatus, 'VALID');
    const submitted = await submit(draft.draft.id);
    assert.equal(submitted.status, 201);
    assert.equal((await call('POST', `/api/enterprise/v1/approvals/${submitted.data.approvalId}/decision`, 'approver', { ...confirm(submitted), decision: 'approve' })).status, 200);
    assert.equal((await call('GET', `/api/enterprise/v1/drafts/${draft.draft.id}/export?format=markdown`, 'employee')).status, 200);
  });

  test('來源片段 hash 漂移：送審後核准被拒；已核准的草稿也不能再匯出', async () => {
    const pending = await generate('依來源 [1]，交付期限 2/28。');
    const approvedDraft = await generate('依來源 [1]，交付期限 2/28。');
    const first = await submit(pending.draft.id);
    const second = await submit(approvedDraft.draft.id);
    assert.equal((await call('POST', `/api/enterprise/v1/approvals/${second.data.approvalId}/decision`, 'approver', { ...confirm(second), decision: 'approve' })).status, 200);
    assert.equal((await call('GET', `/api/enterprise/v1/drafts/${approvedDraft.draft.id}/export?format=markdown`, 'employee')).status, 200);
    const chunkId = pending.revision.citations[0].chunkId;
    // 模擬儲存層遭竄改（runtime 角色無權修改 chunk；以 bootstrap 管理連線直接改）
    await admin.query("ALTER TABLE enterprise.document_chunks NO FORCE ROW LEVEL SECURITY");
    try {
      await admin.query("UPDATE enterprise.document_chunks SET text = text || '（竄改）' WHERE id=$1", [chunkId]);
    } finally {
      await admin.query("ALTER TABLE enterprise.document_chunks FORCE ROW LEVEL SECURITY");
    }
    const decision = await call('POST', `/api/enterprise/v1/approvals/${first.data.approvalId}/decision`, 'approver', { ...confirm(first), decision: 'approve' });
    assert.deepEqual([decision.status, decision.data.error?.code], [409, 'ENTERPRISE_CITATION_INVALID']);
    assert.equal((await call('POST', `/api/enterprise/v1/approvals/${first.data.approvalId}/decision`, 'approver', { ...confirm(first), decision: 'reject', comment: '來源已變動' })).status, 200, '拒絕仍可');
    const exported = await call('GET', `/api/enterprise/v1/drafts/${approvedDraft.draft.id}/export?format=markdown`, 'employee');
    assert.deepEqual([exported.status, exported.data.error?.code], [409, 'ENTERPRISE_CITATION_INVALID']);
    const report = (await draftOf(approvedDraft.draft.id)).revision;
    assert.equal(report.citationStatus, 'INVALID');
    assert.equal(report.citationReport.invalid[0].reason, 'HASH_MISMATCH');
  });

  test('引用 metadata 指向他組織片段：視為來源不存在', async () => {
    const draft = await generate('依來源 [1]，交付期限 2/28。');
    modelText = '依來源 [1]，交付期限 9/9。';
    const foreign = await call('POST', '/api/enterprise/v1/runs/draft-generation', 'omega', { title: 'x', query: '交付期限', providerKey: 'local' }, { 'idempotency-key': 'omega-key-0001' });
    await worker.tick();
    const foreignRun = (await call('GET', `/api/enterprise/v1/runs/${foreign.data.run.id}`, 'omega')).data;
    const foreignChunk = (await call('GET', `/api/enterprise/v1/drafts/${foreignRun.draftId}`, 'omega')).data.revision.citations[0].chunkId;
    // 模擬 metadata 遭竄改成他組織 chunk（應用程式不會產生這種資料）
    await admin.query("ALTER TABLE enterprise.draft_revisions NO FORCE ROW LEVEL SECURITY");
    try {
      await admin.query(`UPDATE enterprise.draft_revisions SET citations = jsonb_set(citations, '{0,chunkId}', to_jsonb($2::text)) WHERE draft_id=$1`, [draft.draft.id, foreignChunk]);
    } finally {
      await admin.query("ALTER TABLE enterprise.draft_revisions FORCE ROW LEVEL SECURITY");
    }
    const refused = await submit(draft.draft.id);
    assert.equal(refused.data.error?.code, 'ENTERPRISE_CITATION_INVALID');
    assert.equal((await draftOf(draft.draft.id)).revision.citationReport.invalid[0].reason, 'SOURCE_NOT_FOUND');
  });
});
