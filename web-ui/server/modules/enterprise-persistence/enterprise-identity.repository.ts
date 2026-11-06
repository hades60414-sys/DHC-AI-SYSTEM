import type { PoolClient } from 'pg';

import type { EnterpriseMemberRow } from '@/shared/index.js';

/** 每個查詢都明確帶 organization_id；呼叫端必須已在同一 transaction 設定 dhc.organization_id。 */

const memberColumns = `m.id, m.organization_id AS "organizationId", u.id AS "userAccountId", u.email,
  m.status, coalesce((SELECT array_agg(r.key ORDER BY r.key) FROM enterprise.org_member_roles mr
    JOIN enterprise.roles r ON (r.organization_id,r.id)=(mr.organization_id,mr.role_id)
    WHERE mr.organization_id=m.organization_id AND mr.org_member_id=m.id), '{}') AS roles,
  m.created_at AS "createdAt", m.updated_at AS "updatedAt"`;
const memberFrom = `enterprise.org_members m JOIN enterprise.user_accounts u ON (u.organization_id,u.id)=(m.organization_id,m.user_account_id)`;

/** 供同模組身份 service 使用：登入前以 slug 找 active 組織（依賴 login_slug_lookup policy，只看得到該 slug）。 */
export async function findActiveOrganizationIdBySlug(client: PoolClient, slug: string) {
  await client.query("SELECT set_config('dhc.login_slug',$1,true)", [slug]);
  const result = await client.query<{ id: string }>("SELECT id FROM enterprise.organizations WHERE slug=$1 AND status='active'", [slug]);
  await client.query("SELECT set_config('dhc.login_slug','',true)");
  return result.rows[0]?.id;
}

/** 供同模組身份 service 使用：登入候選（帳號、成員、組織皆 active 且有密碼憑證）。 */
export async function findLoginCandidate(client: PoolClient, organizationId: string, email: string) {
  const result = await client.query<{ userAccountId: string; memberId: string; authEpoch: number; passwordHash: string }>(
    `SELECT u.id AS "userAccountId", m.id AS "memberId", m.auth_epoch AS "authEpoch", c.password_hash AS "passwordHash"
     FROM enterprise.user_accounts u
     JOIN enterprise.org_members m ON (m.organization_id,m.user_account_id)=(u.organization_id,u.id)
     JOIN enterprise.account_credentials c ON (c.organization_id,c.user_account_id)=(u.organization_id,u.id)
     WHERE u.organization_id=$1 AND u.email=$2 AND u.status='active' AND m.status='active'`, [organizationId, email]);
  return result.rows[0];
}

