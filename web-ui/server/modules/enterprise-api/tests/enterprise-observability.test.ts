import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import express from 'express';
import type { Pool } from 'pg';

import { createEnterpriseMetrics, logEnterpriseEvent, setEnterpriseLogSink } from '@/modules/enterprise-api/enterprise-observability.js';
import { createEnterpriseRouter } from '@/modules/enterprise-api/enterprise.routes.js';
import { createLocalDocumentBlobStore } from '@/modules/enterprise-persistence/index.js';

const TOKEN = 'metrics-token-synthetic-0123456789';
const DOC_ID = '0b0e2f9c-6a8e-4f7e-9d61-3f0a9f6b7c11';
// 這些測試不會讀寫 blob；只需要一個合法的 storage adapter。
const blobStore = () => createLocalDocumentBlobStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'dhc-obs-')), 'blobs'));

describe('V5 企業 API 可觀測性（metrics 低基數、/metrics 存取控制、結構化日誌不含秘密）', () => {
  test('registry：標籤鍵固定、非法值改 invalid、序列上限後歸 overflow；histogram 累積桶', () => {
    const metrics = createEnterpriseMetrics();
    assert.throws(() => metrics.count('errors', { code: 'X', extra: 'y' }), /標籤鍵不符/);
    metrics.count('errors', { code: 'bad value with spaces' });
    for (let i = 0; i < 250; i += 1) metrics.count('results', { engine: 'ops_report', outcome: `o${i}` });
    metrics.observeRequest('/documents', 'GET', 401, 0.02);
    metrics.observeRequest('/documents', 'GET', 200, 3);
    const text = metrics.render([{ name: 'dhc_enterprise_db_pool_total', help: 'x', value: 4 }, { name: 'not valid', help: 'x', value: 1 }]);
    assert.match(text, /dhc_enterprise_errors_total\{code="invalid"\} 1/);
    assert.equal((text.match(/^dhc_enterprise_engine_results_total\{/gm) ?? []).length, 201, '200 個序列＋1 個 overflow');
    assert.match(text, /dhc_enterprise_engine_results_total\{engine="overflow",outcome="overflow"\} 50/);
    assert.match(text, /dhc_enterprise_metric_series_overflow_total 50/);
    assert.match(text, /dhc_enterprise_http_request_duration_seconds_bucket\{route="\/documents",method="GET",le="0.025"\} 1/);
    assert.match(text, /dhc_enterprise_http_request_duration_seconds_bucket\{route="\/documents",method="GET",le="\+Inf"\} 2/);
    assert.match(text, /dhc_enterprise_http_requests_total\{route="\/documents",method="GET",status_class="4xx"\} 1/);
    assert.match(text, /^dhc_enterprise_db_pool_total 4$/m);
    assert.doesNotMatch(text, /not valid/);
  });

  test('結構化日誌：只輸出允許欄位；token／authorization／body 等一律丟棄；控制字元與長字串被清理', () => {
    const lines: string[] = [];
    const restore = setEnterpriseLogSink(line => lines.push(line));
    try {
      logEnterpriseEvent('t', { route: '/x\n/y', authorization: 'Bearer secret', token: 'dhcs1.secret', password: 'p', body: { a: 1 }, code: 'C'.repeat(300), status: 200 });
    } finally {
      restore();
    }
    const record = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(record).sort(), ['code', 'event', 'level', 'route', 'status', 'ts']);
    assert.equal(record.route, '/x /y');
    assert.equal(record.code.length, 120);
    assert.doesNotMatch(lines[0], /secret/);
  });

  describe('HTTP（假 pool，不連資料庫）', () => {
    const metrics = createEnterpriseMetrics();
    const logs: string[] = [];
    let restore: () => void;
    let server: http.Server;
    let base = '';
    const pool = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => { throw new Error('no db in this test'); }, totalCount: 3, idleCount: 2, waitingCount: 0 } as unknown as Pool;
    before(async () => {
      restore = setEnterpriseLogSink(line => logs.push(line));
      const app = express();
      app.use('/api/enterprise/v1', createEnterpriseRouter({ pool, blobStore: blobStore(), maxDocumentBytes: 1024, metrics, metricsToken: TOKEN, accessLog: true }));
      server = http.createServer(app);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/enterprise/v1`;
    });
    after(async () => {
      restore();
      await new Promise(resolve => server.close(resolve));
    });

    test('route 標籤是路由樣板（不含 UUID）；錯誤代碼計數；request id 沿用合格值、替換不合格值；日誌不含 token', async () => {
      assert.equal((await fetch(`${base}/health/ready`)).status, 200);
      assert.equal((await fetch(`${base}/documents`)).status, 401);
      const withBadToken = await fetch(`${base}/documents/${DOC_ID}`, { headers: { authorization: 'Bearer dhcs1.not-a-real-session-token', 'x-request-id': 'req-abcdef12' } });
      assert.deepEqual([withBadToken.status, withBadToken.headers.get('x-request-id')], [401, 'req-abcdef12']);
      const injected = await fetch(`${base}/health/ready`, { headers: { 'x-request-id': 'bad id\twith spaces' } });
      assert.match(injected.headers.get('x-request-id')!, /^[0-9a-f-]{36}$/);
      const scrape = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(scrape.status, 200);
      const text = await scrape.text();
      assert.match(text, /dhc_enterprise_http_requests_total\{route="\/health\/ready",method="GET",status_class="2xx"\} 2/);
      assert.match(text, /dhc_enterprise_http_requests_total\{route="\/documents\/:documentId",method="GET",status_class="4xx"\} 1/);
      assert.match(text, /dhc_enterprise_errors_total\{code="ENTERPRISE_AUTH_REQUIRED"\} 2/);
      assert.match(text, /^dhc_enterprise_db_pool_idle 2$/m);
      assert.doesNotMatch(text, new RegExp(DOC_ID));
      const access = logs.map(line => JSON.parse(line)).filter(record => record.event === 'enterprise.http_request');
      assert.ok(access.some(record => record.route === '/documents/:documentId' && record.status === 401 && record.request_id === 'req-abcdef12'));
      assert.doesNotMatch(logs.join('\n'), /dhcs1|Bearer|not-a-real-session-token/);
      assert.doesNotMatch(logs.join('\n'), new RegExp(DOC_ID), '日誌只記路由樣板，不記實際 id');
    });

    test('/metrics：未帶或錯誤 token → 404（與不存在路徑相同）；未設定 token 的部署永遠 404', async () => {
      assert.equal((await fetch(`${base}/metrics`)).status, 404);
      assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}x` } })).status, 404);
      const app = express();
      app.use('/api/enterprise/v1', createEnterpriseRouter({ pool, blobStore: blobStore(), maxDocumentBytes: 1024, metrics }));
      const other = http.createServer(app);
      await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
      try {
        const response = await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/api/enterprise/v1/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
        assert.equal(response.status, 404);
      } finally {
        await new Promise(resolve => other.close(resolve));
      }
    });
  });
});
