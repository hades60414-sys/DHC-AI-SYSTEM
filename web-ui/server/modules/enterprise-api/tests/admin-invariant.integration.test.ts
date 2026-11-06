import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Pool, type PoolClient } from 'pg';

import { bootstrapEnterpriseOrganization, createEnterpriseIdentity, runEnterpriseMigrations, setEnterpriseSubscriptionBySlug } from '@/modules/enterprise-persistence/index.js';
import type { EnterprisePrincipal } from '@/shared/index.js';

const database = process.env.E02A_TEST_DATABASE;
const PASSWORD = 'Synthetic-only-Passw0rd!';
const COUNT_ADMINS_SQL = "r.key='org_admin'";

/**
 * ASTRA-005：與 ASTRA 相同的確定性交錯——包裝連線池，讓「計算其他管理員」查詢在兩個交易都到達後才放行。
 * 修復後（組織級交易鎖）第二個交易會在鎖上等待，不會到達 barrier；因此 barrier 加上逾時，避免測試本身死鎖。
 */
function barrierPool(runtime: Pool, waitMs: number) {
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const timer = setTimeout(() => release(), waitMs);
  return {
    pool: {
      connect: async () => {
        const client = await runtime.connect();
        return {
          query: async (...args: Parameters<PoolClient['query']>) => {
            const result = await (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
            if (typeof args[0] === 'string' && args[0].includes('count(*)::int AS n') && args[0].includes(COUNT_ADMINS_SQL)) {
              arrived += 1;
              if (arrived === 2) { clearTimeout(timer); release(); }
              await barrier;
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool,
    arrivals: () => arrived,
  };
}

describe('ASTRA-005 最後管理員不變量（實際 PostgreSQL，確定性交錯）', { skip: !database }, () => {
  const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 8 };
  const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
  const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
  const runtime = new Pool({ ...config, user: 'dhc_app', password: process.env.E02A_TEST_APP_PASSWORD });
  const identity = createEnterpriseIdentity(runtime);
  let round = 0;

  async function twoAdmins(): Promise<[EnterprisePrincipal, EnterprisePrincipal]> {
    round += 1;
    const slug = `race-${round}`;
    await bootstrapEnterpriseOrganization(migrator, { slug, name: slug, adminEmail: `a@${slug}.example.invalid`, adminPassword: PASSWORD });
    await setEnterpriseSubscriptionBySlug(migrator, { slug, planKey: 'team', status: 'active', periodStart: '2026-11-01', periodEnd: '2027-10-31', reason: 'test', actor: 'test' });
    const first = (await identity.authenticate((await identity.login({ organizationSlug: slug, email: `a@${slug}.example.invalid`, password: PASSWORD })).token))!;
    await identity.createMember(first, { email: `b@${slug}.example.invalid`, password: PASSWORD, roles: ['org_admin'] });
    const second = (await identity.authenticate((await identity.login({ organizationSlug: slug, email: `b@${slug}.example.invalid`, password: PASSWORD })).token))!;
    return [first, second];
  }

  async function activeAdmins(organizationId: string) {
    return (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM enterprise.org_members m
      JOIN enterprise.org_member_roles mr ON (mr.organization_id,mr.org_member_id)=(m.organization_id,m.id)
      JOIN enterprise.roles r ON (r.organization_id,r.id)=(mr.organization_id,mr.role_id)
      WHERE m.organization_id=$1 AND m.status='active' AND r.key='org_admin'`, [organizationId])).rows[0].n;
  }

  before(async () => {
    assert.match(database!, /^dhc_e02a_qa_[a-f0-9]+$/);
    await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
    await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
  });
  after(async () => { await Promise.all([admin.end(), migrator.end(), runtime.end()]); });

  type Race = (racing: ReturnType<typeof createEnterpriseIdentity>, a: EnterprisePrincipal, b: EnterprisePrincipal) => Array<Promise<unknown>>;
  const scenarios: Array<[string, Race]> = [
    ['兩位管理員同時停用自己', (racing, a, b) => [racing.disableMember(a, a.memberId), racing.disableMember(b, b.memberId)]],
    ['兩位管理員同時停用對方', (racing, a, b) => [racing.disableMember(a, b.memberId), racing.disableMember(b, a.memberId)]],
    ['兩位管理員同時把自己降成員工', (racing, a, b) => [racing.setMemberRoles(a, a.memberId, ['employee']), racing.setMemberRoles(b, b.memberId, ['employee'])]],
    ['一位停用、另一位同時降權', (racing, a, b) => [racing.disableMember(a, b.memberId), racing.setMemberRoles(b, a.memberId, ['employee'])]],
  ];

  for (const [name, run] of scenarios) {
    test(`${name}：最多一個成功，至少保留一位 active 管理員`, async () => {
      const [a, b] = await twoAdmins();
      const { pool, arrivals } = barrierPool(runtime, 1500);
      const outcomes = await Promise.allSettled(run(createEnterpriseIdentity(pool), a, b));
      const fulfilled = outcomes.filter(o => o.status === 'fulfilled').length;
      const remaining = await activeAdmins(a.organizationId);
      assert.ok(remaining >= 1, `remaining admins ${remaining}; outcomes ${JSON.stringify(outcomes.map(o => o.status))}; barrier arrivals ${arrivals()}`);
      assert.equal(fulfilled, 1);
      const rejected = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
      assert.match(String(rejected.reason), /ENTERPRISE_(LAST_ADMIN|FORBIDDEN)/);
    });
  }

  test('時鐘倒退（NTP／VM 校時）時撤銷 session 不違反 revoked_at >= created_at：停權仍成功', async () => {
    const [a, b] = await twoAdmins();
    // 模擬 b 的 session 由「時鐘較快」的時刻建立：created_at 比之後撤銷交易的 now() 還晚
    await admin.query("UPDATE enterprise.auth_sessions SET created_at = now() + interval '5 seconds' WHERE org_member_id=$1", [b.memberId]);
    const result = await identity.disableMember(a, b.memberId);
    assert.ok(result.revokedSessions >= 1);
    const rows = (await admin.query('SELECT revoked_at >= created_at AS ok FROM enterprise.auth_sessions WHERE org_member_id=$1', [b.memberId])).rows;
    assert.ok(rows.length >= 1 && rows.every(row => row.ok));
  });

  test('被拒絕的交易完整回退：成員狀態、角色、session 與稽核都沒有半套寫入', async () => {
    const [a] = await twoAdmins();
    const before = await admin.query('SELECT count(*)::int AS n FROM enterprise.audit_events WHERE organization_id=$1', [a.organizationId]);
    // 先停用另一位，剩自己一人；再試圖停用自己必須被拒
    const others = (await identity.listMembers(a)).filter(m => m.id !== a.memberId);
    await identity.disableMember(a, others[0].id);
    const audited = (await admin.query('SELECT count(*)::int AS n FROM enterprise.audit_events WHERE organization_id=$1', [a.organizationId])).rows[0].n;
    await assert.rejects(identity.disableMember(a, a.memberId), /ENTERPRISE_LAST_ADMIN/);
    await assert.rejects(identity.setMemberRoles(a, a.memberId, ['employee']), /ENTERPRISE_LAST_ADMIN/);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM enterprise.audit_events WHERE organization_id=$1', [a.organizationId])).rows[0].n, audited);
    assert.ok(audited > before.rows[0].n);
    assert.equal(await activeAdmins(a.organizationId), 1);
    assert.ok(await identity.authenticate(await identity.login({ organizationSlug: `race-${round}`, email: `a@race-${round}.example.invalid`, password: PASSWORD }).then(s => s.token)));
  });
});
