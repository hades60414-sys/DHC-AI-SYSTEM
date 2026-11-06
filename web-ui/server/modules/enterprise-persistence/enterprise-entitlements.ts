import type { PoolClient } from 'pg';

/**
 * PLAN-01 方案目錄（**內部候選價格，未經商業 Gate 批准，不得作為對外報價**）。
 * 價格只供後台顯示與人工帳務參考；權益限制才是伺服器強制的部分。
 */
export const ENTERPRISE_PLAN_CATALOG = {
  pilot: { name: 'Pilot（21 天）', setupFeeNtd: 19800, monthlyFeeNtd: 0, seatLimit: 3, workflowLimit: 1, monthlyRunLimit: 300, storageLimitBytes: 5 * 1024 ** 3, trialDays: 21 },
  studio: { name: 'Studio', setupFeeNtd: 49800, monthlyFeeNtd: 2980, seatLimit: 3, workflowLimit: 1, monthlyRunLimit: 600, storageLimitBytes: 20 * 1024 ** 3, trialDays: 0 },
  team: { name: 'Team', setupFeeNtd: 128000, monthlyFeeNtd: 7980, seatLimit: 10, workflowLimit: 3, monthlyRunLimit: 3000, storageLimitBytes: 100 * 1024 ** 3, trialDays: 0 },
  business: { name: 'Business', setupFeeNtd: 298000, monthlyFeeNtd: 14800, seatLimit: 20, workflowLimit: 5, monthlyRunLimit: 10000, storageLimitBytes: 300 * 1024 ** 3, trialDays: 0 },
  private: { name: 'Private/Group（客製）', setupFeeNtd: null, monthlyFeeNtd: null, seatLimit: 100, workflowLimit: 20, monthlyRunLimit: 100000, storageLimitBytes: 2 * 1024 ** 4, trialDays: 0 },
} as const;

export type EnterprisePlanKey = keyof typeof ENTERPRISE_PLAN_CATALOG;

/**
 * ASTRA-014：集中商務寫入政策。訂閱不在 trial/active/grace（含沒有訂閱、expired、cancelled）時，下列動作一律拒絕
 * （ENTERPRISE_SUBSCRIPTION_INACTIVE，fail closed）；續約後自動恢復。
 */
export const ENTERPRISE_BUSINESS_WRITE_ACTIONS = [
  'document.write', 'run.create', 'member.create', 'draft.revise', 'draft.submit', 'approval.decide', 'provider.upsert', 'quarantine.release', 'reconciliation.create',
] as const;
/**
 * 到期後仍允許（安全撤權、停止工作、資料保全與取得）：停權、改角色、登出、取消 Run、丟棄隔離結果、讀取、匯出、通知已讀。
 * 這些動作不得呼叫 checkEnterpriseEntitlement。佇列中尚未執行的 Run 在到期後不執行（B-EXPIRY-INFLIGHT 未決前的保守預設）。
 */
export const ENTERPRISE_EXPIRY_ALLOWED_ACTIONS = [
  'member.disable', 'member.roles', 'session.logout', 'run.cancel', 'quarantine.discard', 'draft.export', 'read', 'notification.read',
] as const;
type EntitlementAction = (typeof ENTERPRISE_BUSINESS_WRITE_ACTIONS)[number];

/** pg_advisory_xact_lock(int,int) 的鎖類別：組織權益（席位／Run／儲存）。取得順序永遠在成員管理鎖之後。 */
const ENTITLEMENT_LOCK_CLASS = 8_420_052;

type SubscriptionRow = {
  planKey: EnterprisePlanKey; status: 'trial' | 'active' | 'grace' | 'expired' | 'cancelled'; billingMode: 'byok' | 'managed';
  seatLimit: number; workflowLimit: number; monthlyRunLimit: number; storageLimitBytes: string;
  periodStart: string; periodEnd: string; graceUntil: string | null; effectiveStatus: string;
};

/** 供同模組 service 與 enterprise-api 使用：讀取訂閱並依日期計算實際狀態（period_end 後進入 grace，grace_until 後 expired）。 */
export async function readSubscription(client: PoolClient, organizationId: string) {
  return (await client.query<SubscriptionRow>(`SELECT plan_key AS "planKey", status, billing_mode AS "billingMode", seat_limit AS "seatLimit",
      workflow_limit AS "workflowLimit", monthly_run_limit AS "monthlyRunLimit", storage_limit_bytes::text AS "storageLimitBytes",
      period_start::text AS "periodStart", period_end::text AS "periodEnd", grace_until::text AS "graceUntil",
      CASE WHEN status IN ('expired','cancelled') THEN status
           WHEN current_date <= period_end THEN status
           WHEN grace_until IS NOT NULL AND current_date <= grace_until THEN 'grace'
           ELSE 'expired' END AS "effectiveStatus"
    FROM enterprise.subscriptions WHERE organization_id=$1`, [organizationId])).rows[0];
}

/** 訂閱是否允許商務寫入（不檢查配額）；worker 在呼叫模型前也用這個。 */
export async function requireActiveSubscription(client: PoolClient, organizationId: string) {
  const subscription = await readSubscription(client, organizationId);
  if (!subscription || !['trial', 'active', 'grace'].includes(subscription.effectiveStatus)) throw new Error('ENTERPRISE_SUBSCRIPTION_INACTIVE');
  return subscription;
}

