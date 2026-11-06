import { createHash } from 'node:crypto';

import JSZip from 'jszip';
import type { Pool, PoolClient } from 'pg';

import type { EnterprisePermission, EnterprisePrincipal } from '@/shared/index.js';

import { checkEnterpriseEntitlement, readSubscription, requireActiveSubscription, ENTERPRISE_PLAN_CATALOG } from './enterprise-entitlements.js';
import { createScopedEnterpriseRepository, findLiveEnterpriseSessionMember } from './enterprise.repository.js';
import {
  costMicros, decideEgress, decryptProviderSecret, encryptProviderSecret, generateWithProvider, tokenUpperBound, type ModelProviderConfig,
} from './model-gateway.js';
import { parseRedirectAllowlist, staticDestinationAllowed, defaultEgressNetworkPolicy } from './egress-policy.js';
import { appendEnterpriseNotification, notifyEgressDenied } from './enterprise-notifications.js';
import { permissionsFor } from './enterprise-identity.service.js';
import { requireValidCitations, validateCitations } from './citation-integrity.js';

/**
 * DEC-RUN-01：誰可以放行隔離結果。預設只有 org_admin，且放行者不得為申請者本人。
 * 依套餐／客戶需求調整時只改這裡（並同步 DECISION_LEDGER 與測試）；放行永遠重新驗證申請者目前權限。
 */
const QUARANTINE_RELEASE_ROLES = ['org_admin'];

type RequesterState = { epoch: number; active: boolean; roles: string[] };

/** 在交易內讀申請者目前授權狀態；FOR SHARE 鎖住成員列，與停權／改角色（會 UPDATE auth_epoch）互相序列化。 */
async function requesterState(client: PoolClient, organizationId: string, memberId: string): Promise<RequesterState | null> {
  const row = (await client.query<{ epoch: number; active: boolean }>(`SELECT m.auth_epoch AS epoch, (m.status='active' AND u.status='active') AS active
    FROM enterprise.org_members m JOIN enterprise.user_accounts u ON (u.organization_id,u.id)=(m.organization_id,m.user_account_id)
    WHERE m.organization_id=$1 AND m.id=$2 FOR SHARE OF m`, [organizationId, memberId])).rows[0];
  if (!row) return null;
  const roles = (await client.query<{ key: string }>(`SELECT r.key FROM enterprise.org_member_roles mr
    JOIN enterprise.roles r ON (r.organization_id,r.id)=(mr.organization_id,mr.role_id) WHERE mr.organization_id=$1 AND mr.org_member_id=$2`,
  [organizationId, memberId])).rows.map(role => role.key);
  return { ...row, roles };
}

async function lockHeldQuarantine(client: PoolClient, organizationId: string, runId: string) {
  const row = (await client.query<{ status: string; body: string; citations: unknown[]; draftId: string; requestedByMemberId: string }>(`SELECT q.status, q.body, q.citations,
      q.draft_id AS "draftId", r.requested_by_member_id AS "requestedByMemberId"
    FROM enterprise.run_quarantine q JOIN enterprise.runs r ON (r.organization_id,r.id)=(q.organization_id,q.run_id)
    WHERE q.organization_id=$1 AND q.run_id=$2 FOR UPDATE OF q, r`, [organizationId, runId])).rows[0];
  if (!row) throw new Error('ENTERPRISE_NOT_FOUND');
  if (row.status !== 'held') throw new Error('ENTERPRISE_RUN_NOT_QUARANTINED');
  return row;
}

function stillAuthorized(state: RequesterState | null, runEpoch: number | null) {
  return !!state && state.active && runEpoch !== null && state.epoch === runEpoch && permissionsFor(state.roles).includes('tasks.write');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OUTPUT_TOKENS = 1500;
const RUN_TIMEOUT_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const TRANSIENT = new Set(['ENTERPRISE_PROVIDER_TIMEOUT', 'ENTERPRISE_PROVIDER_UNREACHABLE', 'ENTERPRISE_PROVIDER_HTTP_ERROR', 'ENTERPRISE_PROVIDER_CONNECTION_LOST']);
/**
 * ASTRA-008：呼叫失敗時這次 attempt 的帳務狀態。
 * - 未送出或供應商明確回錯誤：failed，成本 0，final。
 * - 可能已被處理但不知用量（逾時、送出後斷線、2xx 但內容不完整）：unknown，成本 NULL，預留持續計入預算，待對帳。
 * - 政策拒絕：denied。
 */
const UNKNOWN_USAGE = new Set(['ENTERPRISE_PROVIDER_TIMEOUT', 'ENTERPRISE_PROVIDER_CONNECTION_LOST', 'ENTERPRISE_PROVIDER_BAD_RESPONSE']);
const BUDGET_LOCK_CLASS = 8_420_053;
/** ASTRA-V3-NEW-003：同一成員同一 Idempotency-Key 的建立請求序列化。取得順序：本鎖 → 組織權益鎖（8420052）。 */
const IDEMPOTENCY_LOCK_CLASS = 8_420_054;

const providerColumns = `id, key, kind, base_url AS "baseUrl", model, deployment, api_key_ciphertext IS NOT NULL AS "hasApiKey",
  input_price_micros_per_mtok::bigint::text AS "inputPriceMicrosPerMtok", output_price_micros_per_mtok::bigint::text AS "outputPriceMicrosPerMtok",
  monthly_budget_micros::bigint::text AS "monthlyBudgetMicros", redirect_allowlist AS "redirectAllowlist", price_version AS "priceVersion",
  price_source AS "priceSource", price_effective_at AS "priceEffectiveAt", enabled, updated_at AS "updatedAt"`;
const runColumns = `id, kind, status, requested_by_member_id AS "requestedByMemberId", idempotency_key AS "idempotencyKey", input,
  draft_id AS "draftId", attempts, cancel_requested AS "cancelRequested", error_code AS "errorCode",
  created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"`;
const draftColumns = `d.id, d.title, d.status, d.author_member_id AS "authorMemberId", d.current_revision AS "currentRevision",
  d.created_at AS "createdAt", d.updated_at AS "updatedAt"`;

function requireUuid(value: unknown) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('ENTERPRISE_INVALID_ID');
  return value.toLowerCase();
}
function requireText(value: unknown, max: number, code = 'ENTERPRISE_INVALID_TEXT') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(code);
  return value.trim();
}
function requirePermission(principal: EnterprisePrincipal, ...permissions: EnterprisePermission[]) {
  if (!permissions.every(permission => principal.permissions.includes(permission))) throw new Error('ENTERPRISE_FORBIDDEN');
}

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
 * 在交易內重驗呼叫者的 session 仍有效且 epoch 未變（認證之後到交易開始之間可能已被停權或降權；BUILDER-V4-NEW-004）。
 * 權限由認證時的角色推導；角色變更會遞增 epoch，所以 epoch 相符＝角色未變。
 */
async function asMember<T>(pool: Pool, principal: EnterprisePrincipal, operation: (client: PoolClient) => Promise<T>) {
  return inOrganization(pool, principal.organizationId, async client => {
    const memberId = await findLiveEnterpriseSessionMember(client, principal.organizationId, principal.sessionId, principal.userAccountId);
    if (!memberId) throw new Error('ENTERPRISE_AUTH_REQUIRED');
    if (memberId !== principal.memberId) throw new Error('ENTERPRISE_SCOPE_DENIED');
    return operation(client);
  });
}

async function audit(client: PoolClient, organizationId: string, memberId: string, action: string, resourceType: string, resourceId: string) {
  await client.query('INSERT INTO enterprise.audit_events(organization_id,actor_member_id,action,resource_type,resource_id) VALUES ($1,$2,$3,$4,$5)',
    [organizationId, memberId, action, resourceType, resourceId]);
}

function toProviderConfig(row: Record<string, unknown>): ModelProviderConfig {
  return {
    id: String(row.id), kind: row.kind as ModelProviderConfig['kind'], baseUrl: (row.baseUrl as string | null) ?? null, model: String(row.model),
    deployment: row.deployment as ModelProviderConfig['deployment'],
    inputPriceMicrosPerMtok: Number(row.inputPriceMicrosPerMtok), outputPriceMicrosPerMtok: Number(row.outputPriceMicrosPerMtok),
    redirectAllowlist: Array.isArray(row.redirectAllowlist) ? (row.redirectAllowlist as string[]) : [],
  };
}

/** 本月已承諾支出：已知成本＋（reserved／unknown 以預留額度計，不當成 0）。 */
async function monthlySpend(client: PoolClient, organizationId: string, providerId: string) {
  return Number((await client.query<{ total: string }>(`SELECT coalesce(sum(CASE WHEN status IN ('reserved','unknown') THEN reserved_micros ELSE coalesce(cost_micros,0) END),0)::text AS total
    FROM enterprise.model_usage WHERE organization_id=$1 AND provider_id=$2 AND created_at >= date_trunc('month', now())`, [organizationId, providerId])).rows[0].total);
}

