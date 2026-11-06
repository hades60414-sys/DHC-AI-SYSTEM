import type { Pool, PoolClient } from 'pg';

import type { EnterprisePrincipal } from '@/shared/index.js';

import { findLiveEnterpriseSessionMember } from './enterprise.repository.js';

/**
 * 企業站內通知（DEC-EGRESS-01、DEC-RUN-01）：硬邊界事件同時通知「審查／管理角色」與「發出指令的人」。
 * 通知只帶代碼、資源 id 與固定說明文字，不帶 prompt、文件內容、provider 回應或位址。
 */
export type EnterpriseNotificationInput = {
  recipientMemberId?: string; audienceRole?: 'org_admin' | 'approver' | 'employee' | 'auditor';
  kind: string; severity: 'info' | 'warning' | 'critical'; subjectType: string; subjectId?: string | null; code?: string | null; message: string;
};

/** 供同模組服務在既有組織交易內呼叫（與觸發事件同一 transaction，一起提交或回退）。 */
export async function appendEnterpriseNotification(client: PoolClient, organizationId: string, input: EnterpriseNotificationInput) {
  await client.query(`INSERT INTO enterprise.notifications(organization_id,recipient_member_id,audience_role,kind,severity,subject_type,subject_id,code,message)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [organizationId, input.recipientMemberId ?? null, input.audienceRole ?? null, input.kind, input.severity,
    input.subjectType, input.subjectId ?? null, input.code ?? null, input.message]);
}

const EGRESS_MESSAGES: Record<string, string> = {
  ENTERPRISE_EGRESS_DENIED: '模型請求的目的地不符合本組織外送政策，已在送出前攔截。',
  ENTERPRISE_EGRESS_REDIRECT_DENIED: '模型服務要求轉址到未核准的位置，已拒絕跟隨，資料未送往轉址目標。',
};

/** 外送被拒：通知管理員（需檢查 provider 設定），並提醒申請者這是需要授權才能放行的硬邊界。 */
export async function notifyEgressDenied(client: PoolClient, organizationId: string, input: { runId: string; requesterMemberId: string; code: string }) {
  const message = EGRESS_MESSAGES[input.code] ?? EGRESS_MESSAGES.ENTERPRISE_EGRESS_DENIED;
  await appendEnterpriseNotification(client, organizationId, {
    audienceRole: 'org_admin', kind: 'model.egress_denied', severity: 'critical', subjectType: 'run', subjectId: input.runId, code: input.code,
    message: `${message}請檢查模型服務設定；放寬限制需由管理員具名調整並留稽核。`,
  });
  await appendEnterpriseNotification(client, organizationId, {
    recipientMemberId: input.requesterMemberId, kind: 'model.egress_denied', severity: 'warning', subjectType: 'run', subjectId: input.runId, code: input.code,
    message: `${message}這是組織設定的硬邊界，需管理員授權後才能執行，請勿自行改用其他管道傳送資料。`,
  });
}

async function inMembership<T>(pool: Pool, principal: EnterprisePrincipal, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('dhc.organization_id',$1,true)", [principal.organizationId]);
    const memberId = await findLiveEnterpriseSessionMember(client, principal.organizationId, principal.sessionId, principal.userAccountId);
    if (!memberId) throw new Error('ENTERPRISE_AUTH_REQUIRED');
    if (memberId !== principal.memberId) throw new Error('ENTERPRISE_SCOPE_DENIED');
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

export function createEnterpriseNotifications(pool: Pool) {
  return {
    /** 本人的通知：指名給自己，或給自己「目前」擁有角色的通知（角色以伺服器推導的 principal 為準）。最近 100 筆。 */
    async list(principal: EnterprisePrincipal) {
      return inMembership(pool, principal, async client => (await client.query(`SELECT n.id, n.kind, n.severity, n.subject_type AS "subjectType",
          n.subject_id AS "subjectId", n.code, n.message, n.created_at AS "createdAt", r.read_at AS "readAt",
          CASE WHEN n.recipient_member_id IS NULL THEN 'role' ELSE 'direct' END AS audience
        FROM enterprise.notifications n
        LEFT JOIN enterprise.notification_reads r ON (r.organization_id,r.notification_id,r.member_id)=(n.organization_id,n.id,$2)
        WHERE n.organization_id=$1 AND (n.recipient_member_id=$2 OR n.audience_role = ANY($3::text[]))
        ORDER BY n.created_at DESC, n.id LIMIT 100`, [principal.organizationId, principal.memberId, principal.roles])).rows);
    },

    async markRead(principal: EnterprisePrincipal, notificationId: unknown) {
      if (typeof notificationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notificationId)) throw new Error('ENTERPRISE_INVALID_ID');
      return inMembership(pool, principal, async client => {
        const visible = (await client.query(`SELECT 1 FROM enterprise.notifications WHERE organization_id=$1 AND id=$2
          AND (recipient_member_id=$3 OR audience_role = ANY($4::text[]))`, [principal.organizationId, notificationId, principal.memberId, principal.roles])).rowCount;
        if (!visible) throw new Error('ENTERPRISE_NOT_FOUND');
        await client.query(`INSERT INTO enterprise.notification_reads(organization_id,notification_id,member_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [principal.organizationId, notificationId, principal.memberId]);
        return { id: notificationId, read: true };
      });
    },
  };
}