/**
 * 伺服器端權益檢查（fail closed），必須在「會寫入的同一個交易」內呼叫（ASTRA-006）：
 * 先取組織級 transaction advisory lock，讓同組織的「檢查＋寫入」序列化，鎖到 COMMIT／ROLLBACK 才放。
 * - 所有動作：訂閱必須有效（ASTRA-014）。
 * - member.create（含重新啟用）：active 成員數達 seat_limit → ENTERPRISE_SEAT_LIMIT。
 * - run.create：本月 Run 數達 monthly_run_limit → ENTERPRISE_RUN_LIMIT。
 * - document.write：以「去重後實際新增的 bytes」計算 used + 新增 > storage_limit_bytes → ENTERPRISE_STORAGE_LIMIT。
 *   不帶 blob（路由層的快速預檢）只檢查訂閱；用量判斷一律在寫入交易內（否則已滿時會誤擋去重的相同內容）。
 * workflow_limit 的可販售定義待商業決策（B-WORKFLOW-LIMIT），目前不強制。
 */
export async function checkEnterpriseEntitlement(client: PoolClient, organizationId: string, action: EntitlementAction,
  extra: { blob?: { sha256: string; byteSize: number } } = {}) {
  await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [ENTITLEMENT_LOCK_CLASS, organizationId]);
  const subscription = await requireActiveSubscription(client, organizationId);
  if (action === 'member.create') {
    const seats = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM enterprise.org_members WHERE organization_id=$1 AND status='active'", [organizationId])).rows[0].n;
    if (seats >= subscription.seatLimit) throw new Error('ENTERPRISE_SEAT_LIMIT');
  } else if (action === 'run.create') {
    const runs = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM enterprise.runs WHERE organization_id=$1 AND created_at >= date_trunc('month', now())", [organizationId])).rows[0].n;
    if (runs >= subscription.monthlyRunLimit) throw new Error('ENTERPRISE_RUN_LIMIT');
  } else if (action === 'document.write') {
    if (!extra.blob) return;
    const limit = BigInt(subscription.storageLimitBytes);
    const used = BigInt((await client.query<{ total: string }>('SELECT coalesce(sum(byte_size),0)::text AS total FROM enterprise.document_blobs WHERE organization_id=$1', [organizationId])).rows[0].total);
    const exists = (await client.query('SELECT 1 FROM enterprise.document_blobs WHERE organization_id=$1 AND sha256=$2', [organizationId, extra.blob.sha256])).rowCount === 1;
    const added = exists ? 0n : BigInt(extra.blob.byteSize);
    if (used + added > limit) throw new Error('ENTERPRISE_STORAGE_LIMIT');
  }
}

/**
 * 供管理 CLI（供應商端）與 bootstrap 使用：以 migrator 身分設定訂閱並寫入 subscription_events（含 before/after 與原因）。
 * 呼叫端必須已在同一交易設定 dhc.organization_id。
 */
export async function setEnterpriseSubscription(client: PoolClient, organizationId: string, input: {
  planKey: EnterprisePlanKey; status: SubscriptionRow['status']; billingMode: 'byok' | 'managed'; periodStart: string; periodEnd: string;
  graceUntil?: string | null; seatLimit?: number; actor: string; reason: string;
}) {
  const plan = ENTERPRISE_PLAN_CATALOG[input.planKey];
  if (!plan) throw new Error('ENTERPRISE_INVALID_PLAN');
  if (!input.reason?.trim() || !input.actor?.trim()) throw new Error('ENTERPRISE_INVALID_TEXT');
  const before = await readSubscription(client, organizationId);
  const seatLimit = input.seatLimit ?? plan.seatLimit;
  await client.query(`INSERT INTO enterprise.subscriptions(organization_id,plan_key,status,billing_mode,seat_limit,workflow_limit,monthly_run_limit,storage_limit_bytes,period_start,period_end,grace_until)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (organization_id) DO UPDATE SET plan_key=EXCLUDED.plan_key, status=EXCLUDED.status, billing_mode=EXCLUDED.billing_mode, seat_limit=EXCLUDED.seat_limit,
      workflow_limit=EXCLUDED.workflow_limit, monthly_run_limit=EXCLUDED.monthly_run_limit, storage_limit_bytes=EXCLUDED.storage_limit_bytes,
      period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, grace_until=EXCLUDED.grace_until, updated_at=now()`,
  [organizationId, input.planKey, input.status, input.billingMode, seatLimit, plan.workflowLimit, plan.monthlyRunLimit, plan.storageLimitBytes, input.periodStart, input.periodEnd, input.graceUntil ?? null]);
  const after = await readSubscription(client, organizationId);
  await client.query('INSERT INTO enterprise.subscription_events(organization_id,actor,reason,before,after) VALUES ($1,$2,$3,$4,$5)',
    [organizationId, input.actor.trim(), input.reason.trim(), before ? JSON.stringify(before) : null, JSON.stringify(after)]);
  return after;
}