/**
 * lock＝true：FOR UPDATE 鎖草稿列（ASTRA-V3-NEW-001）。改稿、送審、審批決定都先鎖草稿再檢查狀態與版號，
 * 讀到的一定是最新已提交的狀態；鎖順序固定為 draft → approval，避免死結。
 */
async function getDraftRow(client: PoolClient, organizationId: string, draftId: string, lock = false) {
  return (await client.query<{ id: string; title: string; status: string; authorMemberId: string; currentRevision: number; createdAt: Date; updatedAt: Date }>(
    `SELECT ${draftColumns} FROM enterprise.drafts d WHERE d.organization_id=$1 AND d.id=$2${lock ? ' FOR UPDATE OF d' : ''}`, [organizationId, draftId])).rows[0];
}

/** 修訂內容指紋：{body, citations} 的 JSON（citations 為資料庫 jsonb 讀回的值）SHA-256；API 回傳的 body／citations 可重算。 */
function revisionSha256(revision: { body: string; citations: unknown }) {
  return createHash('sha256').update(JSON.stringify({ body: revision.body, citations: revision.citations })).digest('hex');
}

/** 審批者確認的版號與 hash 必須與 approval 綁定的修訂一致，否則視為過期畫面（409）。 */
function requireConfirmedRevision(input: Record<string, unknown>, revision: number, sha256: string) {
  if (input.expectedRevision !== revision || input.expectedSha256 !== sha256) throw new Error('ENTERPRISE_APPROVAL_STALE');
}

