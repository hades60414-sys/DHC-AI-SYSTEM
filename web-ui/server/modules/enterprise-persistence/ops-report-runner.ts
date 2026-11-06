import { createHash } from 'node:crypto';

import type { EnterpriseDocumentBlobStore } from '@/shared/index.js';

import { createOpsReportAccumulator, type OpsReportResult } from './ops-report-v1.js';

/** prepareOpsReport 回傳的計算計畫：不含任何 bytes，只含已驗證的版本 id、hash 與大小。 */
export type OpsReportPlan = {
  organizationId: string; week: string; periodStart: string; periodEnd: string; datasets: string[]; inputKey: string;
  versions: Array<{ id: string; sha256: string; byteSize: number }>;
};

/**
 * V5.1 第二階段（交易外）：依序讀取每個來源 blob、重驗 hash、交給累積器解析後立即釋放（同一時間只持有一份來源 Buffer）。
 * 在每個來源之間檢查 AbortSignal（用戶端斷線即停止，不寫入）；累積器一旦拒收就不再讀後續來源（快速拒絕）。
 * onEngine 只量引擎純計算時間（不含讀檔）。
 */
export async function computeOpsReportFromStore(store: EnterpriseDocumentBlobStore, plan: OpsReportPlan,
  options: { signal?: AbortSignal; onEngine?: (seconds: number) => void } = {}): Promise<OpsReportResult> {
  const accumulator = createOpsReportAccumulator({ week: plan.week, datasets: plan.datasets, sourceCount: plan.versions.length });
  let engineNs = 0n;
  for (const version of plan.versions) {
    if (options.signal?.aborted) throw new Error('ENTERPRISE_REQUEST_ABORTED');
    if (accumulator.failed) break;
    const content = await store.get(plan.organizationId, version.sha256);
    if (content.length !== version.byteSize || createHash('sha256').update(content).digest('hex') !== version.sha256) throw new Error('ENTERPRISE_BLOB_INTEGRITY');
    const started = process.hrtime.bigint();
    accumulator.add({ content, versionId: version.id, sha256: version.sha256 });
    engineNs += process.hrtime.bigint() - started;
  }
  if (options.signal?.aborted) throw new Error('ENTERPRISE_REQUEST_ABORTED');
  const started = process.hrtime.bigint();
  const result = accumulator.finish();
  engineNs += process.hrtime.bigint() - started;
  options.onEngine?.(Number(engineNs) / 1e9);
  return result;
}

/** 行程內的計算併發閘門：同時最多 limit 個計算、最多 queue 個等待；滿了立即 ENTERPRISE_RATE_LIMITED（429）。 */
export function createComputeGate(limit: number, queue: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async acquire() {
      if (active < limit) { active += 1; return release; }
      if (waiting.length >= queue) throw new Error('ENTERPRISE_RATE_LIMITED');
      await new Promise<void>(resolve => waiting.push(resolve));
      active += 1;
      return release;
    },
    get stats() { return { active, waiting: waiting.length, limit, queue }; },
  };
  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}
