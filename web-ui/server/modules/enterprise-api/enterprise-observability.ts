import { randomUUID, timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

/**
 * V5 企業 API 可觀測性（無外部依賴）。
 * - Metrics：Prometheus 文字格式；標籤鍵在定義時固定、值只能是路由樣板／狀態類別／錯誤代碼等有限集合，
 *   每個 metric 最多 MAX_SERIES 個序列（超過歸入 overflow 序列並計數），不使用組織、成員、文件 id 或原始 URL 當標籤。
 * - 結構化日誌：一行一個 JSON（stderr）；只輸出允許清單內的欄位與基本型別值，字串截斷；不輸出標頭、body、token、query。
 */
const MAX_SERIES = 200;
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LABEL_VALUE = /^[A-Za-z0-9_:/.{}-]{1,96}$/;

type Labels = Record<string, string>;
type Series = { labels: Labels; value: number; buckets?: number[]; sum?: number };
type Metric = { name: string; help: string; type: 'counter' | 'histogram' | 'gauge'; labelKeys: string[]; series: Map<string, Series>; overflow: number };

export function createEnterpriseMetrics() {
  const metrics = new Map<string, Metric>();

  function define(name: string, help: string, type: Metric['type'], labelKeys: string[]) {
    if (!metrics.has(name)) metrics.set(name, { name, help, type, labelKeys, series: new Map(), overflow: 0 });
    return metrics.get(name)!;
  }
  function seriesOf(metric: Metric, labels: Labels) {
    const keys = Object.keys(labels).sort();
    if (keys.join(',') !== [...metric.labelKeys].sort().join(',')) throw new Error(`metric ${metric.name} 標籤鍵不符`);
    const clean = Object.fromEntries(metric.labelKeys.map(key => [key, LABEL_VALUE.test(labels[key]) ? labels[key] : 'invalid']));
    const id = metric.labelKeys.map(key => clean[key]).join('\u0000');
    let series = metric.series.get(id);
    if (!series) {
      if (metric.series.size >= MAX_SERIES) {
        metric.overflow += 1;
        const overflowLabels = Object.fromEntries(metric.labelKeys.map(key => [key, 'overflow']));
        const overflowId = metric.labelKeys.map(() => 'overflow').join('\u0000');
        series = metric.series.get(overflowId) ?? { labels: overflowLabels, value: 0, ...(metric.type === 'histogram' ? { buckets: DURATION_BUCKETS.map(() => 0), sum: 0 } : {}) };
        metric.series.set(overflowId, series);
        return series;
      }
      series = { labels: clean, value: 0, ...(metric.type === 'histogram' ? { buckets: DURATION_BUCKETS.map(() => 0), sum: 0 } : {}) };
      metric.series.set(id, series);
    }
    return series;
  }

  const httpRequests = define('dhc_enterprise_http_requests_total', '企業 API 請求數（route＝路由樣板）', 'counter', ['route', 'method', 'status_class']);
  const httpDuration = define('dhc_enterprise_http_request_duration_seconds', '企業 API 請求耗時', 'histogram', ['route', 'method']);
  const errors = define('dhc_enterprise_errors_total', '企業 API 錯誤代碼（ENTERPRISE_*）', 'counter', ['code']);
  const results = define('dhc_enterprise_engine_results_total', '確定性引擎結果（ops_report／reconciliation／reconciliation_export）', 'counter', ['engine', 'outcome']);
  const engineDuration = define('dhc_enterprise_engine_duration_seconds', '確定性引擎計算耗時（不含 DB）', 'histogram', ['engine']);

  return {
    count(metric: 'errors' | 'results', labels: Labels) {
      seriesOf(metric === 'errors' ? errors : results, labels).value += 1;
    },
    observeRequest(route: string, method: string, status: number, seconds: number) {
      seriesOf(httpRequests, { route, method, status_class: `${Math.floor(status / 100)}xx` }).value += 1;
      observe(seriesOf(httpDuration, { route, method }), seconds);
    },
    observeEngine(engine: string, seconds: number) {
      observe(seriesOf(engineDuration, { engine }), seconds);
    },
    /** gauges：擷取當下取樣的值（例如 pg Pool 連線數）；名稱須為 dhc_ 開頭、值須為有限數字。 */
    render(gauges: Array<{ name: string; help: string; value: number }> = []) {
      const lines: string[] = [];
      const labelText = (labels: Labels, extra: Labels = {}) => {
        const all = { ...labels, ...extra };
        const keys = Object.keys(all);
        return keys.length ? `{${keys.map(key => `${key}="${all[key].replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}` : '';
      };
      for (const metric of metrics.values()) {
        lines.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`);
        for (const series of metric.series.values()) {
          if (metric.type === 'histogram') {
            let cumulative = 0;
            DURATION_BUCKETS.forEach((bound, index) => {
              cumulative += series.buckets![index];
              lines.push(`${metric.name}_bucket${labelText(series.labels, { le: String(bound) })} ${cumulative}`);
            });
            lines.push(`${metric.name}_bucket${labelText(series.labels, { le: '+Inf' })} ${series.value}`);
            lines.push(`${metric.name}_sum${labelText(series.labels)} ${series.sum}`, `${metric.name}_count${labelText(series.labels)} ${series.value}`);
          } else {
            lines.push(`${metric.name}${labelText(series.labels)} ${series.value}`);
          }
        }
      }
      lines.push('# HELP dhc_enterprise_metric_series_overflow_total 因超過序列上限而歸入 overflow 的次數', '# TYPE dhc_enterprise_metric_series_overflow_total counter');
      lines.push(`dhc_enterprise_metric_series_overflow_total ${[...metrics.values()].reduce((total, metric) => total + metric.overflow, 0)}`);
      for (const gauge of gauges) {
        if (!/^dhc_[a-z_]+$/.test(gauge.name) || !Number.isFinite(gauge.value)) continue;
        lines.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`, `${gauge.name} ${gauge.value}`);
      }
      return `${lines.join('\n')}\n`;
    },
  };
}

