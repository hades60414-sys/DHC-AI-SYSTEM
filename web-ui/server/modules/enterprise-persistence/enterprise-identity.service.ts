import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type { EnterprisePermission, EnterprisePrincipal } from '@/shared/index.js';

import {
  appendIdentityAudit, countOtherActiveAdmins, findActiveOrganizationIdBySlug, findLoginCandidate, findRoleIds,
  findSessionState, getMember, insertMember, insertSession, listMembers, replaceMemberRoles, revokeMemberSessions,
  revokeSession, setMemberStatus,
} from './enterprise-identity.repository.js';
import { checkEnterpriseEntitlement, setEnterpriseSubscription } from './enterprise-entitlements.js';
import { DUMMY_PASSWORD_HASH, hashEnterprisePassword, requirePasswordPolicy, verifyEnterprisePassword } from './enterprise-password.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
const TOKEN = /^dhcs1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** pg_advisory_xact_lock(int,int) 的鎖類別：成員／角色管理（與 migrator 的單一 bigint 鍵空間不重疊）。 */
const MEMBER_ADMIN_LOCK_CLASS = 8_420_051;

/**
 * 角色 → 權限（IAM-01 候選；RD-003 批准前為內部預設）。只在伺服器端推導，未知角色沒有任何權限。
 */
const ROLE_PERMISSIONS: Record<string, EnterprisePermission[]> = {
  org_admin: ['documents.read', 'documents.write', 'members.read', 'members.manage', 'audit.read', 'tasks.read', 'tasks.write',
    'approvals.decide', 'models.manage', 'billing.read', 'billing.manage'],
  approver: ['documents.read', 'documents.write', 'tasks.read', 'tasks.write', 'approvals.decide'],
  employee: ['documents.read', 'documents.write', 'tasks.read', 'tasks.write'],
  auditor: ['documents.read', 'members.read', 'audit.read', 'tasks.read', 'billing.read'],
};

/** 供 enterprise-api 角色表單與 bootstrap CLI 使用：允許指派的角色 key。 */
export const ENTERPRISE_ROLE_KEYS = Object.keys(ROLE_PERMISSIONS);

/** 供同模組 worker／workflow 在交易內以「目前角色」重新推導權限（ASTRA-004）。 */
export function permissionsFor(roles: string[]): EnterprisePermission[] {
  return [...new Set(roles.flatMap(role => ROLE_PERMISSIONS[role] ?? []))].sort();
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(email: unknown) {
  if (typeof email !== 'string') throw new Error('ENTERPRISE_INVALID_EMAIL');
  const value = email.trim().toLowerCase();
  if (value.length < 3 || value.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(value)) throw new Error('ENTERPRISE_INVALID_EMAIL');
  return value;
}

function requireRoles(roles: unknown) {
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > ENTERPRISE_ROLE_KEYS.length
    || roles.some(role => typeof role !== 'string' || !ENTERPRISE_ROLE_KEYS.includes(role))) {
    throw new Error('ENTERPRISE_INVALID_ROLES');
  }
  return [...new Set(roles as string[])].sort();
}