/** 供同模組身份 service 使用。 */
export async function insertSession(client: PoolClient, input: { organizationId: string; memberId: string; tokenSha256: string; authEpoch: number; expiresAt: Date }) {
  return (await client.query<{ id: string }>(
    'INSERT INTO enterprise.auth_sessions(organization_id,org_member_id,token_sha256,member_auth_epoch,expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [input.organizationId, input.memberId, input.tokenSha256, input.authEpoch, input.expiresAt])).rows[0].id;
}

/** 供同模組身份 service 使用：session 與其成員、帳號、組織目前狀態（一次查詢，避免撤權競態）。 */
export async function findSessionState(client: PoolClient, organizationId: string, sessionId: string) {
  const result = await client.query<{
    tokenSha256: string; sessionEpoch: number; memberEpoch: number; expiresAt: Date; revoked: boolean; active: boolean;
    userAccountId: string; memberId: string; email: string; roles: string[];
  }>(
    `SELECT s.token_sha256 AS "tokenSha256", s.member_auth_epoch AS "sessionEpoch", m.auth_epoch AS "memberEpoch",
       s.expires_at AS "expiresAt", s.revoked_at IS NOT NULL AS revoked,
       (m.status='active' AND u.status='active' AND o.status='active' AND s.expires_at > now()) AS active,
       u.id AS "userAccountId", m.id AS "memberId", u.email,
       coalesce((SELECT array_agg(r.key ORDER BY r.key) FROM enterprise.org_member_roles mr
         JOIN enterprise.roles r ON (r.organization_id,r.id)=(mr.organization_id,mr.role_id)
         WHERE mr.organization_id=m.organization_id AND mr.org_member_id=m.id), '{}') AS roles
     FROM enterprise.auth_sessions s
     JOIN enterprise.org_members m ON (m.organization_id,m.id)=(s.organization_id,s.org_member_id)
     JOIN enterprise.user_accounts u ON (u.organization_id,u.id)=(m.organization_id,m.user_account_id)
     JOIN enterprise.organizations o ON o.id=s.organization_id
     WHERE s.organization_id=$1 AND s.id=$2`, [organizationId, sessionId]);
  return result.rows[0];
}

/** 供同模組身份 service 使用。 */
export async function revokeSession(client: PoolClient, organizationId: string, sessionId: string) {
  await client.query('UPDATE enterprise.auth_sessions SET revoked_at=greatest(now(), created_at) WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL', [organizationId, sessionId]);
}

/** 供同模組身份 service 使用：撤銷成員全部 session，回傳撤銷筆數。 */
export async function revokeMemberSessions(client: PoolClient, organizationId: string, memberId: string) {
  return (await client.query('UPDATE enterprise.auth_sessions SET revoked_at=greatest(now(), created_at) WHERE organization_id=$1 AND org_member_id=$2 AND revoked_at IS NULL', [organizationId, memberId])).rowCount ?? 0;
}

/** 供同模組身份 service 使用：寫入 member/session 類 audit。 */
export async function appendIdentityAudit(client: PoolClient, organizationId: string, actorMemberId: string, action: string, resourceType: 'member' | 'session', resourceId: string) {
  await client.query('INSERT INTO enterprise.audit_events(organization_id,actor_member_id,action,resource_type,resource_id) VALUES ($1,$2,$3,$4,$5)',
    [organizationId, actorMemberId, action, resourceType, resourceId]);
}

/** 供同模組身份 service 使用。 */
export async function listMembers(client: PoolClient, organizationId: string) {
  return (await client.query<EnterpriseMemberRow>(`SELECT ${memberColumns} FROM ${memberFrom} WHERE m.organization_id=$1 ORDER BY m.created_at, m.id LIMIT 500`, [organizationId])).rows;
}

/** 供同模組身份 service 使用。 */
export async function getMember(client: PoolClient, organizationId: string, memberId: string) {
  return (await client.query<EnterpriseMemberRow>(`SELECT ${memberColumns} FROM ${memberFrom} WHERE m.organization_id=$1 AND m.id=$2`, [organizationId, memberId])).rows[0];
}

/** 供同模組身份 service 使用：依 key 取得本組織角色 id；任一 key 不存在回 undefined。 */
export async function findRoleIds(client: PoolClient, organizationId: string, keys: string[]) {
  const rows = (await client.query<{ id: string; key: string }>('SELECT id,key FROM enterprise.roles WHERE organization_id=$1 AND key = ANY($2::text[])', [organizationId, keys])).rows;
  return rows.length === new Set(keys).size ? rows.map(row => row.id) : undefined;
}

/** 供同模組身份 service 使用：建立帳號、成員、密碼憑證與角色。 */
export async function insertMember(client: PoolClient, input: { organizationId: string; email: string; passwordHash: string; roleIds: string[] }) {
  const account = (await client.query<{ id: string }>('INSERT INTO enterprise.user_accounts(organization_id,email) VALUES ($1,$2) RETURNING id', [input.organizationId, input.email])).rows[0];
  const member = (await client.query<{ id: string }>('INSERT INTO enterprise.org_members(organization_id,user_account_id) VALUES ($1,$2) RETURNING id', [input.organizationId, account.id])).rows[0];
  await client.query('INSERT INTO enterprise.account_credentials(organization_id,user_account_id,password_hash) VALUES ($1,$2,$3)', [input.organizationId, account.id, input.passwordHash]);
  for (const roleId of input.roleIds) {
    await client.query('INSERT INTO enterprise.org_member_roles(organization_id,org_member_id,role_id) VALUES ($1,$2,$3)', [input.organizationId, member.id, roleId]);
  }
  return member.id;
}

/** 供同模組身份 service 使用：設定成員狀態並遞增 auth_epoch（使既有 session 失效）。 */
export async function setMemberStatus(client: PoolClient, organizationId: string, memberId: string, status: 'active' | 'disabled') {
  return (await client.query("UPDATE enterprise.org_members SET status=$3, auth_epoch=auth_epoch+1, updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2", [organizationId, memberId, status])).rowCount === 1;
}

/** 供同模組身份 service 使用：取代成員角色並遞增 auth_epoch。 */
export async function replaceMemberRoles(client: PoolClient, organizationId: string, memberId: string, roleIds: string[]) {
  await client.query('DELETE FROM enterprise.org_member_roles WHERE organization_id=$1 AND org_member_id=$2', [organizationId, memberId]);
  for (const roleId of roleIds) {
    await client.query('INSERT INTO enterprise.org_member_roles(organization_id,org_member_id,role_id) VALUES ($1,$2,$3)', [organizationId, memberId, roleId]);
  }
  await client.query('UPDATE enterprise.org_members SET auth_epoch=auth_epoch+1, updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2', [organizationId, memberId]);
}

/** 供同模組身份 service 使用：除了 excludeMemberId 以外仍 active 的 org_admin 數。 */
export async function countOtherActiveAdmins(client: PoolClient, organizationId: string, excludeMemberId: string) {
  return (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM enterprise.org_members m
     JOIN enterprise.user_accounts u ON (u.organization_id,u.id)=(m.organization_id,m.user_account_id)
     JOIN enterprise.org_member_roles mr ON (mr.organization_id,mr.org_member_id)=(m.organization_id,m.id)
     JOIN enterprise.roles r ON (r.organization_id,r.id)=(mr.organization_id,mr.role_id)
     WHERE m.organization_id=$1 AND m.id<>$2 AND m.status='active' AND u.status='active' AND r.key='org_admin'`, [organizationId, excludeMemberId])).rows[0].n;
}