/** ASTRA-007：寫入修訂時一併記錄引用檢查快照。 */
async function insertRevision(client: PoolClient, organizationId: string, input: { draftId: string; revision: number; body: string; citations: unknown; source: 'model' | 'human'; memberId: string }) {
  const checked = await validateCitations(client, organizationId, input.body, input.citations);
  await client.query(`INSERT INTO enterprise.draft_revisions(organization_id,draft_id,revision,body,citations,source,created_by_member_id,citation_status,citation_report)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [organizationId, input.draftId, input.revision, input.body, JSON.stringify(input.citations ?? []), input.source, input.memberId,
    checked.status, JSON.stringify(checked.report)]);
}

/** 讀取修訂：citationStatus／citationReport 為「現在」重驗的結果（來源可能已漂移）；建立時的快照另以 *AtCreation 回傳。 */
async function getRevision(client: PoolClient, organizationId: string, draftId: string, revision: number) {
  const row = await getStoredRevision(client, organizationId, draftId, revision);
  if (!row) return row;
  const live = await validateCitations(client, organizationId, row.body, row.citations);
  const { citationStatusAtCreation, citationReportAtCreation, ...rest } = row;
  return { ...rest, citationStatus: live.status, citationReport: live.report, citationStatusAtCreation, citationReportAtCreation };
}

async function getStoredRevision(client: PoolClient, organizationId: string, draftId: string, revision: number) {
  return (await client.query<{ revision: number; body: string; citations: unknown[]; source: string; createdByMemberId: string; createdAt: Date;
    citationStatusAtCreation: string | null; citationReportAtCreation: unknown }>(
    `SELECT revision, body, citations, source, created_by_member_id AS "createdByMemberId", created_at AS "createdAt",
       citation_status AS "citationStatusAtCreation", citation_report AS "citationReportAtCreation"
     FROM enterprise.draft_revisions WHERE organization_id=$1 AND draft_id=$2 AND revision=$3`, [organizationId, draftId, revision])).rows[0];
}

/** Entitlement hook（PLAN-01 注入）：在建立 Run 前檢查方案額度；拋 ENTERPRISE_* 代碼拒絕。 */
type EntitlementCheck = (client: PoolClient, organizationId: string, action: 'run.create') => Promise<void>;

/**
 * 供 enterprise-api 路由與 run worker 使用的文書流程服務（RUN-01 / MODEL-01 / DOC-03）。
 * 每個方法都在已核對的組織交易內重查呼叫者 membership；權限由伺服器推導的 principal.permissions 決定。
 */
export function createEnterpriseWorkflow(pool: Pool, options: { secretKey?: string; checkEntitlement?: EntitlementCheck } = {}) {
  /** 放行／丟棄／檢視隔離內容：交易內重查呼叫者目前角色（不只信任 session 推導的權限）。 */
  async function asReleaser<T>(principal: EnterprisePrincipal, operation: (client: PoolClient) => Promise<T>) {
    if (!principal.roles.some(role => QUARANTINE_RELEASE_ROLES.includes(role))) throw new Error('ENTERPRISE_FORBIDDEN');
    return asMember(pool, principal, async client => {
      const current = await requesterState(client, principal.organizationId, principal.memberId);
      if (!current?.active || !current.roles.some(role => QUARANTINE_RELEASE_ROLES.includes(role))) throw new Error('ENTERPRISE_FORBIDDEN');
      return operation(client);
    });
  }
  return {
    async listProviders(principal: EnterprisePrincipal) {
      requirePermission(principal, 'tasks.read');
      return asMember(pool, principal, async client => (await client.query(
        `SELECT ${providerColumns} FROM enterprise.model_providers WHERE organization_id=$1 ORDER BY key`, [principal.organizationId])).rows);
    },

    /** 管理員新增或更新 provider；apiKey 只加密保存、不回傳。base_url 在 LOCAL_ONLY 模式必須指向客戶內部主機。 */
    async upsertProvider(principal: EnterprisePrincipal, input: Record<string, unknown>) {
      requirePermission(principal, 'models.manage');
      const key = typeof input.key === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(input.key) ? input.key : null;
      const kind = ['mock', 'openai_compatible', 'anthropic'].includes(String(input.kind)) ? String(input.kind) : null;
      const deployment = ['LOCAL_ONLY', 'CLOUD_ALLOWED'].includes(String(input.deployment)) ? String(input.deployment) : null;
      const baseUrl = input.baseUrl === undefined || input.baseUrl === null || input.baseUrl === '' ? null : String(input.baseUrl);
      if (!key || !kind || !deployment) throw new Error('ENTERPRISE_INVALID_PROVIDER');
      if (baseUrl !== null && !/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error('ENTERPRISE_INVALID_PROVIDER');
      const model = requireText(input.model ?? (kind === 'mock' ? 'mock' : ''), 200, 'ENTERPRISE_INVALID_PROVIDER');
      const prices = ['inputPriceMicrosPerMtok', 'outputPriceMicrosPerMtok', 'monthlyBudgetMicros'].map(name => Number(input[name] ?? 0));
      if (prices.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('ENTERPRISE_INVALID_PROVIDER');
      const config: ModelProviderConfig = { id: 'validate', kind: kind as ModelProviderConfig['kind'], baseUrl, model, deployment: deployment as ModelProviderConfig['deployment'], inputPriceMicrosPerMtok: prices[0], outputPriceMicrosPerMtok: prices[1] };
      if (deployment === 'LOCAL_ONLY' && kind !== 'mock') decideEgress(config, ['restricted']);
      if (deployment === 'CLOUD_ALLOWED' && kind !== 'mock') decideEgress(config, ['public']);
      // DEC-EGRESS-01：allowlist 目標本身也要通過同一 deployment 的網段政策（LOCAL_ONLY 不能列公網主機）。
      const redirectAllowlist = parseRedirectAllowlist(input.redirectAllowlist);
      if (kind === 'mock' && redirectAllowlist.length) throw new Error('ENTERPRISE_INVALID_PROVIDER');
      for (const target of redirectAllowlist) {
        if (!staticDestinationAllowed(config.deployment, new URL(`http://${target}`), defaultEgressNetworkPolicy())) throw new Error('ENTERPRISE_EGRESS_DENIED');
      }
      const sealed = typeof input.apiKey === 'string' && input.apiKey ? encryptProviderSecret(input.apiKey, options.secretKey) : undefined;
      const enabled = input.enabled !== false;
      const priceSource = input.priceSource === undefined || input.priceSource === null || input.priceSource === '' ? null : requireText(input.priceSource, 200, 'ENTERPRISE_INVALID_PROVIDER');
      return asMember(pool, principal, async client => {
        await checkEnterpriseEntitlement(client, principal.organizationId, 'provider.upsert');
        const previous = (await client.query<{ allowlist: string[] }>('SELECT redirect_allowlist AS allowlist FROM enterprise.model_providers WHERE organization_id=$1 AND key=$2 FOR UPDATE',
          [principal.organizationId, key])).rows[0]?.allowlist ?? [];
        // ASTRA-008：價格或來源變更 → price_version+1、price_effective_at=now()；用量帳逐筆保存當下快照。
        const row = (await client.query(`INSERT INTO enterprise.model_providers
            (organization_id,key,kind,base_url,model,deployment,api_key_ciphertext,input_price_micros_per_mtok,output_price_micros_per_mtok,monthly_budget_micros,enabled,redirect_allowlist,price_source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13,'unspecified'))
          ON CONFLICT (organization_id,key) DO UPDATE SET base_url=EXCLUDED.base_url, model=EXCLUDED.model, deployment=EXCLUDED.deployment,
            api_key_ciphertext=coalesce(EXCLUDED.api_key_ciphertext, enterprise.model_providers.api_key_ciphertext),
            input_price_micros_per_mtok=EXCLUDED.input_price_micros_per_mtok, output_price_micros_per_mtok=EXCLUDED.output_price_micros_per_mtok,
            monthly_budget_micros=EXCLUDED.monthly_budget_micros, enabled=EXCLUDED.enabled, redirect_allowlist=EXCLUDED.redirect_allowlist,
            price_version=CASE WHEN (enterprise.model_providers.input_price_micros_per_mtok, enterprise.model_providers.output_price_micros_per_mtok, enterprise.model_providers.price_source)
              IS DISTINCT FROM (EXCLUDED.input_price_micros_per_mtok, EXCLUDED.output_price_micros_per_mtok, coalesce($13, enterprise.model_providers.price_source))
              THEN enterprise.model_providers.price_version + 1 ELSE enterprise.model_providers.price_version END,
            price_effective_at=CASE WHEN (enterprise.model_providers.input_price_micros_per_mtok, enterprise.model_providers.output_price_micros_per_mtok, enterprise.model_providers.price_source)
              IS DISTINCT FROM (EXCLUDED.input_price_micros_per_mtok, EXCLUDED.output_price_micros_per_mtok, coalesce($13, enterprise.model_providers.price_source))
              THEN now() ELSE enterprise.model_providers.price_effective_at END,
            price_source=coalesce($13, enterprise.model_providers.price_source), updated_at=greatest(now(), enterprise.model_providers.created_at)
          WHERE enterprise.model_providers.kind = EXCLUDED.kind
          RETURNING ${providerColumns}`,
        [principal.organizationId, key, kind, baseUrl, model, deployment, sealed ?? null, prices[0], prices[1], prices[2], enabled, redirectAllowlist, priceSource])).rows[0];
        if (!row) throw new Error('ENTERPRISE_INVALID_PROVIDER');
        await audit(client, principal.organizationId, principal.memberId, 'model_provider.saved', 'model_provider', String(row.id));
        // 放寬外送（redirect allowlist 變更）需具名管理員並留獨立稽核事件。
        if ([...previous].sort().join(',') !== [...redirectAllowlist].sort().join(',')) {
          await audit(client, principal.organizationId, principal.memberId, 'model_provider.redirect_allowlist_changed', 'model_provider', String(row.id));
        }
        return row;
      });
    },

    /** PLAN-01：本組織訂閱與用量（唯讀；客戶端不能修改權益）。 */
    async subscription(principal: EnterprisePrincipal) {
      if (!principal.permissions.includes('billing.read')) throw new Error('ENTERPRISE_FORBIDDEN');
      return asMember(pool, principal, async client => {
        const subscription = await readSubscription(client, principal.organizationId);
        const usage = (await client.query(`SELECT
            (SELECT count(*)::int FROM enterprise.org_members WHERE organization_id=$1 AND status='active') AS "activeSeats",
            (SELECT count(*)::int FROM enterprise.runs WHERE organization_id=$1 AND created_at >= date_trunc('month', now())) AS "runsThisMonth",
            (SELECT coalesce(sum(byte_size),0)::text FROM enterprise.document_blobs WHERE organization_id=$1) AS "storageBytes"`, [principal.organizationId])).rows[0];
        const invoices = (await client.query(`SELECT id, period_start::text AS "periodStart", period_end::text AS "periodEnd", amount_ntd::text AS "amountNtd", state, note
          FROM enterprise.invoices WHERE organization_id=$1 ORDER BY period_start DESC LIMIT 24`, [principal.organizationId])).rows;
        return { subscription: subscription ?? null, plan: subscription ? ENTERPRISE_PLAN_CATALOG[subscription.planKey] : null, usage, invoices };
      });
    },

    /** PLAN-01／ASTRA-014：文件寫入前的快速預檢（只看訂閱）；儲存配額在寫入交易內（reserveStorage）檢查。 */
    async assertDocumentWrite(principal: EnterprisePrincipal) {
      await asMember(pool, principal, client => checkEnterpriseEntitlement(client, principal.organizationId, 'document.write'));
    },

    async usageSummary(principal: EnterprisePrincipal) {
      if (!principal.permissions.includes('billing.read') && !principal.permissions.includes('models.manage')) throw new Error('ENTERPRISE_FORBIDDEN');
      return asMember(pool, principal, async client => (await client.query(`
        SELECT p.key, p.kind, p.monthly_budget_micros::text AS "monthlyBudgetMicros",
          coalesce(sum(u.cost_micros) FILTER (WHERE u.status='succeeded'),0)::text AS "spentMicros",
          coalesce(sum(u.reserved_micros) FILTER (WHERE u.status IN ('reserved','unknown')),0)::text AS "unknownOrReservedMicros",
          count(u.id) FILTER (WHERE u.reconciled_state='pending_reconciliation')::int AS "pendingReconciliation",
          coalesce(sum(u.input_tokens),0)::int AS "inputTokens", coalesce(sum(u.output_tokens),0)::int AS "outputTokens",
          count(u.id) FILTER (WHERE u.status='succeeded')::int AS "succeededCalls", count(u.id) FILTER (WHERE u.status<>'succeeded')::int AS "failedOrDeniedCalls"
        FROM enterprise.model_providers p
        LEFT JOIN enterprise.model_usage u ON (u.organization_id,u.provider_id)=(p.organization_id,p.id) AND u.created_at >= date_trunc('month', now())
        WHERE p.organization_id=$1 GROUP BY p.id ORDER BY p.key`, [principal.organizationId])).rows);
    },

    /**
     * ASTRA-008：對帳（billing.manage）。只處理 pending_reconciliation 的 attempt：
     * charged＝依帳單 token 用量以該筆價格快照計價（或直接給 costMicros）；not_charged＝成本 0。對帳後 final，留稽核。
     */
    async reconcileUsage(principal: EnterprisePrincipal, usageId: unknown, input: Record<string, unknown>) {
      requirePermission(principal, 'billing.manage');
      const id = requireUuid(usageId);
      const outcome = input.outcome === 'charged' || input.outcome === 'not_charged' ? input.outcome : null;
      if (!outcome) throw new Error('ENTERPRISE_INVALID_DECISION');
      const note = requireText(input.note, 500);
      const tokens = ['inputTokens', 'outputTokens'].map(name => input[name] === undefined ? 0 : Number(input[name]));
      if (tokens.some(value => !Number.isSafeInteger(value) || value < 0 || value > 100_000_000)) throw new Error('ENTERPRISE_INVALID_TEXT');
      const explicitCost = input.costMicros === undefined ? null : Number(input.costMicros);
      if (explicitCost !== null && (!Number.isSafeInteger(explicitCost) || explicitCost < 0)) throw new Error('ENTERPRISE_INVALID_TEXT');
      return asMember(pool, principal, async client => {
        // 與 worker 預留同一把 provider 預算鎖（鎖順序：預算鎖 → 用量列），對帳造成的預算變動與預留檢查序列化。
        const target = (await client.query<{ providerId: string }>('SELECT provider_id AS "providerId" FROM enterprise.model_usage WHERE organization_id=$1 AND id=$2',
          [principal.organizationId, id])).rows[0];
        if (!target) throw new Error('ENTERPRISE_NOT_FOUND');
        await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [BUDGET_LOCK_CLASS, target.providerId]);
        const row = (await client.query<{ status: string; state: string; inPrice: string | null; outPrice: string | null }>(`SELECT status, reconciled_state AS state,
            input_price_micros_per_mtok::text AS "inPrice", output_price_micros_per_mtok::text AS "outPrice"
          FROM enterprise.model_usage WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [principal.organizationId, id])).rows[0];
        if (!row) throw new Error('ENTERPRISE_NOT_FOUND');
        if (row.state !== 'pending_reconciliation') throw new Error('ENTERPRISE_USAGE_ALREADY_RECONCILED');
        // ASTRA-V3-NEW-002：reserved＝呼叫仍在飛行（worker 尚未終結），不能對帳；只對帳已終結的 unknown 與 succeeded/estimated。
        if (row.status === 'reserved') throw new Error('ENTERPRISE_USAGE_IN_FLIGHT');
        const cost = outcome === 'not_charged' ? 0 : explicitCost ?? Math.ceil((tokens[0] * Number(row.inPrice ?? 0) + tokens[1] * Number(row.outPrice ?? 0)) / 1_000_000);
        await client.query(`UPDATE enterprise.model_usage SET status=$3, input_tokens=$4, output_tokens=$5, cost_micros=$6, usage_source='reconciled',
            reconciled_state='final', reconciled_by_member_id=$7, reconciled_at=now(), reconcile_note=$8, finished_at=coalesce(finished_at, now())
          WHERE organization_id=$1 AND id=$2 AND status<>'reserved' AND reconciled_state='pending_reconciliation'`, [principal.organizationId, id, outcome === 'charged' ? 'succeeded' : 'failed', tokens[0], tokens[1], cost, principal.memberId, note]);
        await audit(client, principal.organizationId, principal.memberId, 'model_usage.reconciled', 'model_usage', id);
        return { id, outcome, costMicros: String(cost) };
      });
    },

    /** 建立草稿生成 Run（冪等：同一成員同一 idempotencyKey 回傳原 Run）。實際生成由 worker 執行。 */
    async createDraftRun(principal: EnterprisePrincipal, input: Record<string, unknown>) {
      requirePermission(principal, 'tasks.write', 'documents.read');
      const title = requireText(input.title, 300);
      const query = requireText(input.query, 1000, 'ENTERPRISE_INVALID_QUERY');
      const providerKey = requireText(input.providerKey, 41, 'ENTERPRISE_INVALID_PROVIDER');
      const idempotencyKey = typeof input.idempotencyKey === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(input.idempotencyKey) ? input.idempotencyKey : null;
      if (!idempotencyKey) throw new Error('ENTERPRISE_IDEMPOTENCY_KEY_REQUIRED');
      return asMember(pool, principal, async client => {
        // ASTRA-V3-NEW-003：先鎖（org, member, key），再查既有 Run；並行的同 key 請求會等前一個交易提交後讀到同一個 Run，
        // 不會撞 UNIQUE（500）或在配額檢查誤回 429。UNIQUE 約束保留為最後防線。
        await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))',
          [IDEMPOTENCY_LOCK_CLASS, `${principal.organizationId}:${principal.memberId}:${idempotencyKey}`]);
        const existing = (await client.query<Record<string, unknown> & { input: { query?: string; providerKey?: string } }>(`SELECT ${runColumns},
            (SELECT d.title FROM enterprise.drafts d WHERE (d.organization_id,d.id)=(r.organization_id,r.draft_id)) AS "requestTitle"
          FROM enterprise.runs r WHERE organization_id=$1 AND requested_by_member_id=$2 AND idempotency_key=$3`,
          [principal.organizationId, principal.memberId, idempotencyKey])).rows[0];
        if (existing) {
          const { requestTitle, ...run } = existing;
          // 同 key 不同內容：契約錯誤（409），不回傳另一個請求的 Run。
          if (existing.input?.query !== query || existing.input?.providerKey !== providerKey || requestTitle !== title) throw new Error('ENTERPRISE_IDEMPOTENCY_KEY_REUSED');
          return { run, reused: true };
        }
        const provider = (await client.query('SELECT id FROM enterprise.model_providers WHERE organization_id=$1 AND key=$2 AND enabled', [principal.organizationId, providerKey])).rows[0];
        if (!provider) throw new Error('ENTERPRISE_PROVIDER_NOT_FOUND');
        await (options.checkEntitlement ?? checkEnterpriseEntitlement)(client, principal.organizationId, 'run.create');
        // ASTRA-004：以「目前這個 session 仍有效且 epoch 一致」為前提，把成員當下的 auth_epoch 綁進 Run。
        const bound = (await client.query<{ epoch: number }>(`SELECT m.auth_epoch AS epoch FROM enterprise.org_members m
          JOIN enterprise.auth_sessions s ON (s.organization_id,s.org_member_id)=(m.organization_id,m.id)
          WHERE m.organization_id=$1 AND m.id=$2 AND s.id=$3 AND s.revoked_at IS NULL AND s.expires_at > now() AND s.member_auth_epoch=m.auth_epoch
          FOR SHARE OF m`, [principal.organizationId, principal.memberId, principal.sessionId])).rows[0];
        if (!bound) throw new Error('ENTERPRISE_AUTH_REQUIRED');
        const draft = (await client.query<{ id: string }>('INSERT INTO enterprise.drafts(organization_id,author_member_id,title) VALUES ($1,$2,$3) RETURNING id',
          [principal.organizationId, principal.memberId, title])).rows[0];
        const run = (await client.query(`INSERT INTO enterprise.runs(organization_id,kind,requested_by_member_id,idempotency_key,input,draft_id,requester_auth_epoch)
          VALUES ($1,'draft.generate',$2,$3,$4,$5,$6) RETURNING ${runColumns}`,
        [principal.organizationId, principal.memberId, idempotencyKey, JSON.stringify({ query, providerKey }), draft.id, bound.epoch])).rows[0];
        await audit(client, principal.organizationId, principal.memberId, 'run.created', 'run', String(run.id));
        return { run, reused: false };
      });
    },

    async getRun(principal: EnterprisePrincipal, runId: unknown) {
      requirePermission(principal, 'tasks.read');
      const id = requireUuid(runId);
      return asMember(pool, principal, async client => {
        const run = (await client.query(`SELECT ${runColumns} FROM enterprise.runs WHERE organization_id=$1 AND id=$2`, [principal.organizationId, id])).rows[0];
        // 一般成員只能看自己的 Run；審核者／管理員可看全部。
        if (!run || (run.requestedByMemberId !== principal.memberId && !principal.permissions.includes('approvals.decide'))) throw new Error('ENTERPRISE_NOT_FOUND');
        return run;
      });
    },

    async listRuns(principal: EnterprisePrincipal) {
      requirePermission(principal, 'tasks.read');
      const all = principal.permissions.includes('approvals.decide');
      return asMember(pool, principal, async client => (await client.query(`SELECT ${runColumns} FROM enterprise.runs WHERE organization_id=$1 AND ($2 OR requested_by_member_id=$3)
        ORDER BY created_at DESC LIMIT 100`, [principal.organizationId, all, principal.memberId])).rows);
    },

    /** 取消：queued 直接取消；running 標記 cancel_requested，由 worker 在寫入結果前檢查。 */
    async cancelRun(principal: EnterprisePrincipal, runId: unknown) {
      requirePermission(principal, 'tasks.write');
      const id = requireUuid(runId);
      return asMember(pool, principal, async client => {
        const run = (await client.query(`SELECT ${runColumns} FROM enterprise.runs WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [principal.organizationId, id])).rows[0];
        if (!run || (run.requestedByMemberId !== principal.memberId && !principal.permissions.includes('members.manage'))) throw new Error('ENTERPRISE_NOT_FOUND');
        if (run.status === 'queued') {
          await client.query("UPDATE enterprise.runs SET status='cancelled', cancel_requested=true, finished_at=now(), updated_at=now() WHERE organization_id=$1 AND id=$2", [principal.organizationId, id]);
          await client.query("UPDATE enterprise.drafts SET status='failed', updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2", [principal.organizationId, run.draftId]);
        } else if (run.status === 'running') {
          await client.query('UPDATE enterprise.runs SET cancel_requested=true, updated_at=now() WHERE organization_id=$1 AND id=$2', [principal.organizationId, id]);
        } else {
          throw new Error('ENTERPRISE_RUN_NOT_CANCELLABLE');
        }
        await audit(client, principal.organizationId, principal.memberId, 'run.cancel_requested', 'run', id);
        return (await client.query(`SELECT ${runColumns} FROM enterprise.runs WHERE organization_id=$1 AND id=$2`, [principal.organizationId, id])).rows[0];
      });
    },

    /** DEC-RUN-01：隔離內容只給可放行角色檢視（審查者收到通知，但預設看不到內容）。 */
    async getQuarantine(principal: EnterprisePrincipal, runId: unknown) {
      const id = requireUuid(runId);
      return asReleaser(principal, async client => {
        const row = (await client.query(`SELECT q.run_id AS "runId", q.draft_id AS "draftId", q.reason_code AS "reasonCode", q.status, q.body, q.citations,
            q.decided_by_member_id AS "decidedByMemberId", q.decided_at AS "decidedAt", q.created_at AS "createdAt", r.requested_by_member_id AS "requestedByMemberId"
          FROM enterprise.run_quarantine q JOIN enterprise.runs r ON (r.organization_id,r.id)=(q.organization_id,q.run_id)
          WHERE q.organization_id=$1 AND q.run_id=$2`, [principal.organizationId, id])).rows[0];
        if (!row) throw new Error('ENTERPRISE_NOT_FOUND');
        return row;
      });
    },

    /**
     * 放行：管理員（非申請者本人）在交易內重新驗證申請者「目前」active 且有 tasks.write，才把隔離結果寫成正常草稿 revision 1。
     * 放行是新的、具名的授權決定，不是恢復舊授權；全程稽核並通知申請者。
     */
    async releaseQuarantine(principal: EnterprisePrincipal, runId: unknown) {
      const id = requireUuid(runId);
      return asReleaser(principal, async client => {
        const held = await lockHeldQuarantine(client, principal.organizationId, id);
        if (held.requestedByMemberId === principal.memberId) throw new Error('ENTERPRISE_FORBIDDEN');
        await checkEnterpriseEntitlement(client, principal.organizationId, 'quarantine.release');
        const state = await requesterState(client, principal.organizationId, held.requestedByMemberId);
        if (!state || !state.active || !permissionsFor(state.roles).includes('tasks.write')) throw new Error('ENTERPRISE_PRINCIPAL_REVOKED');
        await insertRevision(client, principal.organizationId, { draftId: held.draftId, revision: 1, body: held.body, citations: held.citations, source: 'model', memberId: held.requestedByMemberId });
        await client.query("UPDATE enterprise.drafts SET status='draft', current_revision=1, updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2", [principal.organizationId, held.draftId]);
        await client.query("UPDATE enterprise.runs SET status='succeeded', error_code=NULL, updated_at=now() WHERE organization_id=$1 AND id=$2", [principal.organizationId, id]);
        await client.query("UPDATE enterprise.run_quarantine SET status='released', decided_by_member_id=$3, decided_at=now() WHERE organization_id=$1 AND run_id=$2",
          [principal.organizationId, id, principal.memberId]);
        await audit(client, principal.organizationId, principal.memberId, 'run.quarantine_released', 'run', id);
        await appendEnterpriseNotification(client, principal.organizationId, { recipientMemberId: held.requestedByMemberId, kind: 'run.quarantine_released', severity: 'info',
          subjectType: 'run', subjectId: id, message: '管理員已重新確認你的權限並放行先前被隔離的草稿結果。' });
        return { runId: id, status: 'released' };
      });
    },

    /** 丟棄：清除隔離內容（只留中繼資料與稽核），Run 標記失敗。 */
    async discardQuarantine(principal: EnterprisePrincipal, runId: unknown) {
      const id = requireUuid(runId);
      return asReleaser(principal, async client => {
        const held = await lockHeldQuarantine(client, principal.organizationId, id);
        await client.query("UPDATE enterprise.run_quarantine SET status='discarded', body=NULL, citations='[]', decided_by_member_id=$3, decided_at=now() WHERE organization_id=$1 AND run_id=$2",
          [principal.organizationId, id, principal.memberId]);
        await client.query("UPDATE enterprise.runs SET status='failed', finished_at=coalesce(finished_at, now()), updated_at=now() WHERE organization_id=$1 AND id=$2", [principal.organizationId, id]);
        await client.query("UPDATE enterprise.drafts SET status='failed', updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2", [principal.organizationId, held.draftId]);
        await audit(client, principal.organizationId, principal.memberId, 'run.quarantine_discarded', 'run', id);
        return { runId: id, status: 'discarded' };
      });
    },

    async listDrafts(principal: EnterprisePrincipal) {
      requirePermission(principal, 'documents.read');
      return asMember(pool, principal, async client => (await client.query(`SELECT ${draftColumns} FROM enterprise.drafts d WHERE d.organization_id=$1
        AND (d.author_member_id=$2 OR $3) ORDER BY d.updated_at DESC LIMIT 100`, [principal.organizationId, principal.memberId, principal.permissions.includes('approvals.decide')])).rows);
    },

    async getDraft(principal: EnterprisePrincipal, draftId: unknown) {
      requirePermission(principal, 'documents.read');
      const id = requireUuid(draftId);
      return asMember(pool, principal, async client => {
        const draft = await getDraftRow(client, principal.organizationId, id);
        if (!draft || (draft.authorMemberId !== principal.memberId && !principal.permissions.includes('approvals.decide'))) throw new Error('ENTERPRISE_NOT_FOUND');
        const revision = draft.currentRevision ? await getRevision(client, principal.organizationId, id, draft.currentRevision) : null;
        const approvals = (await client.query(`SELECT id, revision, revision_sha256 AS "revisionSha256", status, requested_by_member_id AS "requestedByMemberId", decided_by_member_id AS "decidedByMemberId",
          decision_comment AS "decisionComment", created_at AS "createdAt", decided_at AS "decidedAt" FROM enterprise.approvals WHERE organization_id=$1 AND draft_id=$2 ORDER BY created_at`,
        [principal.organizationId, id])).rows;
        return { draft, revision, approvals };
      });
    },

    /** 人工修改：只有作者、只在 draft/rejected 狀態；expectedRevision 樂觀鎖。新修訂保留舊引用清單。 */
    async reviseDraft(principal: EnterprisePrincipal, draftId: unknown, input: Record<string, unknown>) {
      requirePermission(principal, 'documents.write');
      const id = requireUuid(draftId);
      const body = requireText(input.body, 200000);
      const expected = Number(input.expectedRevision);
      return asMember(pool, principal, async client => {
        const draft = await getDraftRow(client, principal.organizationId, id, true);
        if (!draft || draft.authorMemberId !== principal.memberId) throw new Error('ENTERPRISE_NOT_FOUND');
        if (!['draft', 'rejected'].includes(draft.status)) throw new Error('ENTERPRISE_DRAFT_LOCKED');
        if (!Number.isInteger(expected) || expected !== draft.currentRevision) throw new Error('ENTERPRISE_VERSION_CONFLICT');
        await checkEnterpriseEntitlement(client, principal.organizationId, 'draft.revise');
        const previous = await getStoredRevision(client, principal.organizationId, id, draft.currentRevision);
        const next = draft.currentRevision + 1;
        // 人工修改沿用伺服器寫入的引用 metadata（使用者不能自帶 metadata），並重新檢查內文標記。
        await insertRevision(client, principal.organizationId, { draftId: id, revision: next, body, citations: previous?.citations ?? [], source: 'human', memberId: principal.memberId });
        await client.query("UPDATE enterprise.drafts SET current_revision=$3, status='draft', updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2",
          [principal.organizationId, id, next]);
        await audit(client, principal.organizationId, principal.memberId, 'draft.revised', 'draft', id);
        return getRevision(client, principal.organizationId, id, next);
      });
    },

    /**
     * 送審（ASTRA-V3-NEW-001）：必須帶 expectedRevision＝作者眼前的版號；鎖草稿列後比對，不符 409。
     * approval 綁定該修訂與內容 hash，之後的核准與匯出都以此為準。
     */
    async submitDraft(principal: EnterprisePrincipal, draftId: unknown, input: Record<string, unknown> = {}) {
      requirePermission(principal, 'documents.write');
      const id = requireUuid(draftId);
      return asMember(pool, principal, async client => {
        const draft = await getDraftRow(client, principal.organizationId, id, true);
        if (!draft || draft.authorMemberId !== principal.memberId) throw new Error('ENTERPRISE_NOT_FOUND');
        if (!['draft', 'rejected'].includes(draft.status) || draft.currentRevision < 1) throw new Error('ENTERPRISE_DRAFT_LOCKED');
        if (input.expectedRevision !== draft.currentRevision) throw new Error('ENTERPRISE_VERSION_CONFLICT');
        await checkEnterpriseEntitlement(client, principal.organizationId, 'draft.submit');
        const current = (await getStoredRevision(client, principal.organizationId, id, draft.currentRevision))!;
        await requireValidCitations(client, principal.organizationId, current.body, current.citations);
        const sha256 = revisionSha256(current);
        const approval = (await client.query<{ id: string }>(`INSERT INTO enterprise.approvals(organization_id,draft_id,revision,requested_by_member_id,revision_sha256)
          VALUES ($1,$2,$3,$4,$5) RETURNING id`, [principal.organizationId, id, draft.currentRevision, principal.memberId, sha256])).rows[0];
        await client.query("UPDATE enterprise.drafts SET status='submitted', updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2", [principal.organizationId, id]);
        await audit(client, principal.organizationId, principal.memberId, 'draft.submitted', 'draft', id);
        return { approvalId: approval.id, revision: draft.currentRevision, revisionSha256: sha256 };
      });
    },

    async listPendingApprovals(principal: EnterprisePrincipal) {
      requirePermission(principal, 'approvals.decide');
      return asMember(pool, principal, async client => (await client.query(`SELECT a.id, a.draft_id AS "draftId", a.revision, a.revision_sha256 AS "revisionSha256", d.title,
          a.requested_by_member_id AS "requestedByMemberId", a.created_at AS "createdAt"
        FROM enterprise.approvals a JOIN enterprise.drafts d ON (d.organization_id,d.id)=(a.organization_id,a.draft_id)
        WHERE a.organization_id=$1 AND a.status='pending' ORDER BY a.created_at`, [principal.organizationId])).rows);
    },

    /** 審批檢視（ASTRA-V3-NEW-001）：回傳 approval 綁定的修訂（不是 draft 目前修訂），含即時引用重驗與內容 hash。 */
    async getApproval(principal: EnterprisePrincipal, approvalId: unknown) {
      requirePermission(principal, 'approvals.decide');
      const id = requireUuid(approvalId);
      return asMember(pool, principal, async client => {
        const approval = (await client.query<{ id: string; draftId: string; revision: number; revisionSha256: string | null; status: string; requestedByMemberId: string; createdAt: Date }>(
          `SELECT id, draft_id AS "draftId", revision, revision_sha256 AS "revisionSha256", status, requested_by_member_id AS "requestedByMemberId", created_at AS "createdAt"
           FROM enterprise.approvals WHERE organization_id=$1 AND id=$2`, [principal.organizationId, id])).rows[0];
        if (!approval) throw new Error('ENTERPRISE_NOT_FOUND');
        const draft = (await getDraftRow(client, principal.organizationId, approval.draftId))!;
        const revision = (await getRevision(client, principal.organizationId, approval.draftId, approval.revision))!;
        const sha256 = revisionSha256(revision);
        return { approval: { ...approval, revisionSha256: approval.revisionSha256 ?? sha256 }, draft, revision, contentSha256: sha256 };
      });
    },

    /** 審批：需 approvals.decide、不能是送審者、只能決定一次（pending → approved/rejected）。 */
    async decideApproval(principal: EnterprisePrincipal, approvalId: unknown, input: Record<string, unknown>) {
      requirePermission(principal, 'approvals.decide');
      const id = requireUuid(approvalId);
      const decision = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : null;
      if (!decision) throw new Error('ENTERPRISE_INVALID_DECISION');
      const comment = input.comment === undefined || input.comment === null || input.comment === '' ? null : requireText(input.comment, 2000);
      return asMember(pool, principal, async client => {
        const target = (await client.query<{ draftId: string }>('SELECT draft_id AS "draftId" FROM enterprise.approvals WHERE organization_id=$1 AND id=$2',
          [principal.organizationId, id])).rows[0];
        if (!target) throw new Error('ENTERPRISE_NOT_FOUND');
        // 鎖順序 draft → approval（與送審一致）；鎖後重讀 approval。
        const draft = await getDraftRow(client, principal.organizationId, target.draftId, true);
        const approval = (await client.query<{ draftId: string; requestedBy: string; status: string; revision: number; revisionSha256: string | null }>(`SELECT draft_id AS "draftId",
            requested_by_member_id AS "requestedBy", status, revision, revision_sha256 AS "revisionSha256"
          FROM enterprise.approvals WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [principal.organizationId, id])).rows[0];
        if (!approval || !draft) throw new Error('ENTERPRISE_NOT_FOUND');
        if (approval.status !== 'pending') throw new Error('ENTERPRISE_APPROVAL_ALREADY_DECIDED');
        if (approval.requestedBy === principal.memberId) throw new Error('ENTERPRISE_SELF_APPROVAL_FORBIDDEN');
        // ASTRA-V3-NEW-001：待審必須仍是草稿目前的修訂（fail-closed），且審批者確認的是同一版號與內容 hash。
        if (draft.status !== 'submitted' || draft.currentRevision !== approval.revision) throw new Error('ENTERPRISE_APPROVAL_STALE');
        const revision = (await getStoredRevision(client, principal.organizationId, approval.draftId, approval.revision))!;
        const sha256 = revisionSha256(revision);
        if (approval.revisionSha256 !== null && approval.revisionSha256 !== sha256) throw new Error('ENTERPRISE_APPROVAL_STALE');
        requireConfirmedRevision(input, approval.revision, sha256);
        await checkEnterpriseEntitlement(client, principal.organizationId, 'approval.decide');
        if (decision === 'approved') {
          // ASTRA-007：核准當下重驗引用（送審後來源可能已漂移）；拒絕不受限。
          await requireValidCitations(client, principal.organizationId, revision.body, revision.citations);
        }
        await client.query(`UPDATE enterprise.approvals SET status=$3, decided_by_member_id=$4, decision_comment=$5, decided_at=now()
          WHERE organization_id=$1 AND id=$2 AND status='pending'`, [principal.organizationId, id, decision, principal.memberId, comment]);
        await client.query('UPDATE enterprise.drafts SET status=$3, updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2', [principal.organizationId, approval.draftId, decision]);
        await audit(client, principal.organizationId, principal.memberId, `draft.${decision}`, 'draft', approval.draftId);
        return { approvalId: id, status: decision, revision: approval.revision, revisionSha256: sha256 };
      });
    },

    /** 匯出：只限已核准草稿的核准修訂；檔案含引用附錄；記錄 SHA-256 於 draft_exports 與 audit。 */
    async exportDraft(principal: EnterprisePrincipal, draftId: unknown, format: unknown) {
      requirePermission(principal, 'documents.read');
      const id = requireUuid(draftId);
      if (format !== 'docx' && format !== 'markdown') throw new Error('ENTERPRISE_INVALID_FORMAT');
      return asMember(pool, principal, async client => {
        const draft = await getDraftRow(client, principal.organizationId, id);
        if (!draft || (draft.authorMemberId !== principal.memberId && !principal.permissions.includes('approvals.decide'))) throw new Error('ENTERPRISE_NOT_FOUND');
        if (draft.status !== 'approved') throw new Error('ENTERPRISE_DRAFT_NOT_APPROVED');
        const approved = (await client.query<{ id: string; revision: number; revisionSha256: string | null; decidedBy: string; decidedAt: Date }>(`SELECT id, revision,
            revision_sha256 AS "revisionSha256", decided_by_member_id AS "decidedBy", decided_at AS "decidedAt"
          FROM enterprise.approvals WHERE organization_id=$1 AND draft_id=$2 AND status='approved' ORDER BY decided_at DESC LIMIT 1`, [principal.organizationId, id])).rows[0];
        // ASTRA-V3-NEW-001：已核准狀態下草稿目前修訂必須就是核准的修訂，內容 hash 不變；否則拒絕（不猜測要匯出哪一版）。
        if (!approved || approved.revision !== draft.currentRevision) throw new Error('ENTERPRISE_APPROVAL_STALE');
        const revision = (await getStoredRevision(client, principal.organizationId, id, approved.revision))!;
        if (approved.revisionSha256 !== null && approved.revisionSha256 !== revisionSha256(revision)) throw new Error('ENTERPRISE_APPROVAL_STALE');
        // ASTRA-007：來源失效後不能沿用舊核准匯出。
        await requireValidCitations(client, principal.organizationId, revision.body, revision.citations);
        const citations = (revision.citations as Array<{ index: number; title: string; versionNumber: number; chunkId: string; excerptSha256: string }>)
          .map(item => `[${item.index}] ${item.title}（第 ${item.versionNumber} 版，片段 ${item.chunkId}，SHA-256 ${item.excerptSha256}）`);
        const lines = [draft.title, '', ...revision.body.split('\n'), '', '— 來源 —', ...citations, '', `核准：${approved.decidedBy}／${approved.decidedAt.toISOString()}；修訂 ${approved.revision}`];
        let content: Buffer;
        if (format === 'markdown') {
          content = Buffer.from(`# ${lines[0]}\n\n${lines.slice(2).join('\n')}\n`, 'utf8');
        } else {
          const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const zip = new JSZip();
          zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
          zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
          zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
            lines.map(line => `<w:p><w:r><w:t xml:space="preserve">${escape(line)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
          content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        }
        const sha256 = createHash('sha256').update(content).digest('hex');
        await client.query(`INSERT INTO enterprise.draft_exports(organization_id,draft_id,revision,format,sha256,byte_size,exported_by_member_id,approval_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [principal.organizationId, id, approved.revision, format, sha256, content.length, principal.memberId, approved.id]);
        await audit(client, principal.organizationId, principal.memberId, `draft.exported_${format}`, 'draft', id);
        return { content, sha256, approvalId: approved.id, revision: approved.revision, filename: `${draft.title}.${format === 'docx' ? 'docx' : 'md'}`,
          mediaType: format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown; charset=utf-8' };
      });
    },
  };
}

// ------------------------------------------------------------------ Worker

type ClaimedRun = { id: string; organizationId: string; requestedByMemberId: string; requesterAuthEpoch: number | null; input: { query: string; providerKey: string }; draftId: string; attempts: number; title: string };

/**
 * 供 server 入口（企業模式）啟動的 Run worker；tick() 亦供整合測試以確定性方式驅動。
 * 每個 Run：認領（SKIP LOCKED）→ 重驗申請者仍 active 且有權限 → 檢索來源（無來源不呼叫模型）→ 外送政策 → 預算 → 呼叫 provider（交易外）
 * → 新交易內再檢查取消與身分 → 寫入用量、草稿修訂、狀態。暫時性錯誤最多重試 3 次；執行超過 10 分鐘視為逾時。
 */
export function createEnterpriseRunWorker(pool: Pool, options: { secretKey?: string; fetchImpl?: Parameters<typeof generateWithProvider>[3] extends infer O ? O extends { fetchImpl?: infer F } ? F : never : never; timeoutMs?: number } = {}) {
  async function organizations() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('dhc.worker_enumerate','on',true)");
      const rows = (await client.query<{ id: string }>("SELECT id FROM enterprise.organizations WHERE status='active'")).rows;
      await client.query('COMMIT');
      return rows.map(row => row.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function finish(organizationId: string, run: ClaimedRun, status: 'failed' | 'cancelled' | 'queued', errorCode: string | null) {
    await inOrganization(pool, organizationId, async client => {
      // ASTRA-V3-NEW-002：只終結本 worker 這次 attempt 仍擁有的 Run；逾時清理後晚到的失敗不得把 Run 重新排入或改寫錯誤碼。
      const updated = (await client.query(`UPDATE enterprise.runs SET status=$3, error_code=$4, finished_at=CASE WHEN $3='queued' THEN NULL ELSE now() END, updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND status='running' AND attempts=$5`, [organizationId, run.id, status, errorCode, run.attempts])).rowCount;
      if (updated !== 1) {
        await audit(client, organizationId, run.requestedByMemberId, 'run.late_result_discarded', 'run', run.id);
        return;
      }
      if (status !== 'queued') await client.query("UPDATE enterprise.drafts SET status='failed', updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2", [organizationId, run.draftId]);
      await audit(client, organizationId, run.requestedByMemberId, `run.${status === 'queued' ? 'retry_scheduled' : status}`, 'run', run.id);
    });
  }

  async function processOne(organizationId: string) {
    const claimed = await inOrganization(pool, organizationId, async client => {
      // 逾時清理：running 超過上限的 Run 標記失敗
      const stale = (await client.query<{ id: string; draftId: string }>(`UPDATE enterprise.runs SET status='failed', error_code='ENTERPRISE_RUN_TIMEOUT', finished_at=now(), updated_at=now()
        WHERE organization_id=$1 AND status='running' AND started_at < now() - make_interval(mins => $2) RETURNING id, draft_id AS "draftId"`, [organizationId, RUN_TIMEOUT_MINUTES])).rows;
      for (const row of stale) await client.query("UPDATE enterprise.drafts SET status='failed', updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2", [organizationId, row.draftId]);
      // ASTRA-008：worker 中斷留下的 reserved（呼叫結果不明）→ unknown，預留持續計入預算，待對帳；不記成 0。
      await client.query(`UPDATE enterprise.model_usage SET status='unknown', error_code='ENTERPRISE_WORKER_INTERRUPTED', finished_at=now()
        WHERE organization_id=$1 AND status='reserved' AND created_at < now() - make_interval(mins => $2)`, [organizationId, RUN_TIMEOUT_MINUTES]);
      return (await client.query<ClaimedRun>(`UPDATE enterprise.runs r SET status='running', attempts=attempts+1, started_at=now(), updated_at=now()
        FROM enterprise.drafts d
        WHERE r.organization_id=$1 AND r.id = (SELECT id FROM enterprise.runs WHERE organization_id=$1 AND status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
          AND (d.organization_id,d.id)=(r.organization_id,r.draft_id)
        RETURNING r.id, r.organization_id AS "organizationId", r.requested_by_member_id AS "requestedByMemberId", r.requester_auth_epoch AS "requesterAuthEpoch",
          r.input, r.draft_id AS "draftId", r.attempts, d.title`,
      [organizationId])).rows[0];
    });
    if (!claimed) return false;

    const prepared = await inOrganization(pool, organizationId, async client => {
      // ASTRA-004：呼叫模型前，申請者必須仍 active、epoch 與建立 Run 時相同、且目前角色仍有 tasks.write；否則不呼叫模型。
      if (!stillAuthorized(await requesterState(client, organizationId, claimed.requestedByMemberId), claimed.requesterAuthEpoch)) return { error: 'ENTERPRISE_PRINCIPAL_REVOKED' } as const;
      // ASTRA-014：到期後佇列中的 Run 不執行、不呼叫模型（B-EXPIRY-INFLIGHT 未決前的保守預設）。
      try { await requireActiveSubscription(client, organizationId); } catch { return { error: 'ENTERPRISE_SUBSCRIPTION_INACTIVE' } as const; }
      const providerRow = (await client.query(`SELECT id, kind, base_url AS "baseUrl", model, deployment, api_key_ciphertext AS "sealed",
          input_price_micros_per_mtok::text AS "inputPriceMicrosPerMtok", output_price_micros_per_mtok::text AS "outputPriceMicrosPerMtok", monthly_budget_micros::text AS "budget",
          redirect_allowlist AS "redirectAllowlist", price_version AS "priceVersion", price_source AS "priceSource", price_effective_at AS "priceEffectiveAt"
        FROM enterprise.model_providers WHERE organization_id=$1 AND key=$2 AND enabled`, [organizationId, claimed.input.providerKey])).rows[0];
      if (!providerRow) return { error: 'ENTERPRISE_PROVIDER_NOT_FOUND' } as const;
      const repository = createScopedEnterpriseRepository(client, organizationId, claimed.requestedByMemberId);
      const terms = [...new Set(claimed.input.query.split(/\s+/).filter(Boolean))].slice(0, 8);
      const sources = await repository.searchChunks(terms, true, 8);
      if (sources.length === 0) return { error: 'ENTERPRISE_NO_SOURCES' } as const;
      const classifications = (await client.query<{ classification: string }>('SELECT DISTINCT classification FROM enterprise.documents WHERE organization_id=$1 AND id = ANY($2::uuid[])',
        [organizationId, sources.map(source => source.documentId)])).rows.map(row => row.classification);
      const provider = toProviderConfig(providerRow);
      try {
        decideEgress(provider, classifications);
      } catch (error) {
        const code = (error as Error).message;
        await client.query(`INSERT INTO enterprise.model_usage(organization_id,provider_id,run_id,member_id,status,error_code,run_attempt,model,cost_micros,usage_source)
          VALUES ($1,$2,$3,$4,'denied',$5,$6,$7,0,'none')`, [organizationId, provider.id, claimed.id, claimed.requestedByMemberId, code, claimed.attempts, provider.model]);
        if (code.startsWith('ENTERPRISE_EGRESS_')) {
          await audit(client, organizationId, claimed.requestedByMemberId, 'model.egress_denied', 'run', claimed.id);
          await notifyEgressDenied(client, organizationId, { runId: claimed.id, requesterMemberId: claimed.requestedByMemberId, code });
        }
        return { error: code } as const;
      }
      const system = '你是企業文書助理。只能依照提供的來源段落撰寫繁體中文草稿，每個陳述標註來源編號如 [1]；來源不足時明確寫出，不得杜撰。';
      const prompt = [`任務：${claimed.title}`, `需求：${claimed.input.query}`, '來源：', ...sources.map((source, index) => `[${index + 1}] ${source.text.replace(/\s+/g, ' ')}`)].join('\n');
      // ASTRA-008：在 provider 預算鎖下，以最壞情況（輸入 bytes 上界＋max_tokens）預留；預留列與檢查同一交易提交，
      // 並行 worker 會看見彼此的預留。供應商遵守 max_tokens 時，月支出不會超過預算（見 docs：預算保護強度）。
      await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [BUDGET_LOCK_CLASS, provider.id]);
      const reserve = costMicros(provider, tokenUpperBound(system, prompt), MAX_OUTPUT_TOKENS);
      const snapshot = [claimed.attempts, provider.model, providerRow.priceVersion, providerRow.priceSource, providerRow.priceEffectiveAt,
        provider.inputPriceMicrosPerMtok, provider.outputPriceMicrosPerMtok, reserve];
      if ((await monthlySpend(client, organizationId, provider.id)) + reserve > Number(providerRow.budget)) {
        await client.query(`INSERT INTO enterprise.model_usage(organization_id,provider_id,run_id,member_id,status,error_code,run_attempt,model,price_version,price_source,
            price_effective_at,input_price_micros_per_mtok,output_price_micros_per_mtok,reserved_micros,cost_micros,usage_source)
          VALUES ($1,$2,$3,$4,'denied','ENTERPRISE_BUDGET_EXCEEDED',$5,$6,$7,$8,$9,$10,$11,$12,0,'none')`, [organizationId, provider.id, claimed.id, claimed.requestedByMemberId, ...snapshot]);
        return { error: 'ENTERPRISE_BUDGET_EXCEEDED' } as const;
      }
      const usageId = (await client.query<{ id: string }>(`INSERT INTO enterprise.model_usage(organization_id,provider_id,run_id,member_id,status,run_attempt,model,price_version,
          price_source,price_effective_at,input_price_micros_per_mtok,output_price_micros_per_mtok,reserved_micros,cost_micros,reconciled_state)
        VALUES ($1,$2,$3,$4,'reserved',$5,$6,$7,$8,$9,$10,$11,$12,NULL,'pending_reconciliation') RETURNING id`,
      [organizationId, provider.id, claimed.id, claimed.requestedByMemberId, ...snapshot])).rows[0].id;
      const citations = sources.map((source, index) => ({ index: index + 1, chunkId: source.chunkId, documentId: source.documentId, documentVersionId: source.documentVersionId,
        versionNumber: source.versionNumber, title: source.title, location: source.location, excerptSha256: source.textSha256 }));
      return { provider, sealed: providerRow.sealed as string | null, system, prompt, citations, usageId };
    });
    if ('error' in prepared) {
      await finish(organizationId, claimed, 'failed', prepared.error ?? 'ENTERPRISE_RUN_FAILED');
      return true;
    }

    let result: Awaited<ReturnType<typeof generateWithProvider>>;
    try {
      const apiKey = prepared.sealed ? decryptProviderSecret(prepared.sealed, options.secretKey) : null;
      result = await generateWithProvider(prepared.provider, apiKey, { system: prepared.system, prompt: prepared.prompt, maxOutputTokens: MAX_OUTPUT_TOKENS },
        { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, maxAttempts: 1 });
    } catch (error) {
      const code = (error as Error).message.startsWith('ENTERPRISE_') ? (error as Error).message : 'ENTERPRISE_PROVIDER_UNREACHABLE';
      const egress = code.startsWith('ENTERPRISE_EGRESS_');
      await inOrganization(pool, organizationId, async client => {
        const unknown = UNKNOWN_USAGE.has(code);
        // ASTRA-V3-NEW-002：只有仍為 reserved（本 worker 擁有）時才終結；已被逾時清理／對帳的列不覆寫。
        await client.query(`UPDATE enterprise.model_usage SET status=$3, error_code=$4, cost_micros=$5, usage_source=$6, reconciled_state=$7, finished_at=now()
          WHERE organization_id=$1 AND id=$2 AND status='reserved'`, [organizationId, prepared.usageId, egress ? 'denied' : unknown ? 'unknown' : 'failed', code,
          unknown ? null : 0, unknown ? null : 'none', unknown ? 'pending_reconciliation' : 'final']);
        if (egress) {
          await audit(client, organizationId, claimed.requestedByMemberId, 'model.egress_denied', 'run', claimed.id);
          await notifyEgressDenied(client, organizationId, { runId: claimed.id, requesterMemberId: claimed.requestedByMemberId, code });
        }
      });
      await finish(organizationId, claimed, TRANSIENT.has(code) && claimed.attempts < MAX_ATTEMPTS ? 'queued' : 'failed', code);
      return true;
    }

    await inOrganization(pool, organizationId, async client => {
      // ASTRA-V3-NEW-002：先鎖 Run 並確認仍是本 worker 這次 attempt 擁有（running 且 attempts 相同）；
      // 逾時清理已把 Run 標成失敗時，晚到的結果只記稽核、不發布、不覆寫用量（用量列由清理轉為 unknown 待對帳）。
      const owned = (await client.query<{ cancel: boolean; status: string; attempts: number }>(
        'SELECT cancel_requested AS cancel, status, attempts FROM enterprise.runs WHERE organization_id=$1 AND id=$2 FOR UPDATE', [organizationId, claimed.id])).rows[0];
      // 以預留列上的價格快照計價（呼叫期間改價不影響這筆）；供應商沒回報用量 → 上界估算、待對帳。
      const cost = costMicros(prepared.provider, result.inputTokens, result.outputTokens);
      const settled = (await client.query(`UPDATE enterprise.model_usage SET status='succeeded', input_tokens=$3, output_tokens=$4, cost_micros=$5, usage_source=$6, reconciled_state=$7, finished_at=now()
        WHERE organization_id=$1 AND id=$2 AND status='reserved'`, [organizationId, prepared.usageId, result.inputTokens, result.outputTokens, cost, result.usageSource,
        result.usageSource === 'estimated' ? 'pending_reconciliation' : 'final'])).rowCount;
      if (!owned || owned.status !== 'running' || owned.attempts !== claimed.attempts || settled !== 1) {
        await audit(client, organizationId, claimed.requestedByMemberId, 'run.late_result_discarded', 'run', claimed.id);
        return;
      }
      const cancel = owned.cancel;
      if (cancel) {
        await client.query(`UPDATE enterprise.runs SET status='cancelled', finished_at=now(), updated_at=now() WHERE organization_id=$1 AND id=$2`, [organizationId, claimed.id]);
        await client.query("UPDATE enterprise.drafts SET status='failed', updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2", [organizationId, claimed.draftId]);
        await audit(client, organizationId, claimed.requestedByMemberId, 'run.cancelled', 'run', claimed.id);
        return;
      }
      // ASTRA-004 / DEC-RUN-01：提交結果的同一交易內重驗（成員列 FOR SHARE，與撤權交易序列化）；不符就隔離、不發布。
      const state = await requesterState(client, organizationId, claimed.requestedByMemberId);
      if (!stillAuthorized(state, claimed.requesterAuthEpoch)) {
        await client.query(`INSERT INTO enterprise.run_quarantine(organization_id,run_id,draft_id,reason_code,requester_auth_epoch,observed_auth_epoch,body,citations)
          VALUES ($1,$2,$3,'ENTERPRISE_PRINCIPAL_REVOKED',$4,$5,$6,$7)`, [organizationId, claimed.id, claimed.draftId, claimed.requesterAuthEpoch, state?.epoch ?? null,
          result.text.slice(0, 200000), JSON.stringify(prepared.citations)]);
        await client.query(`UPDATE enterprise.runs SET status='quarantined', error_code='ENTERPRISE_PRINCIPAL_REVOKED', finished_at=now(), updated_at=now()
          WHERE organization_id=$1 AND id=$2`, [organizationId, claimed.id]);
        await client.query("UPDATE enterprise.drafts SET status='quarantined', updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2", [organizationId, claimed.draftId]);
        await audit(client, organizationId, claimed.requestedByMemberId, 'run.quarantined', 'run', claimed.id);
        for (const audienceRole of ['approver', 'org_admin'] as const) {
          await appendEnterpriseNotification(client, organizationId, { audienceRole, kind: 'run.quarantined', severity: 'warning', subjectType: 'run', subjectId: claimed.id,
            code: 'ENTERPRISE_PRINCIPAL_REVOKED', message: '申請者在模型執行期間權限已變更，結果已隔離、未發布，需由管理員確認後放行或丟棄。' });
        }
        await appendEnterpriseNotification(client, organizationId, { recipientMemberId: claimed.requestedByMemberId, kind: 'run.quarantined', severity: 'warning', subjectType: 'run',
          subjectId: claimed.id, code: 'ENTERPRISE_PRINCIPAL_REVOKED',
          message: '你的權限在執行期間已變更，這次結果已被隔離。這是組織設定的硬邊界，需管理員重新授權後才能使用，請勿以其他方式取得或重送。' });
        return;
      }
      await insertRevision(client, organizationId, { draftId: claimed.draftId, revision: 1, body: result.text.slice(0, 200000), citations: prepared.citations, source: 'model', memberId: claimed.requestedByMemberId });
      await client.query("UPDATE enterprise.drafts SET status='draft', current_revision=1, updated_at=greatest(now(),created_at) WHERE organization_id=$1 AND id=$2", [organizationId, claimed.draftId]);
      await client.query("UPDATE enterprise.runs SET status='succeeded', finished_at=now(), updated_at=now() WHERE organization_id=$1 AND id=$2", [organizationId, claimed.id]);
      await audit(client, organizationId, claimed.requestedByMemberId, 'run.succeeded', 'run', claimed.id);
    });
    return true;
  }

  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  return {
    /** 每個組織最多處理一筆；回傳本輪處理的 Run 數。 */
    async tick() {
      let processed = 0;
      for (const organizationId of await organizations()) {
        if (await processOne(organizationId)) processed += 1;
      }
      return processed;
    },
    start(intervalMs = 1000) {
      timer = setInterval(() => {
        if (busy) return;
        busy = true;
        this.tick().catch(error => console.error('[enterprise-worker] tick failed:', error instanceof Error ? error.name : 'unknown'))
          .finally(() => { busy = false; });
      }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
