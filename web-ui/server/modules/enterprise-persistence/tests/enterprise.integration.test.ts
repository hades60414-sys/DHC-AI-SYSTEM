import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { after, before, describe, test } from 'node:test';

import { Pool } from 'pg';

import { createEnterprisePersistence, runEnterpriseMigrations } from '../index.js';

const database = process.env.E02A_TEST_DATABASE;
const directory = path.resolve('db/enterprise/migrations');
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

describe('Enterprise 實際 PostgreSQL（只允許明確標記的合成 QA DB）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 2 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  const persistenceA = createEnterprisePersistence(runtime, async () => ({ userAccountId: id(101) }));
  const persistenceB = createEnterprisePersistence(runtime, async () => ({ userAccountId: id(102) }));

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    assert.equal((await runEnterpriseMigrations(migrator, { directory, direction: 'up' })).applied, true);
    await admin.query(`INSERT INTO enterprise.organizations(id,slug,name) VALUES ($1,'synthetic-a','合成公司A'),($2,'synthetic-b','合成公司B')`, [id(1), id(2)]);
    await admin.query(`INSERT INTO enterprise.user_accounts(id,organization_id,email) VALUES ($1,$2,'same@example.invalid'),($3,$4,'same@example.invalid')`, [id(101), id(1), id(102), id(2)]);
    await admin.query('INSERT INTO enterprise.org_members(id,organization_id,user_account_id) VALUES ($1,$2,$3),($4,$5,$6)', [id(201), id(1), id(101), id(202), id(2), id(102)]);
    await admin.query(`INSERT INTO enterprise.roles(id,organization_id,key,name) VALUES ($1,$2,'employee','員工'),($3,$4,'employee','員工')`, [id(301), id(1), id(302), id(2)]);
    await admin.query('INSERT INTO enterprise.org_member_roles(organization_id,org_member_id,role_id) VALUES ($1,$2,$3),($4,$5,$6)', [id(1), id(201), id(301), id(2), id(202), id(302)]);
  });
  after(async () => { await Promise.all([admin.end(), migrator.end(), runtime.end()]); });

  test('Migration up 重跑為 no-op，版本不重複', async () => {
    assert.equal((await runEnterpriseMigrations(migrator, { directory, direction: 'up' })).applied, false);
    // E05-DOC-01 起有兩個已知版本；斷言仍是「每個版本恰好一列、重跑不重複」。
    assert.deepEqual((await admin.query('SELECT version FROM enterprise.schema_migrations ORDER BY version')).rows.map(row => row.version),
      ['0001_enterprise_base', '0002_document_versions', '0003_identity_sessions', '0004_document_index', '0005_workflow_models', '0006_subscriptions', '0007_egress_notifications', '0008_run_quarantine', '0009_citation_integrity', '0010_usage_ledger', '0011_approval_revision_binding', '0012_reconciliations', '0013_ops_reports', '0014_reconciliation_exports']);
  });

  test('Scoped repository 與可信身分核對，不能以 org selector 越權', async () => {
    const taskA = await persistenceA.withOrganization(id(1), service => service.createTask({ title: 'A的合成任務' }));
    const taskB = await persistenceB.withOrganization(id(2), service => service.createTask({ title: 'B的合成任務' }));
    assert.equal(taskA.organizationId, id(1));
    assert.equal(await persistenceA.withOrganization(id(1), service => service.getTask(taskB.id)), undefined);
    await assert.rejects(persistenceA.withOrganization(id(2), service => service.listTasks()), /ENTERPRISE_SCOPE_DENIED/);
    assert.equal((await persistenceB.withOrganization(id(2), service => service.listTasks())).every(row => row.organizationId === id(2)), true);
  });

  test('文件與稽核事件只在核對的組織內讀寫', async () => {
    const documentA = await persistenceA.withOrganization(id(1), s => s.createDocument({ title: 'A文件' }));
    const documentB = await persistenceB.withOrganization(id(2), s => s.createDocument({ title: 'B文件' }));
    await persistenceA.withOrganization(id(1), async s => {
      assert.equal((await s.getDocument(documentA.id))?.title, 'A文件');
      assert.equal(await s.getDocument(documentB.id), undefined);
      assert.ok((await s.listDocuments()).every(row => row.organizationId === id(1)));
      const events = await s.listAuditEvents();
      assert.ok(events.length >= 2);
      assert.ok(events.every(row => row.organizationId === id(1) && row.actorMemberId === id(201)));
      assert.ok(events.some(row => row.resourceId === documentA.id && row.action === 'document.created'));
    });
  });

  test('未驗證身分、錯誤 UUID 及停權 org/user/member 均拒絕執行 callback', async () => {
    const anonymous = createEnterprisePersistence(runtime, async () => null);
    let called = false;
    const callback = async () => { called = true; };
    await assert.rejects(anonymous.withOrganization(id(1), callback), /ENTERPRISE_AUTH_REQUIRED/);
    await assert.rejects(persistenceA.withOrganization('bad-id', callback), /ENTERPRISE_INVALID_ID/);
    for (const [table, rowId] of [['organizations', id(1)], ['user_accounts', id(101)], ['org_members', id(201)]]) {
      await admin.query(`UPDATE enterprise.${table} SET status='disabled' WHERE id=$1`, [rowId]);
      try { await assert.rejects(persistenceA.withOrganization(id(1), callback), /ENTERPRISE_SCOPE_DENIED/); }
      finally { await admin.query(`UPDATE enterprise.${table} SET status='active' WHERE id=$1`, [rowId]); }
    }
    assert.equal(called, false);
  });

  test('FK 拒絕跨組織 account/member/role/task/document/audit 關聯', async () => {
    const statements = [
      ['INSERT INTO enterprise.org_members(organization_id,user_account_id) VALUES ($1,$2)', [id(1), id(102)]],
      ['INSERT INTO enterprise.org_member_roles(organization_id,org_member_id,role_id) VALUES ($1,$2,$3)', [id(1), id(201), id(302)]],
      ['INSERT INTO enterprise.org_member_roles(organization_id,org_member_id,role_id) VALUES ($1,$2,$3)', [id(1), id(202), id(301)]],
      ["INSERT INTO enterprise.tasks(organization_id,owner_member_id,title) VALUES ($1,$2,'x')", [id(1), id(202)]],
      ["INSERT INTO enterprise.documents(organization_id,owner_member_id,title) VALUES ($1,$2,'x')", [id(1), id(202)]],
      ["INSERT INTO enterprise.audit_events(organization_id,actor_member_id,action,resource_type,resource_id) VALUES ($1,$2,'test','task',$3)", [id(1), id(202), id(999)]],
      ["INSERT INTO enterprise.roles(organization_id,key,name) VALUES ($1,'missing','missing')", [id(999)]],
    ] as const;
    for (const [sql, values] of statements) await assert.rejects(admin.query(sql, [...values]), { code: '23503' });
  });

  test('唯一約束涵蓋 slug、org email、membership、role 與角色關聯', async () => {
    const statements = [
      ["INSERT INTO enterprise.organizations(slug,name) VALUES ('synthetic-a','duplicate')", []],
      ["INSERT INTO enterprise.user_accounts(organization_id,email) VALUES ($1,'same@example.invalid')", [id(1)]],
      ['INSERT INTO enterprise.org_members(organization_id,user_account_id) VALUES ($1,$2)', [id(1), id(101)]],
      ["INSERT INTO enterprise.roles(organization_id,key,name) VALUES ($1,'employee','duplicate')", [id(1)]],
      ['INSERT INTO enterprise.org_member_roles(organization_id,org_member_id,role_id) VALUES ($1,$2,$3)', [id(1), id(201), id(301)]],
    ] as const;
    for (const [sql, values] of statements) await assert.rejects(admin.query(sql, [...values]), { code: '23505' });
    await assert.rejects(admin.query("INSERT INTO enterprise.tasks(organization_id,owner_member_id,title,status) VALUES ($1,$2,'x','invalid')", [id(1), id(201)]), { code: '23514' });
  });

  test('runtime/migrator 無超級使用者、建庫建角色或 BYPASSRLS 權限', async () => {
    const roles = await runtime.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname IN ('dhc_app','dhc_migrator') ORDER BY rolname");
    assert.equal(roles.rowCount, 2);
    for (const row of roles.rows) assert.deepEqual([row.rolsuper, row.rolcreatedb, row.rolcreaterole, row.rolbypassrls], [false,false,false,false]);
    assert.equal((await runtime.query("SELECT has_database_privilege(current_user,current_database(),'TEMP') AS allowed")).rows[0].allowed, false);
    for (const sql of [
      'CREATE TABLE enterprise.forbidden(id int)', 'CREATE TABLE public.forbidden(id int)',
      'CREATE DATABASE forbidden', 'CREATE ROLE forbidden', 'SET ROLE dhc_migrator', 'SET ROLE dhc_bootstrap',
      'SELECT * FROM enterprise.schema_migrations', 'TRUNCATE enterprise.tasks',
      'DELETE FROM enterprise.audit_events', "UPDATE enterprise.audit_events SET action='tamper'",
      "INSERT INTO enterprise.roles(organization_id,key,name) VALUES ('00000000-0000-4000-8000-000000000001','admin','admin')",
    ]) await assert.rejects(runtime.query(sql), { code: '42501' });
  });

  test('RLS 無 scope 預設不可見；漏寫 WHERE 仍隔離，跨 scope INSERT 拒絕', async () => {
    assert.equal((await runtime.query('SELECT * FROM enterprise.tasks')).rowCount, 0);
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('dhc.organization_id',$1,true)", [id(1)]);
      assert.ok((await client.query('SELECT organization_id FROM enterprise.tasks')).rows.every(row => row.organization_id === id(1)));
      await assert.rejects(client.query("INSERT INTO enterprise.tasks(organization_id,owner_member_id,title) VALUES ($1,$2,'attack')", [id(2), id(202)]), { code: '42501' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.equal((await runtime.query('SELECT * FROM enterprise.tasks')).rowCount, 0);
  });

  test('寫入與 audit 原子回退、已結束 scope 不可重用、文字參數不執行 SQL', async () => {
    const before = (await admin.query('SELECT count(*)::int AS n FROM enterprise.audit_events')).rows[0].n;
    await assert.rejects(persistenceA.withOrganization(id(1), async s => {
      await s.createTask({ title: 'must rollback' });
      await s.createDocument({ title: '' });
    }), /ENTERPRISE_INVALID_TEXT/);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM enterprise.audit_events')).rows[0].n, before);
    assert.equal((await admin.query("SELECT * FROM enterprise.tasks WHERE title='must rollback'")).rowCount, 0);
    const escaped = await persistenceA.withOrganization(id(1), async s => s);
    await assert.rejects(escaped.listTasks(), /ENTERPRISE_SCOPE_CLOSED/);
    const title = "'); DROP TABLE enterprise.tasks; --";
    assert.equal((await persistenceA.withOrganization(id(1), s => s.createTask({ title }))).title, title);
  });

  test('連線池並行與重新使用不洩漏組織 scope', async () => {
    await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const org = i % 2 ? id(1) : id(2);
      const service = i % 2 ? persistenceA : persistenceB;
      const rows = await service.withOrganization(org, s => s.listTasks());
      assert.ok(rows.length > 0 && rows.every(row => row.organizationId === org));
    }));
    assert.equal((await runtime.query('SELECT * FROM enterprise.organizations')).rowCount, 0);
  });

  test('有資料 Down 必須明確許可，拒絕後 FORCE RLS 完整保留', async () => {
    await assert.rejects(runEnterpriseMigrations(migrator, { directory, direction: 'down' }), /ENTERPRISE_DOWN_REQUIRES_ALLOW_DATA_LOSS/);
    const tables = await admin.query("SELECT relforcerowsecurity FROM pg_class WHERE relnamespace='enterprise'::regnamespace AND relkind='r' AND relname <> 'schema_migrations'");
    // E05-DOC-01 +2、IAM-01 +2（account_credentials、auth_sessions）、DOC-02 +2（document_extractions、document_chunks）：8 → 14 張，全部仍須 FORCE RLS。
    // RUN/MODEL/DOC-03 +7、PLAN-01 +3：24 張；RCFIX ASTRA-002 +2（notifications、notification_reads）、ASTRA-004 +1（run_quarantine）：27 張；V4 W6-B +1（reconciliations）：28 張；
    // V5 0013 +2（ops_reports、ops_report_sources）、0014 +1（reconciliation_exports）：共 31 張。
    assert.equal(tables.rowCount, 31);
    assert.ok(tables.rows.every(row => row.relforcerowsecurity));
  });

  test('Migration checksum 改動與未知版本拒絕，不破壞既有資料', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'dhc-migration-check-'));
    try {
      // E05-DOC-01：migrator 需要所有已知版本的檔案；先複製完整目錄，再只讓 0001 漂移。
      for (const file of await readdir(directory)) await writeFile(path.join(temporary, file), await readFile(path.join(directory, file)));
      for (const direction of ['up','down']) {
        const filename = `0001_enterprise_base.${direction}.sql`;
        await writeFile(path.join(temporary, filename), (await readFile(path.join(directory, filename), 'utf8')) + '\n-- drift');
      }
      await assert.rejects(runEnterpriseMigrations(migrator, { directory: temporary, direction: 'up' }), /ENTERPRISE_MIGRATION_CHECKSUM_MISMATCH/);
    } finally { await rm(temporary, { recursive: true }); }
    await admin.query("INSERT INTO enterprise.schema_migrations(version,checksum) VALUES ('unknown',repeat('0',64))");
    try { await assert.rejects(runEnterpriseMigrations(migrator, { directory, direction: 'up' }), /ENTERPRISE_UNKNOWN_MIGRATION/); }
    finally { await admin.query("DELETE FROM enterprise.schema_migrations WHERE version='unknown'"); }
  });

  describe('E02b-PAGE：內部 scoped keyset pagination', () => {
    const resources = [
      { method: 'listTasksPage', legacy: 'listTasks', table: 'tasks', clock: 'created_at', offset: 1000 },
      { method: 'listDocumentsPage', legacy: 'listDocuments', table: 'documents', clock: 'created_at', offset: 2000 },
      { method: 'listAuditEventsPage', legacy: 'listAuditEvents', table: 'audit_events', clock: 'occurred_at', offset: 3000 },
    ] as const;
    const empty = createEnterprisePersistence(runtime, async () => ({ userAccountId: id(103) }));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const decode = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;

    before(async () => {
      await admin.query("INSERT INTO enterprise.organizations(id,slug,name) VALUES ($1,'page-empty','合成空集合')", [id(3)]);
      await admin.query("INSERT INTO enterprise.user_accounts(id,organization_id,email) VALUES ($1,$2,'empty@example.invalid')", [id(103), id(3)]);
      await admin.query('INSERT INTO enterprise.org_members(id,organization_id,user_account_id) VALUES ($1,$2,$3)', [id(203), id(3), id(103)]);
      for (const resource of resources) {
        // 逆序插入；每兩列共享微秒時間戳，全部落在同一毫秒內。
        const time = "timestamptz '2000-01-01 00:00:00Z' + (n / 2) * interval '1 microsecond'";
        const key = "('00000000-0000-4000-8000-' || lpad(($3::int+n)::text,12,'0'))::uuid";
        const sql = resource.table === 'audit_events'
          ? `INSERT INTO enterprise.audit_events(id,organization_id,actor_member_id,action,resource_type,resource_id,occurred_at)
             SELECT ${key},$1,$2,'page.seed','task',$4,${time} FROM generate_series(105,1,-1) n`
          : `INSERT INTO enterprise.${resource.table}(id,organization_id,owner_member_id,title,created_at)
             SELECT ${key},$1,$2,'page.seed',${time} FROM generate_series(105,1,-1) n`;
        await admin.query(sql, resource.table === 'audit_events'
          ? [id(1), id(201), resource.offset, id(1001)] : [id(1), id(201), resource.offset]);
      }
    });

    after(async () => {
      // 只移除本組測試的合成列，還原原 12 項驗證的資料供既有 dump/restore runner 使用。
      await admin.query("DELETE FROM enterprise.audit_events WHERE action='page.seed'");
      await admin.query("DELETE FROM enterprise.documents WHERE title='page.seed'");
      await admin.query("DELETE FROM enterprise.tasks WHERE title='page.seed'");
      await admin.query('DELETE FROM enterprise.org_members WHERE id=$1', [id(203)]);
      await admin.query('DELETE FROM enterprise.user_accounts WHERE id=$1', [id(103)]);
      await admin.query('DELETE FROM enterprise.organizations WHERE id=$1', [id(3)]);
    });

    for (const resource of resources) {
      test(`${resource.table}：超過 100 列、同時間與微秒排序，跨 transaction 翻頁無遺漏或重複`, async () => {
        const expected = (await admin.query(`SELECT id FROM enterprise.${resource.table} WHERE organization_id=$1 ORDER BY ${resource.clock},id`, [id(1)])).rows.map(row => row.id);
        const actual: string[] = [];
        let cursor: string | undefined;
        for (let pageNumber = 0; pageNumber < 30; pageNumber++) {
          const page = await persistenceA.withOrganization(id(1), async s => s[resource.method]({ limit: 7, cursor }));
          assert.ok(page.items.length <= 7);
          assert.ok(page.items.every(row => row.organizationId === id(1)));
          assert.ok(page.items.every(row => resource.table === 'audit_events'
            ? 'occurredAt' in row && row.occurredAt instanceof Date
            : 'createdAt' in row && row.createdAt instanceof Date));
          actual.push(...page.items.map(row => row.id));
          if (page.nextCursor === null) break;
          assert.ok(page.items.length > 0);
          cursor = page.nextCursor;
        }
        assert.deepEqual(actual, expected);
        assert.deepEqual(actual.slice(0, 105), Array.from({ length: 105 }, (_, n) => id(resource.offset+n+1)));
        assert.equal(new Set(actual).size, actual.length);
      });
    }

    test('page size 預設 50、上限 100；拒絕非法 options 與尚未支援的 filter/sort', async () => {
      for (const resource of resources) {
        assert.equal((await persistenceA.withOrganization(id(1), async s => s[resource.method]())).items.length, 50);
        assert.equal((await persistenceA.withOrganization(id(1), async s => s[resource.method]({ limit: 100 }))).items.length, 100);
        for (const limit of [0, -1, 101, 1.5, NaN, Infinity, -Infinity, '2', null]) {
          await assert.rejects(persistenceA.withOrganization(id(1), async s => s[resource.method]({ limit } as never)), /ENTERPRISE_INVALID_PAGE/);
        }
        for (const options of [null, [], 1, 'page', { filter: 'pending' }, { sort: 'desc' }]) {
          await assert.rejects(persistenceA.withOrganization(id(1), async s => s[resource.method](options as never)), /ENTERPRISE_INVALID_PAGE/);
        }
        const old = await persistenceA.withOrganization(id(1), async s => s[resource.legacy]());
        assert.ok(Array.isArray(old));
        assert.equal(old.length, 100);
      }
    });

    test('空集合、完整末頁及最後一列之後都回傳 nextCursor=null', async () => {
      for (const resource of resources) {
        assert.deepEqual(await empty.withOrganization(id(3), async s => s[resource.method]()), { items: [], nextCursor: null });
        const old = await persistenceB.withOrganization(id(2), async s => s[resource.legacy]());
        assert.ok(old.length > 0);
        const exact = await persistenceB.withOrganization(id(2), async s => s[resource.method]({ limit: old.length }));
        assert.deepEqual(exact, { items: old, nextCursor: null });
        const first = await persistenceA.withOrganization(id(1), async s => s[resource.method]({ limit: 1 }));
        const last = (await admin.query(`SELECT id FROM enterprise.${resource.table} WHERE organization_id=$1 ORDER BY ${resource.clock} DESC,id DESC LIMIT 1`, [id(1)])).rows[0].id;
        const cursor = encode({ ...decode(first.nextCursor!), id: last });
        assert.deepEqual(await persistenceA.withOrganization(id(1), async s => s[resource.method]({ cursor })), { items: [], nextCursor: null });
      }
    });

    test('非法、非 canonical、過長或變更版本／排序的 Cursor 明確拒絕', async () => {
      for (const resource of resources) {
        const first = await persistenceA.withOrganization(id(1), async s => s[resource.method]({ limit: 1 }));
        const body = decode(first.nextCursor!);
        const malformed = ['', null, 1, {}, [], 'not-json', 'a'.repeat(1025), first.nextCursor+'=', first.nextCursor+'\n',
          encode(null), encode([]), encode({ ...body, v: 2 }), encode({ ...body, id: 'bad' }),
          encode({ ...body, organizationId: 'bad' }), encode({ ...body, sort: 'desc' }), encode({ ...body, extra: true }),
          encode({ ...body, kind: 'unknown' }), encode({ ...body, id: null })];
        for (const cursor of malformed) {
          await assert.rejects(persistenceA.withOrganization(id(1), async s => s[resource.method]({ cursor } as never)), /ENTERPRISE_INVALID_CURSOR/);
        }
      }
    });

    test('Cursor 綁定組織與資源，重標籤也不能以外組織 anchor 讀取資料', async () => {
      for (const resource of resources) {
        const first = await persistenceA.withOrganization(id(1), async s => s[resource.method]({ limit: 1 }));
        const body = decode(first.nextCursor!);
        await assert.rejects(persistenceB.withOrganization(id(2), async s => s[resource.method]({ cursor: first.nextCursor! })), /ENTERPRISE_INVALID_CURSOR/);
        await assert.rejects(persistenceA.withOrganization(id(2), async s => s[resource.method]({ cursor: first.nextCursor! })), /ENTERPRISE_SCOPE_DENIED/);
        const foreign = (await persistenceB.withOrganization(id(2), async s => s[resource.legacy]()))[0].id;
        await assert.rejects(persistenceA.withOrganization(id(1), async s => s[resource.method]({ cursor: encode({ ...body, id: foreign }) })), /ENTERPRISE_INVALID_CURSOR/);
        await assert.rejects(persistenceB.withOrganization(id(2), async s => s[resource.method]({ cursor: encode({ ...body, organizationId: id(2) }) })), /ENTERPRISE_INVALID_CURSOR/);
        const other = resources.find(candidate => candidate.method !== resource.method)!;
        await assert.rejects(persistenceA.withOrganization(id(1), async s => s[other.method]({ cursor: first.nextCursor! })), /ENTERPRISE_INVALID_CURSOR/);
      }
    });

    test('每頁重新驗證可信 principal 與 active membership；已關閉 scope 不能繼續查詢', async () => {
      const anonymous = createEnterprisePersistence(runtime, async () => null);
      for (const resource of resources) {
        const first = await persistenceA.withOrganization(id(1), async s => s[resource.method]({ limit: 1 }));
        const options = { cursor: first.nextCursor! };
        await assert.rejects(anonymous.withOrganization(id(1), async s => s[resource.method](options)), /ENTERPRISE_AUTH_REQUIRED/);
        for (const [table, rowId] of [['organizations', id(1)], ['user_accounts', id(101)], ['org_members', id(201)]]) {
          await admin.query(`UPDATE enterprise.${table} SET status='disabled' WHERE id=$1`, [rowId]);
          try { await assert.rejects(persistenceA.withOrganization(id(1), async s => s[resource.method](options)), /ENTERPRISE_SCOPE_DENIED/); }
          finally { await admin.query(`UPDATE enterprise.${table} SET status='active' WHERE id=$1`, [rowId]); }
        }
        const closed = await persistenceA.withOrganization(id(1), async s => s);
        await assert.rejects(closed[resource.method](options), /ENTERPRISE_SCOPE_CLOSED/);
        assert.ok((await persistenceB.withOrganization(id(2), async s => s[resource.method]())).items.every(row => row.organizationId === id(2)));
      }
      assert.equal((await runtime.query('SELECT * FROM enterprise.tasks')).rowCount, 0);
    });

    for (const resource of resources) {
      test(`${resource.table}：翻頁間新增／刪除遵守 seek 邊界；刪除 anchor 後要求重啟`, async () => {
        const first = await persistenceA.withOrganization(id(1), async s => s[resource.method]({ limit: 1 }));
        assert.equal(first.items[0].id, id(resource.offset+1));
        await admin.query(`DELETE FROM enterprise.${resource.table} WHERE id=$1`, [id(resource.offset+2)]);
        for (const [n, organizationId, memberId, time] of [
          [900, id(1), id(201), '1999-01-01T00:00:00Z'],
          [901, id(1), id(201), '2000-01-01T00:00:00.000100Z'],
          [902, id(2), id(202), '2000-01-01T00:00:00.000100Z'],
        ] as const) {
          const sql = resource.table === 'audit_events'
            ? "INSERT INTO enterprise.audit_events(id,organization_id,actor_member_id,action,resource_type,resource_id,occurred_at) VALUES ($1,$2,$3,'page.seed','task',$4,$5)"
            : `INSERT INTO enterprise.${resource.table}(id,organization_id,owner_member_id,title,created_at) VALUES ($1,$2,$3,'page.seed',$4)`;
          await admin.query(sql, resource.table === 'audit_events'
            ? [id(resource.offset+n), organizationId, memberId, id(1001), time]
            : [id(resource.offset+n), organizationId, memberId, time]);
        }
        const remaining: string[] = [];
        let cursor = first.nextCursor;
        for (let n = 0; cursor !== null && n < 10; n++) {
          const page = await persistenceA.withOrganization(id(1), async s => s[resource.method]({ cursor: cursor!, limit: n === 0 ? 7 : 100 }));
          assert.ok(page.items.every(row => row.organizationId === id(1)));
          remaining.push(...page.items.map(row => row.id));
          cursor = page.nextCursor;
        }
        assert.equal(cursor, null);
        const expected = (await admin.query(`SELECT id FROM enterprise.${resource.table} WHERE organization_id=$1 AND (${resource.clock},id) > (timestamptz '2000-01-01 00:00:00Z',$2::uuid) ORDER BY ${resource.clock},id`, [id(1), first.items[0].id])).rows.map(row => row.id);
        assert.deepEqual(remaining, expected);
        assert.ok(!remaining.includes(id(resource.offset+2)) && !remaining.includes(id(resource.offset+900)) && !remaining.includes(id(resource.offset+902)));
        assert.equal(remaining.filter(value => value === id(resource.offset+901)).length, 1);
        await admin.query(`DELETE FROM enterprise.${resource.table} WHERE id=$1`, [first.items[0].id]);
        await assert.rejects(persistenceA.withOrganization(id(1), async s => s[resource.method]({ cursor: first.nextCursor! })), /ENTERPRISE_INVALID_CURSOR/);
        assert.equal((await persistenceA.withOrganization(id(1), async s => s[resource.method]({ limit: 1 }))).items[0].id, id(resource.offset+900));
      });
    }
  });
});