function observe(series: Series, seconds: number) {
  series.value += 1;
  series.sum! += seconds;
  const index = DURATION_BUCKETS.findIndex(bound => seconds <= bound);
  if (index >= 0) series.buckets![index] += 1;
}

export type EnterpriseMetrics = ReturnType<typeof createEnterpriseMetrics>;
/** 行程內預設 registry（路由未指定時使用）。 */
export const defaultEnterpriseMetrics = createEnterpriseMetrics();

const LOG_FIELDS = new Set(['event', 'level', 'request_id', 'route', 'method', 'status', 'duration_ms', 'code', 'error_name', 'sqlstate', 'constraint', 'table', 'engine', 'outcome', 'format']);
export type LogSink = (line: string) => void;
let logSink: LogSink = line => process.stderr.write(`${line}\n`);
/** 測試用：替換輸出目的地，回傳還原函式。 */
export function setEnterpriseLogSink(sink: LogSink) {
  const previous = logSink;
  logSink = sink;
  return () => { logSink = previous; };
}

/** 結構化日誌：只保留允許清單欄位；值限字串（截斷 120 字、去控制字元）、有限數字、布林。 */
export function logEnterpriseEvent(event: string, fields: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info') {
  const record: Record<string, string | number | boolean> = { ts: new Date().toISOString(), level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (!LOG_FIELDS.has(key)) continue;
    if (typeof value === 'string') record[key] = value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
    else if (typeof value === 'number' && Number.isFinite(value)) record[key] = value;
    else if (typeof value === 'boolean') record[key] = value;
  }
  logSink(JSON.stringify(record));
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * 每個請求：沿用合格的 X-Request-Id 或產生新的並回傳；結束時記錄 route 樣板、狀態與耗時（metrics＋一行 access log）。
 * route 只取 Express 比對到的樣板（例：/documents/:documentId），沒比對到記為 unmatched；不記原始 URL 與 query。
 */
export function enterpriseRequestObserver(metrics: EnterpriseMetrics, options: { accessLog?: boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    const inbound = req.headers['x-request-id'];
    const requestId = typeof inbound === 'string' && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.locals.requestId = requestId;
    res.locals.enterpriseMetrics = metrics;
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? req.method : 'OTHER';
      metrics.observeRequest(route, method, res.statusCode, seconds);
      if (options.accessLog) logEnterpriseEvent('enterprise.http_request', { request_id: requestId, route, method, status: res.statusCode, duration_ms: Math.round(seconds * 1000) });
    });
    next();
  };
}

/** /metrics 存取：只有設定 DHC_METRICS_TOKEN 時開放；Bearer 以常數時間比較。未設定或不符一律 404（不揭露端點存在）。 */
export function metricsAuthorized(req: Request, token: string | undefined) {
  if (!token || token.length < 24) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
