import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Pool } from 'pg';

import { createEnterprisePersistence, createLocalDocumentBlobStore, runEnterpriseMigrations } from '../index.js';

const database = process.env.E02A_TEST_DATABASE;
const directory = path.resolve('db/enterprise/migrations');
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const sha = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const ORG_A = id(1);
const ORG_B = id(2);

// 與既有 enterprise.integration.test.ts 共用同一個合成 QA DB；QA 驅動程式必須逐檔序列執行。
describe('E05-DOC-01 文件版本／內容 hash／storage adapter（實際 PostgreSQL，合成資料）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 4 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  let blobRoot: string;
  let persistenceA: ReturnType<typeof createEnterprisePersistence>;
  let persistenceB: ReturnType<typeof createEnterprisePersistence>;
  const text = (value: string) => ({ filename: '合成紀錄.txt', mediaType: 'text/plain', content: Buffer.from(value) });

  async function resetSchema() {
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
  }

  async function seed() {
    await admin.query(`INSERT INTO enterprise.organizations(id,slug,name) VALUES ($1,'synthetic-a','合成公司A'),($2,'synthetic-b','合成公司B')`, [ORG_A, ORG_B]);
    await admin.query(`INSERT INTO enterprise.user_accounts(id,organization_id,email) VALUES ($1,$2,'same@example.invalid'),($3,$4,'same@example.invalid'),($5,$2,'second@example.invalid')`, [id(101), ORG_A, id(102), ORG_B, id(103)]);
    await admin.query('INSERT INTO enterprise.org_members(id,organization_id,user_account_id) VALUES ($1,$2,$3),($4,$5,$6),($7,$2,$8)', [id(201), ORG_A, id(101), id(202), ORG_B, id(102), id(203), id(103)]);
  }

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    blobRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'dhc-e05-pg-')), 'blobs');
    const blobStore = createLocalDocumentBlobStore(blobRoot);
    persistenceA = createEnterprisePersistence(runtime, async () => ({ userAccountId: id(101) }), { blobStore });
    persistenceB = createEnterprisePersistence(runtime, async () => ({ userAccountId: id(102) }), { blobStore });
    await resetSchema();
    assert.equal((await runEnterpriseMigrations(migrator, { directory, direction: 'up' })).applied, true);
    await seed();
  });
  after(async () => {
    await Promise.all([admin.end(), migrator.end(), runtime.end()]);
    await rm(path.dirname(blobRoot), { recursive: true, force: true });
  });

  test('migration：兩個版本依序記錄、重跑 no-op；新表 FORCE RLS；runtime 只有 SELECT/INSERT', async () => {
    const history = await admin.query<{ version: string }>('SELECT version FROM enterprise.schema_migrations ORDER BY version');
    assert.deepEqual(history.rows.map(row => row.version), ['0001_enterprise_base', '0002_document_versions', '0003_identity_sessions', '0004_document_index', '0005_workflow_models', '0006_subscriptions', '0007_egress_notifications', '0008_run_quarantine', '0009_citation_integrity', '0010_usage_ledger', '0011_approval_revision_binding', '0012_reconciliations', '0013_ops_reports', '0014_reconciliation_exports']);
    assert.equal((await runEnterpriseMigrations(migrator, { directory, direction: 'up' })).applied, false);
    const rls = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='enterprise'::regnamespace AND relname IN ('document_blobs','document_versions') ORDER BY relname");
    assert.deepEqual(rls.rows, [
      { relname: 'document_blobs', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'document_versions', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const grants = await admin.query<{ table_name: string; privilege_type: string }>(
      "SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee='dhc_app' AND table_schema='enterprise' AND table_name IN ('document_blobs','document_versions') ORDER BY 1,2");
    assert.deepEqual(grants.rows.map(row => `${row.table_name}:${row.privilege_type}`),
      ['document_blobs:INSERT', 'document_blobs:SELECT', 'document_versions:INSERT', 'document_versions:SELECT']);
  });

  test('建立文件即寫入第 1 版：伺服器計算 hash、blob 存在 org 目錄、audit 兩筆', async () => {
    const input = text('A 公司第 1 版');
    const { document, version } = await persistenceA.withOrganization(ORG_A, s => s.createDocumentWithVersion({ title: 'A 版本文件', ...input }));
    assert.equal(document.organizationId, ORG_A);
    assert.deepEqual({ ...version, id: undefined, createdAt: undefined }, {
      id: undefined, createdAt: undefined, organizationId: ORG_A, documentId: document.id, versionNumber: 1,
      filename: '合成紀錄.txt', mediaType: 'text/plain', byteSize: input.content.length, sha256: sha(input.content), createdByMemberId: id(201),
    });
    assert.deepEqual(await readFile(path.join(blobRoot, ORG_A, sha(input.content).slice(0, 2), sha(input.content))), input.content);
    const events = await persistenceA.withOrganization(ORG_A, s => s.listAuditEvents());
    // 同一交易內 now() 相同，occurred_at 排序後以 uuid 決定先後；只比對集合。
    const forDocument = events.filter(event => event.resourceId === document.id).map(event => event.action).sort();
    assert.deepEqual(forDocument, ['document.created', 'document.version_created']);
  });

  test('新增版本需 expectedLatestVersion；過期的期望值回 VERSION_CONFLICT；內容可逐版讀回', async () => {
    const v1 = text('第一版內容');
    const v2 = text('第二版內容');
    const { document } = await persistenceA.withOrganization(ORG_A, s => s.createDocumentWithVersion({ title: '多版本', ...v1 }));
    const second = await persistenceA.withOrganization(ORG_A, s => s.addDocumentVersion(document.id, { expectedLatestVersion: 1, ...v2 }));
    assert.equal(second.versionNumber, 2);
    await assert.rejects(persistenceA.withOrganization(ORG_A, s => s.addDocumentVersion(document.id, { expectedLatestVersion: 1, ...text('過期') })), /ENTERPRISE_VERSION_CONFLICT/);
    await assert.rejects(persistenceA.withOrganization(ORG_A, s => s.addDocumentVersion(document.id, { expectedLatestVersion: 0, ...text('以為沒有版本') })), /ENTERPRISE_VERSION_CONFLICT/);
    await assert.rejects(persistenceA.withOrganization(ORG_A, s => s.addDocumentVersion(document.id, { expectedLatestVersion: -1, ...text('非法') })), /ENTERPRISE_INVALID_VERSION/);
    await persistenceA.withOrganization(ORG_A, async s => {
      assert.deepEqual((await s.listDocumentVersions(document.id)).map(row => row.versionNumber), [1, 2]);
      assert.deepEqual((await s.readDocumentVersionContent(document.id, 1)).content, v1.content);
      const read = await s.readDocumentVersionContent(document.id, 2);
      assert.deepEqual(read.content, v2.content);
      assert.equal(read.version.sha256, sha(v2.content));
      assert.equal(await s.getDocumentVersion(document.id, 3), undefined);
    });
  });

  test('並行新增同一版本號：恰好一個成功、另一個 VERSION_CONFLICT，不留下重複版本', async () => {
    const { document } = await persistenceA.withOrganization(ORG_A, s => s.createDocumentWithVersion({ title: '並行', ...text('base') }));
    const results = await Promise.allSettled([
      persistenceA.withOrganization(ORG_A, s => s.addDocumentVersion(document.id, { expectedLatestVersion: 1, ...text('並行一') })),
      persistenceA.withOrganization(ORG_A, s => s.addDocumentVersion(document.id, { expectedLatestVersion: 1, ...text('並行二') })),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(rejected.reason), /ENTERPRISE_VERSION_CONFLICT/);
    assert.deepEqual((await persistenceA.withOrganization(ORG_A, s => s.listDocumentVersions(document.id))).map(row => row.versionNumber), [1, 2]);
  });

  test('跨組織：B 無法列出、讀取或新增 A 的版本；拒絕時不寫入 B 的 blob', async () => {
    const { document } = await persistenceA.withOrganization(ORG_A, s => s.createDocumentWithVersion({ title: '只屬於 A', ...text('A 的機密合成內容') }));
    await persistenceB.withOrganization(ORG_B, async s => {
      await assert.rejects(s.listDocumentVersions(document.id), /ENTERPRISE_DOCUMENT_NOT_FOUND/);
      assert.equal(await s.getDocumentVersion(document.id, 1), undefined);
      await assert.rejects(s.readDocumentVersionContent(document.id, 1), /ENTERPRISE_DOCUMENT_NOT_FOUND/);
    });
    const bDirBefore = await readdir(path.join(blobRoot, ORG_B)).catch(() => []);
    const injected = text('B 想塞進 A 文件的內容');
    await assert.rejects(persistenceB.withOrganization(ORG_B, s => s.addDocumentVersion(document.id, { expectedLatestVersion: 1, ...injected })), /ENTERPRISE_DOCUMENT_NOT_FOUND/);
    assert.deepEqual(await readdir(path.join(blobRoot, ORG_B)).catch(() => []), bDirBefore);
    // 用 A 的 org selector 也進不去：B 的 principal 不是 A 的成員
    await assert.rejects(persistenceB.withOrganization(ORG_A, s => s.listDocumentVersions(document.id)), /ENTERPRISE_SCOPE_DENIED/);
  });

  test('相同內容在不同組織各自一筆 blob；同組織內重用同一筆 blob', async () => {
    const same = text('兩家公司剛好相同的合成內容');
    await persistenceA.withOrganization(ORG_A, s => s.createDocumentWithVersion({ title: 'A 同內容 1', ...same }));
    await persistenceA.withOrganization(ORG_A, s => s.createDocumentWithVersion({ title: 'A 同內容 2', ...same }));
    await persistenceB.withOrganization(ORG_B, s => s.createDocumentWithVersion({ title: 'B 同內容', ...same }));
    const rows = await admin.query<{ organization_id: string; n: number }>(
      'SELECT organization_id,count(*)::int AS n FROM enterprise.document_blobs WHERE sha256=$1 GROUP BY organization_id ORDER BY organization_id', [sha(same.content)]);
    assert.deepEqual(rows.rows, [{ organization_id: ORG_A, n: 1 }, { organization_id: ORG_B, n: 1 }]);
  });

  test('資料層防線：無 scope 看不到；跨組織 FK 與 RLS WITH CHECK 拒絕；runtime 不能 UPDATE/DELETE', async () => {
    const client = await runtime.connect();
    try {
      assert.equal((await client.query('SELECT * FROM enterprise.document_versions')).rowCount, 0);
      assert.equal((await client.query('SELECT * FROM enterprise.document_blobs')).rowCount, 0);
      const bBlob = (await admin.query<{ id: string }>('SELECT id FROM enterprise.document_blobs WHERE organization_id=$1 LIMIT 1', [ORG_B])).rows[0].id;
      const aDocument = (await admin.query<{ id: string }>('SELECT id FROM enterprise.documents WHERE organization_id=$1 LIMIT 1', [ORG_A])).rows[0].id;
      const attempts: Array<[string, unknown[], string]> = [
        ['INSERT INTO enterprise.document_versions(organization_id,document_id,version_number,blob_id,filename,media_type,created_by_member_id) VALUES ($1,$2,99,$3,$4,$5,$6)', [ORG_A, aDocument, bBlob, 'x.txt', 'text/plain', id(201)], '23503'],
        ['INSERT INTO enterprise.document_blobs(organization_id,sha256,byte_size) VALUES ($1,$2,1)', [ORG_B, '1'.repeat(64)], '42501'],
        ['UPDATE enterprise.document_versions SET filename=$1', ['changed.txt'], '42501'],
        ['DELETE FROM enterprise.document_blobs', [], '42501'],
        ['UPDATE enterprise.document_blobs SET byte_size=2', [], '42501'],
      ];
      for (const [statement, values, code] of attempts) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('dhc.organization_id',$1,true)", [ORG_A]);
        await assert.rejects(client.query(statement, values), { code }, statement);
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  test('內容驗證失敗或檔案被竄改：交易回退、不建立文件；讀取竄改內容回 BLOB_INTEGRITY', async () => {
    const before = (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM enterprise.documents')).rows[0].n;
    await assert.rejects(persistenceA.withOrganization(ORG_A, s => s.createDocumentWithVersion({
      title: '假 PDF', filename: 'x.pdf', mediaType: 'application/pdf', content: Buffer.from('not a pdf') })), /ENTERPRISE_DOCUMENT_TYPE_MISMATCH/);
    await assert.rejects(persistenceA.withOrganization(ORG_A, s => s.createDocumentWithVersion({ title: '', ...text('x') })), /ENTERPRISE_INVALID_TEXT/);
    assert.equal((await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM enterprise.documents')).rows[0].n, before);
    const tampered = text('稍後會被竄改');
    const { document } = await persistenceA.withOrganization(ORG_A, s => s.createDocumentWithVersion({ title: '竄改', ...tampered }));
    await writeFile(path.join(blobRoot, ORG_A, sha(tampered.content).slice(0, 2), sha(tampered.content)), 'tampered');
    await assert.rejects(persistenceA.withOrganization(ORG_A, s => s.readDocumentVersionContent(document.id, 1)), /ENTERPRISE_BLOB_INTEGRITY/);
  });

  test('停權成員與未設定 blob store：拒絕且不執行 callback', async () => {
    const persistenceA2 = createEnterprisePersistence(runtime, async () => ({ userAccountId: id(103) }), { blobStore: createLocalDocumentBlobStore(blobRoot) });
    let called = false;
    await admin.query("UPDATE enterprise.org_members SET status='disabled' WHERE id=$1", [id(203)]);
    try {
      await assert.rejects(persistenceA2.withOrganization(ORG_A, async s => { called = true; return s.listDocuments(); }), /ENTERPRISE_SCOPE_DENIED/);
    } finally {
      await admin.query("UPDATE enterprise.org_members SET status='active' WHERE id=$1", [id(203)]);
    }
    assert.equal(called, false);
    const noStore = createEnterprisePersistence(runtime, async () => ({ userAccountId: id(101) }));
    await assert.rejects(noStore.withOrganization(ORG_A, s => s.createDocumentWithVersion({ title: '無 store', ...text('x') })), /ENTERPRISE_BLOB_STORE_UNCONFIGURED/);
    // 既有 metadata-only API 不受影響
    assert.equal((await noStore.withOrganization(ORG_A, s => s.createDocument({ title: 'metadata only' }))).organizationId, ORG_A);
  });

  test('0002 checksum 被改動時拒絕，既有資料不受影響', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'dhc-e05-migrations-'));
    try {
      for (const file of await readdir(directory)) await copyFile(path.join(directory, file), path.join(temporary, file));
      await writeFile(path.join(temporary, '0002_document_versions.up.sql'), (await readFile(path.join(directory, '0002_document_versions.up.sql'), 'utf8')) + '\n-- tampered\n');
      await assert.rejects(runEnterpriseMigrations(migrator, { directory: temporary, direction: 'up' }), /ENTERPRISE_MIGRATION_CHECKSUM_MISMATCH/);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    assert.ok((await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM enterprise.document_versions')).rows[0].n > 0);
  });

  test('有資料 Down 必須明確許可；許可後依反序移除兩版，可再 Up', async () => {
    await assert.rejects(runEnterpriseMigrations(migrator, { directory, direction: 'down' }), /ENTERPRISE_DOWN_REQUIRES_ALLOW_DATA_LOSS/);
    const forced = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='enterprise'::regnamespace AND relkind='r' AND relname <> 'schema_migrations' AND NOT relforcerowsecurity");
    assert.equal(forced.rows[0].n, 0);
    assert.equal((await runEnterpriseMigrations(migrator, { directory, direction: 'down', allowDataLoss: true })).applied, true);
    const remaining = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='enterprise' AND tablename <> 'schema_migrations'");
    assert.equal(remaining.rows[0].n, 0);
    assert.equal((await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM enterprise.schema_migrations')).rows[0].n, 0);
    assert.equal((await runEnterpriseMigrations(migrator, { directory, direction: 'up' })).applied, true);
  });

  test('從只有 0001 且含 E02b 資料的既有資料庫升級：只套用之後的版本，舊資料保留', async () => {
    await resetSchema();
    // 模擬 E02b 已部署狀態：以 migrator 身分執行 0001 並寫入與舊 migrator 相同格式的 history 列。
    const up1 = await readFile(path.join(directory, '0001_enterprise_base.up.sql'), 'utf8');
    const down1 = await readFile(path.join(directory, '0001_enterprise_base.down.sql'), 'utf8');
    const checksum1 = createHash('sha256').update(up1).update('\0').update(down1).digest('hex');
    const client = await migrator.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TABLE enterprise.schema_migrations (version text PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'), applied_at timestamptz NOT NULL DEFAULT now())`);
      await client.query(up1);
      await client.query('INSERT INTO enterprise.schema_migrations(version,checksum) VALUES ($1,$2)', ['0001_enterprise_base', checksum1]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await seed();
    const legacy = createEnterprisePersistence(runtime, async () => ({ userAccountId: id(101) }));
    const oldDocument = await legacy.withOrganization(ORG_A, s => s.createDocument({ title: '升級前的 E02b 文件' }));
    const result = await runEnterpriseMigrations(migrator, { directory, direction: 'up' });
    assert.equal(result.applied, true);
    assert.deepEqual(result.appliedVersions, ['0002_document_versions', '0003_identity_sessions', '0004_document_index', '0005_workflow_models', '0006_subscriptions', '0007_egress_notifications', '0008_run_quarantine', '0009_citation_integrity', '0010_usage_ledger', '0011_approval_revision_binding', '0012_reconciliations', '0013_ops_reports', '0014_reconciliation_exports']);
    assert.equal((await persistenceA.withOrganization(ORG_A, s => s.getDocument(oldDocument.id)))?.title, '升級前的 E02b 文件');
    const added = await persistenceA.withOrganization(ORG_A, s => s.addDocumentVersion(oldDocument.id, { expectedLatestVersion: 0, ...text('升級後補上的第 1 版') }));
    assert.equal(added.versionNumber, 1);
  });

  test('history 有缺口（只有 0002 沒有 0001）時拒絕', async () => {
    await admin.query("DELETE FROM enterprise.schema_migrations WHERE version='0001_enterprise_base'");
    await assert.rejects(runEnterpriseMigrations(migrator, { directory, direction: 'up' }), /ENTERPRISE_MIGRATION_HISTORY_GAP/);
  });
});