/** 在單一 transaction 內設定組織 scope；失敗一律 ROLLBACK。 */
async function inOrganization<T>(pool: Pool, organizationId: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('dhc.organization_id',$1,true)", [organizationId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 供 enterprise-api（HTTP 守門與身份路由）使用的企業身份服務：登入、token 驗證、登出、成員管理與撤權。
 * Token 格式 `dhcs1.<orgId>.<sessionId>.<secret>`：orgId 只用來選擇 RLS scope，真正的驗證是 secret 的 SHA-256 常數時間比對，
 * 並在同一查詢內核對 session 未撤銷、未過期、成員／帳號／組織 active、auth_epoch 未變。
 */
export function createEnterpriseIdentity(pool: Pool, options: { sessionTtlMs?: number } = {}) {
  const ttl = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isInteger(ttl) || ttl < 60_000 || ttl > 7 * 24 * 60 * 60 * 1000) throw new Error('ENTERPRISE_INVALID_SESSION_TTL');

  async function authenticate(token: unknown): Promise<EnterprisePrincipal | null> {
    const match = typeof token === 'string' ? TOKEN.exec(token) : null;
    if (!match || !UUID.test(match[1]) || !UUID.test(match[2])) return null;
    const [, organizationId, sessionId, secret] = match;
    const state = await inOrganization(pool, organizationId, client => findSessionState(client, organizationId, sessionId));
    if (!state) return null;
    const presented = Buffer.from(sha256(secret), 'hex');
    const stored = Buffer.from(state.tokenSha256, 'hex');
    if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) return null;
    if (state.revoked || !state.active || state.sessionEpoch !== state.memberEpoch) return null;
    return {
      organizationId, userAccountId: state.userAccountId, memberId: state.memberId, sessionId, email: state.email,
      roles: state.roles, permissions: permissionsFor(state.roles), expiresAt: state.expiresAt,
    };
  }

  /**
   * 管理操作：在同一 transaction 重新核對呼叫者 session 仍有效且具 members.manage。
   * ASTRA-005：先取得組織級 transaction advisory lock，同一組織的成員／角色變更完全序列化；
   * 鎖在 COMMIT／ROLLBACK 自動釋放。取得鎖之後才讀 session 與管理員數（READ COMMITTED 下會看到前一筆已提交結果），
   * 所以「最後一位管理員」檢查不再是 count-then-write 競態，也涵蓋席位檢查（member.create／enable）。
   */
  async function asAdmin<T>(actor: EnterprisePrincipal, operation: (client: PoolClient) => Promise<T>) {
    return inOrganization(pool, actor.organizationId, async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [MEMBER_ADMIN_LOCK_CLASS, actor.organizationId]);
      const state = await findSessionState(client, actor.organizationId, actor.sessionId);
      if (!state || state.revoked || !state.active || state.sessionEpoch !== state.memberEpoch || state.memberId !== actor.memberId
        || !permissionsFor(state.roles).includes('members.manage')) {
        throw new Error('ENTERPRISE_FORBIDDEN');
      }
      return operation(client);
    });
  }

  async function requireOtherAdmin(client: PoolClient, organizationId: string, memberId: string) {
    if ((await countOtherActiveAdmins(client, organizationId, memberId)) === 0) throw new Error('ENTERPRISE_LAST_ADMIN');
  }

  return {
    authenticate,

    /** 未知組織、未知帳號、停權、錯密碼都回同一個 ENTERPRISE_INVALID_CREDENTIALS，且都做一次 scrypt。 */
    async login(input: { organizationSlug: unknown; email: unknown; password: unknown }) {
      const slug = typeof input?.organizationSlug === 'string' && SLUG.test(input.organizationSlug) ? input.organizationSlug : null;
      const password = typeof input?.password === 'string' ? input.password : '';
      let email: string | null = null;
      try { email = normalizeEmail(input?.email); } catch { email = null; }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const organizationId = slug ? await findActiveOrganizationIdBySlug(client, slug) : undefined;
        if (organizationId) await client.query("SELECT set_config('dhc.organization_id',$1,true)", [organizationId]);
        const candidate = organizationId && email ? await findLoginCandidate(client, organizationId, email) : undefined;
        const valid = await verifyEnterprisePassword(password, candidate?.passwordHash ?? DUMMY_PASSWORD_HASH);
        if (!organizationId || !candidate || !valid) throw new Error('ENTERPRISE_INVALID_CREDENTIALS');
        const secret = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + ttl);
        const sessionId = await insertSession(client, { organizationId, memberId: candidate.memberId, tokenSha256: sha256(secret), authEpoch: candidate.authEpoch, expiresAt });
        await appendIdentityAudit(client, organizationId, candidate.memberId, 'session.created', 'session', sessionId);
        await client.query('COMMIT');
        return { token: `dhcs1.${organizationId}.${sessionId}.${secret}`, expiresAt };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async logout(principal: EnterprisePrincipal) {
      await inOrganization(pool, principal.organizationId, async client => {
        await revokeSession(client, principal.organizationId, principal.sessionId);
        await appendIdentityAudit(client, principal.organizationId, principal.memberId, 'session.revoked', 'session', principal.sessionId);
      });
    },

    async listMembers(actor: EnterprisePrincipal) {
      if (!actor.permissions.includes('members.read')) throw new Error('ENTERPRISE_FORBIDDEN');
      return inOrganization(pool, actor.organizationId, client => listMembers(client, actor.organizationId));
    },

    async createMember(actor: EnterprisePrincipal, input: { email: unknown; password: unknown; roles: unknown }) {
      const email = normalizeEmail(input?.email);
      const roles = requireRoles(input?.roles);
      const passwordHash = await hashEnterprisePassword(requirePasswordPolicy(input?.password));
      return asAdmin(actor, async client => {
        await checkEnterpriseEntitlement(client, actor.organizationId, 'member.create');
        const roleIds = await findRoleIds(client, actor.organizationId, roles);
        if (!roleIds) throw new Error('ENTERPRISE_INVALID_ROLES');
        try {
          const memberId = await insertMember(client, { organizationId: actor.organizationId, email, passwordHash, roleIds });
          await appendIdentityAudit(client, actor.organizationId, actor.memberId, 'member.created', 'member', memberId);
          return getMember(client, actor.organizationId, memberId);
        } catch (error) {
          if ((error as { code?: string }).code === '23505') throw new Error('ENTERPRISE_MEMBER_EXISTS');
          throw error;
        }
      });
    },

    /** 停權：狀態 disabled、auth_epoch+1、撤銷全部 session；不能停用最後一位 active 管理員。 */
    async disableMember(actor: EnterprisePrincipal, memberId: unknown) {
      if (typeof memberId !== 'string' || !UUID.test(memberId)) throw new Error('ENTERPRISE_INVALID_ID');
      return asAdmin(actor, async client => {
        const member = await getMember(client, actor.organizationId, memberId);
        if (!member) throw new Error('ENTERPRISE_MEMBER_NOT_FOUND');
        if (member.roles.includes('org_admin')) await requireOtherAdmin(client, actor.organizationId, memberId);
        await setMemberStatus(client, actor.organizationId, memberId, 'disabled');
        const revoked = await revokeMemberSessions(client, actor.organizationId, memberId);
        await appendIdentityAudit(client, actor.organizationId, actor.memberId, 'member.disabled', 'member', memberId);
        return { member: await getMember(client, actor.organizationId, memberId), revokedSessions: revoked };
      });
    },

    async enableMember(actor: EnterprisePrincipal, memberId: unknown) {
      if (typeof memberId !== 'string' || !UUID.test(memberId)) throw new Error('ENTERPRISE_INVALID_ID');
      return asAdmin(actor, async client => {
        const member = await getMember(client, actor.organizationId, memberId);
        if (!member) throw new Error('ENTERPRISE_MEMBER_NOT_FOUND');
        if (member.status !== 'active') await checkEnterpriseEntitlement(client, actor.organizationId, 'member.create');
        await setMemberStatus(client, actor.organizationId, memberId, 'active');
        await appendIdentityAudit(client, actor.organizationId, actor.memberId, 'member.enabled', 'member', memberId);
        return getMember(client, actor.organizationId, memberId);
      });
    },

    /** 角色變更：auth_epoch+1（既有 session 立即失效，需重新登入取得新權限）；不能移除最後一位管理員的 org_admin。 */
    async setMemberRoles(actor: EnterprisePrincipal, memberId: unknown, roles: unknown) {
      if (typeof memberId !== 'string' || !UUID.test(memberId)) throw new Error('ENTERPRISE_INVALID_ID');
      const keys = requireRoles(roles);
      return asAdmin(actor, async client => {
        const member = await getMember(client, actor.organizationId, memberId);
        if (!member) throw new Error('ENTERPRISE_MEMBER_NOT_FOUND');
        if (member.roles.includes('org_admin') && !keys.includes('org_admin')) await requireOtherAdmin(client, actor.organizationId, memberId);
        const roleIds = await findRoleIds(client, actor.organizationId, keys);
        if (!roleIds) throw new Error('ENTERPRISE_INVALID_ROLES');
        await replaceMemberRoles(client, actor.organizationId, memberId, roleIds);
        await revokeMemberSessions(client, actor.organizationId, memberId);
        await appendIdentityAudit(client, actor.organizationId, actor.memberId, 'member.roles_changed', 'member', memberId);
        return getMember(client, actor.organizationId, memberId);
      });
    },
  };
}

