import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Pool } from 'pg';

import { createEnterprisePersistence, runEnterpriseMigrations } from '../index.js';

const database = process.env.E02B_DR_DATABASE;
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const tables = ['organizations', 'user_accounts', 'org_members', 'roles', 'org_member_roles', 'tasks', 'documents', 'audit_events', 'schema_migrations'] as const;

describe('E02b-DR：兩個全新合成 PostgreSQL cluster 的還原契約', { skip: !database }, () => {
  const sourceConfig = { host: '127.0.0.1', port: Number(process.env.E02B_DR_SOURCE_PORT), database: process.env.E02B_DR_SOURCE_DATABASE, max: 2 };
  const targetConfig = { host: '127.0.0.1', port: Number(process.env.E02B_DR_PORT), database, max: 2 };
  const sourceAdmin = new Pool({ ...sourceConfig, user: 'dhc_bootstrap', password: process.env.E02B_DR_SOURCE_ADMIN_PASSWORD });
  const targetAdmin = new Pool({ ...targetConfig, user: 'dhc_bootstrap', password: process.env.E02B_DR_ADMIN_PASSWORD });
  const sourceRuntime = new Pool({ ...sourceConfig, user: 'dhc_app', password: process.env.E02B_DR_SOURCE_APP_PASSWORD });
  const targetRuntime = new Pool({ ...targetConfig, user: 'dhc_app', password: process.env.E02B_DR_APP_PASSWORD });
  const targetMigrator = new Pool({ ...targetConfig, user: 'dhc_migrator', password: process.env.E02B_DR_MIGRATOR_PASSWORD });
  const sourceA = createEnterprisePersistence(sourceRuntime, async () => ({ userAccountId: id(101) }));
  const targetA = createEnterprisePersistence(targetRuntime, async () => ({ userAccountId: id(101) }));
  const targetB = createEnterprisePersistence(targetRuntime, async () => ({ userAccountId: id(102) }));

  async function fingerprint(pool: Pool) {
    const result = [];
    for (const table of tables) {
      const rows = (await pool.query<{ content: string }>(`SELECT row_to_json(t)::text AS content FROM enterprise.${table} t ORDER BY content`)).rows;
      result.push({ table, count: rows.length, sha256: createHash('sha256').update(rows.map(row => row.content).join('\n')).digest('hex') });
    }
    return result;
  }

  before(() => {
    assert.equal(process.env.E02B_DR_CONFIRM_SYNTHETIC, 'true');
    assert.match(sourceConfig.database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    assert.equal(database, sourceConfig.database+'_restore');
    assert.notEqual(sourceConfig.port, targetConfig.port);
  });
  after(async () => { await Promise.all([sourceAdmin.end(), targetAdmin.end(), sourceRuntime.end(), targetRuntime.end(), targetMigrator.end()]); });

  test('來源與目標是不同 cluster；9表資料與版本逐列 hash 等同', async () => {
    const query = 'SELECT system_identifier::text AS id FROM pg_control_system()';
    assert.notEqual((await sourceAdmin.query(query)).rows[0].id, (await targetAdmin.query(query)).rows[0].id);
    const source = await fingerprint(sourceAdmin);
    assert.equal(source.length, 9);
    assert.ok(source.every(row => row.count > 0));
    assert.deepEqual(await fingerprint(targetAdmin), source);
  });

  test('角色、schema/table owner、ACL、FORCE RLS、policy及default privilege重建一致', async () => {
    const queries = [
      "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls FROM pg_roles WHERE rolname IN ('dhc_app','dhc_migrator') ORDER BY rolname",
      "SELECT nspname,pg_get_userbyid(nspowner) AS owner,nspacl::text AS acl FROM pg_namespace WHERE nspname='enterprise'",
      "SELECT relname,pg_get_userbyid(relowner) AS owner,relacl::text AS acl,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='enterprise'::regnamespace AND relkind='r' ORDER BY relname",
      "SELECT tablename,policyname,roles::text,cmd,qual,with_check FROM pg_policies WHERE schemaname='enterprise' ORDER BY tablename,policyname",
      "SELECT defaclrole::regrole::text AS owner,defaclobjtype,defaclacl::text AS acl FROM pg_default_acl WHERE defaclrole='dhc_migrator'::regrole ORDER BY defaclobjtype",
    ];
    for (const query of queries) assert.deepEqual((await targetAdmin.query(query)).rows, (await sourceAdmin.query(query)).rows);
    const rows = (await targetAdmin.query("SELECT pg_get_userbyid(relowner) AS owner,relforcerowsecurity FROM pg_class WHERE relnamespace='enterprise'::regnamespace AND relkind='r'")).rows;
    assert.equal(rows.length, 9);
    assert.ok(rows.every(row => row.owner === 'dhc_migrator'));
    assert.equal(rows.filter(row => row.relforcerowsecurity).length, 8);
  });

  test('目標使用新密碼；來源舊密碼不能登入目標，兩邊有效憑證各自可用', async () => {
    // 不用 assert.notEqual 印出秘密值，只有 boolean 與合成錯誤碼進入 evidence。
    assert.ok(process.env.E02B_DR_SOURCE_APP_PASSWORD !== process.env.E02B_DR_APP_PASSWORD, 'distinct generated credentials required');
    const oldPassword = new Pool({ ...targetConfig, user: 'dhc_app', password: process.env.E02B_DR_SOURCE_APP_PASSWORD });
    try { await assert.rejects(oldPassword.query('SELECT 1'), { code: '28P01' }); }
    finally { await oldPassword.end(); }
    assert.equal((await sourceRuntime.query('SELECT current_user AS name')).rows[0].name, 'dhc_app');
    assert.equal((await targetRuntime.query('SELECT current_user AS name')).rows[0].name, 'dhc_app');
  });

  test('還原後既有list與三種分頁只返回可信principal所屬組織', async () => {
    await targetA.withOrganization(id(1), async s => {
      for (const rows of [await s.listTasks(), await s.listDocuments(), await s.listAuditEvents(),
        (await s.listTasksPage({ limit: 1 })).items, (await s.listDocumentsPage({ limit: 1 })).items, (await s.listAuditEventsPage({ limit: 1 })).items]) {
        assert.ok(rows.length > 0 && rows.every(row => row.organizationId === id(1)));
      }
    });
    await assert.rejects(targetA.withOrganization(id(2), s => s.listTasksPage()), /ENTERPRISE_SCOPE_DENIED/);
    const foreign = (await targetB.withOrganization(id(2), s => s.listTasks()))[0];
    assert.equal(await targetA.withOrganization(id(1), s => s.getTask(foreign.id)), undefined);
    assert.equal((await targetRuntime.query('SELECT * FROM enterprise.tasks')).rowCount, 0);
  });

  test('來源Cursor在等同資料的還原目標可續頁；不能換成另一組織使用', async () => {
    const first = await sourceA.withOrganization(id(1), s => s.listTasksPage({ limit: 1 }));
    assert.ok(first.nextCursor);
    const options = { cursor: first.nextCursor!, limit: 1 };
    const expected = await sourceA.withOrganization(id(1), s => s.listTasksPage(options));
    assert.deepEqual(await targetA.withOrganization(id(1), s => s.listTasksPage(options)), expected);
    await assert.rejects(targetB.withOrganization(id(2), s => s.listTasksPage(options)), /ENTERPRISE_INVALID_CURSOR/);
  });

  test('還原後runtime沒有DDL、TEMP、角色管理或audit改刪權限', async () => {
    const privileges = (await targetRuntime.query("SELECT has_database_privilege(current_user,current_database(),'TEMP') AS temporary,has_database_privilege(current_user,current_database(),'CREATE') AS create_db_object")).rows[0];
    assert.deepEqual(privileges, { temporary: false, create_db_object: false });
    for (const sql of ['CREATE TABLE enterprise.forbidden(id int)', 'CREATE TABLE public.forbidden(id int)',
      'CREATE TEMP TABLE forbidden(id int)', 'CREATE ROLE forbidden', 'SET ROLE dhc_migrator',
      'SET ROLE dhc_bootstrap', 'SELECT * FROM enterprise.schema_migrations',
      'DELETE FROM enterprise.audit_events', "UPDATE enterprise.audit_events SET action='tamper'", 'TRUNCATE enterprise.tasks']) {
      await assert.rejects(targetRuntime.query(sql), { code: '42501' });
    }
  });

  test('還原後task/document與audit可原子寫入，失敗時不留下半套資料', async () => {
    const before = await fingerprint(targetAdmin);
    await assert.rejects(targetA.withOrganization(id(1), async s => {
      const count = (await s.listAuditEvents()).length;
      await s.createTask({ title: 'DR synthetic rollback task' });
      await s.createDocument({ title: 'DR synthetic rollback document' });
      assert.equal((await s.listAuditEvents()).length, count+2);
      throw new Error('DR_SYNTHETIC_ROLLBACK');
    }), /DR_SYNTHETIC_ROLLBACK/);
    assert.deepEqual(await fingerprint(targetAdmin), before);
    assert.deepEqual(before, await fingerprint(sourceAdmin));
  });

  test('新migrator憑證可重跑Up為no-op；有資料Down仍拒絕', async () => {
    const directory = path.resolve('db/enterprise/migrations');
    const before = await fingerprint(targetAdmin);
    assert.equal((await runEnterpriseMigrations(targetMigrator, { directory, direction: 'up' })).applied, false);
    await assert.rejects(runEnterpriseMigrations(targetMigrator, { directory, direction: 'down' }), /ENTERPRISE_DOWN_REQUIRES_ALLOW_DATA_LOSS/);
    assert.deepEqual(await fingerprint(targetAdmin), before);
  });

  test('RLS跨scope寫入拒絕，結束交易後pool不殘留scope', async () => {
    const client = await targetRuntime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('dhc.organization_id',$1,true)", [id(1)]);
      await assert.rejects(client.query("INSERT INTO enterprise.tasks(organization_id,owner_member_id,title) VALUES ($1,$2,'attack')", [id(2), id(202)]), { code: '42501' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.equal((await targetRuntime.query('SELECT * FROM enterprise.organizations')).rowCount, 0);
    assert.ok((await targetB.withOrganization(id(2), s => s.listTasksPage())).items.every(row => row.organizationId === id(2)));
  });
});