const ROLE_NAMES: Record<string, string> = { org_admin: '組織管理員', approver: '審核者', employee: '員工', auditor: '稽核者' };

/**
 * 供管理 CLI（enterprise-admin.cli）與整合測試使用：以 migrator 身分初始化一個新組織、四個預設角色與第一位管理員。
 * 已存在相同 slug 時拒絕（不覆寫、不重設密碼）。runtime 角色沒有建立組織／角色的權限，必須走這條受控路徑。
 */
export async function bootstrapEnterpriseOrganization(migratorPool: Pool, input: { slug: unknown; name: unknown; adminEmail: unknown; adminPassword: unknown }) {
  if (typeof input?.slug !== 'string' || !SLUG.test(input.slug)) throw new Error('ENTERPRISE_INVALID_SLUG');
  if (typeof input?.name !== 'string' || !input.name.trim() || input.name.trim().length > 200) throw new Error('ENTERPRISE_INVALID_TEXT');
  const email = normalizeEmail(input.adminEmail);
  const passwordHash = await hashEnterprisePassword(requirePasswordPolicy(input.adminPassword));
  const organizationId = randomUUIDv4();
  const client = await migratorPool.connect();
  try {
    await client.query('BEGIN');
    if (await findActiveOrganizationIdBySlug(client, input.slug)) throw new Error('ENTERPRISE_ORGANIZATION_EXISTS');
    await client.query("SELECT set_config('dhc.organization_id',$1,true)", [organizationId]);
    try {
      await client.query('INSERT INTO enterprise.organizations(id,slug,name) VALUES ($1,$2,$3)', [organizationId, input.slug, input.name.trim()]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new Error('ENTERPRISE_ORGANIZATION_EXISTS');
      throw error;
    }
    for (const key of ENTERPRISE_ROLE_KEYS) {
      await client.query('INSERT INTO enterprise.roles(organization_id,key,name) VALUES ($1,$2,$3)', [organizationId, key, ROLE_NAMES[key] ?? key]);
    }
    const roleIds = await findRoleIds(client, organizationId, ['org_admin']);
    const memberId = await insertMember(client, { organizationId, email, passwordHash, roleIds: roleIds! });
    await appendIdentityAudit(client, organizationId, memberId, 'organization.bootstrapped', 'member', memberId);
    // PLAN-01：新組織預設 21 天 Pilot 試用；正式方案由供應商以 CLI 調整並留下 subscription_events。
    const today = new Date();
    const end = new Date(today.getTime() + 21 * 24 * 60 * 60 * 1000);
    await setEnterpriseSubscription(client, organizationId, { planKey: 'pilot', status: 'trial', billingMode: 'byok',
      periodStart: today.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10), actor: 'bootstrap', reason: 'initial pilot trial' });
    await client.query('COMMIT');
    return { organizationId, adminMemberId: memberId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function randomUUIDv4() {
  return globalThis.crypto.randomUUID();
}

/**
 * 供管理 CLI（供應商端）使用：以 migrator 身分依 slug 設定訂閱方案與狀態，寫入 subscription_events。
 */
export async function setEnterpriseSubscriptionBySlug(migratorPool: Pool, input: { slug: string; planKey: string; status: string; periodStart: string; periodEnd: string; reason: string; actor: string }) {
  if (!SLUG.test(input.slug) || !/^\d{4}-\d{2}-\d{2}$/.test(input.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(input.periodEnd)
    || !['trial', 'active', 'grace', 'expired', 'cancelled'].includes(input.status)) throw new Error('ENTERPRISE_INVALID_SUBSCRIPTION');
  const client = await migratorPool.connect();
  try {
    await client.query('BEGIN');
    const organizationId = await findActiveOrganizationIdBySlug(client, input.slug);
    if (!organizationId) throw new Error('ENTERPRISE_NOT_FOUND');
    await client.query("SELECT set_config('dhc.organization_id',$1,true)", [organizationId]);
    const result = await setEnterpriseSubscription(client, organizationId, { planKey: input.planKey as 'pilot', status: input.status as 'active', billingMode: 'byok',
      periodStart: input.periodStart, periodEnd: input.periodEnd, actor: input.actor, reason: input.reason });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
