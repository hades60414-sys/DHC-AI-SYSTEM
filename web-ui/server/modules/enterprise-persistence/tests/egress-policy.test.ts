import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';

import { addressAllowed, authorizeRedirect, loadEgressNetworkPolicy, normalizeAddress, parseRedirectAllowlist } from '../egress-policy.js';
import { decideEgress, generateWithProvider, resetModelCircuitBreakers, type ModelProviderConfig } from '../model-gateway.js';

/**
 * ASTRA-002：模型外送在「實際連線邊界」遵守目的地政策。
 * 全部網路只在 loopback；公網位址只出現在注入的 DNS 解析結果中，從不實際連線。
 */
const MARKER = 'RCFIX_SYNTHETIC_RESTRICTED_MARKER';
const input = { system: 'synthetic only', prompt: MARKER, maxOutputTokens: 10 };
const policy = loadEgressNetworkPolicy({});
type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

let collected = '';
let lastAuthorization: string | undefined;
let redirectTarget: string | null = null;
let hits = 0;
const servers: http.Server[] = [];
const ports: Record<string, number> = {};

function listen(server: http.Server, host: string) {
  servers.push(server);
  return new Promise<number>(resolve => server.listen(0, host, () => resolve((server.address() as AddressInfo).port)));
}
const ok = (res: http.ServerResponse) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'synthetic result' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); };

before(async () => {
  ports.collector = await listen(http.createServer((req, res) => { hits += 1; lastAuthorization = req.headers.authorization; req.on('data', chunk => { collected += chunk; }); req.on('end', () => ok(res)); }), '::');
  for (const status of [301, 302, 303, 307, 308]) {
    ports[`r${status}`] = await listen(http.createServer((req, res) => {
      req.resume();
      res.writeHead(status, { location: redirectTarget ?? `http://[::ffff:127.0.0.1]:${ports.collector}/v1/chat/completions` });
      res.end();
    }), '127.0.0.1');
  }
});
after(async () => { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); });
beforeEach(() => { collected = ''; hits = 0; redirectTarget = null; resetModelCircuitBreakers(); });

const local = (baseUrl: string, extra: Partial<ModelProviderConfig> = {}): ModelProviderConfig => ({
  id: `p-${Math.random()}`, kind: 'openai_compatible', baseUrl, model: 'fake', deployment: 'LOCAL_ONLY', inputPriceMicrosPerMtok: 0, outputPriceMicrosPerMtok: 0, ...extra,
});

describe('ASTRA-002 redirect：預設拒絕，未核准的每一跳都收不到 prompt', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    test(`${status} → IPv4-mapped IPv6 collector：拒絕且 collector 未收到資料`, async () => {
      await assert.rejects(generateWithProvider(local(`http://127.0.0.1:${ports[`r${status}`]}/v1`), null, input), /ENTERPRISE_EGRESS_REDIRECT_DENIED/);
      assert.equal(hits, 0);
      assert.ok(!collected.includes(MARKER));
    });
  }

  test('redirect 拒絕不重試、不累計成暫時性錯誤', async () => {
    let calls = 0;
    const counting = http.createServer((req, res) => { calls += 1; req.resume(); res.writeHead(307, { location: 'http://127.0.0.1:9/x' }); res.end(); });
    const port = await listen(counting, '127.0.0.1');
    await assert.rejects(generateWithProvider(local(`http://127.0.0.1:${port}/v1`), null, input), /ENTERPRISE_EGRESS_REDIRECT_DENIED/);
    assert.equal(calls, 1);
  });

  test('管理員 allowlist 內的 307 目標（同屬 loopback）可跟隨，並重新驗證目的地', async () => {
    redirectTarget = `http://127.0.0.1:${ports.collector}/v1/chat/completions`;
    const provider = local(`http://127.0.0.1:${ports.r307}/v1`, { redirectAllowlist: [`127.0.0.1:${ports.collector}`] });
    const result = await generateWithProvider(provider, null, input);
    assert.equal(result.text, 'synthetic result');
    assert.equal(hits, 1);
  });

  test('OCR 審查：跟隨到不同 origin 時不轉送 API 金鑰；body 仍送出', async () => {
    redirectTarget = `http://127.0.0.1:${ports.collector}/v1/chat/completions`;
    const provider = local(`http://127.0.0.1:${ports.r307}/v1`, { redirectAllowlist: [`127.0.0.1:${ports.collector}`] });
    lastAuthorization = 'unset';
    await generateWithProvider(provider, 'sk-synthetic-should-not-leak', input);
    assert.equal(hits, 1);
    assert.equal(lastAuthorization, undefined, '跨 origin 不帶 Authorization');
    assert.ok(collected.includes(MARKER));
  });

  test('allowlist 內但違反網段政策的目標（LOCAL_ONLY → 公網）仍拒絕', async () => {
    const lookup: Lookup = async host => host === 'public.example.test' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
    const provider = local(`http://127.0.0.1:${ports.r307}/v1`, { redirectAllowlist: ['public.example.test:80'] });
    redirectTarget = 'http://public.example.test/v1/chat/completions';
    await assert.rejects(generateWithProvider(provider, null, input, { lookup }), /ENTERPRISE_EGRESS_DENIED/);
    assert.equal(hits, 0);
  });

  test('allowlist 內的 301/302/303 仍拒絕（會改變方法與 body 語義）', async () => {
    redirectTarget = `http://127.0.0.1:${ports.collector}/v1/chat/completions`;
    const provider = local(`http://127.0.0.1:${ports.r302}/v1`, { redirectAllowlist: [`127.0.0.1:${ports.collector}`] });
    await assert.rejects(generateWithProvider(provider, null, input), /ENTERPRISE_EGRESS_REDIRECT_DENIED/);
    assert.equal(hits, 0);
  });

  test('authorizeRedirect：https→http 降級、帶帳密、非 http(s)、未列 allowlist、缺 Location 都拒絕；相對路徑以目前 URL 解析', () => {
    const from = new URL('https://llm.internal:8443/v1/chat/completions');
    const allow = ['llm.internal:8443', 'llm2.internal:443', 'llm3.internal:80'];
    assert.equal(authorizeRedirect(from, '/v2/chat/completions', 307, allow).href, 'https://llm.internal:8443/v2/chat/completions');
    assert.equal(authorizeRedirect(from, 'https://llm2.internal/v1', 308, allow).host, 'llm2.internal');
    for (const [location, status] of [['http://llm3.internal/v1', 307], ['https://u:p@llm2.internal/v1', 307], ['file:///etc/passwd', 307], ['https://other.internal/v1', 307], [undefined, 307], ['/v2', 302]] as const) {
      assert.throws(() => authorizeRedirect(from, location, status, allow), /ENTERPRISE_EGRESS_REDIRECT_DENIED/, String(location));
    }
    assert.throws(() => authorizeRedirect(from, '/v2', 307, []), /ENTERPRISE_EGRESS_REDIRECT_DENIED/, '空 allowlist 連同源也拒絕');
  });
});

describe('ASTRA-002 DNS：所有解析位址都須符合政策，連線鎖定已驗證 IP', () => {
  const host = (name: string) => `http://${name}:${ports.collector}/v1`;

  test('單段主機名解析到公網：LOCAL_ONLY 拒絕', async () => {
    const lookup: Lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    await assert.rejects(generateWithProvider(local(host('ollama')), null, input, { lookup }), /ENTERPRISE_EGRESS_DENIED/);
    assert.equal(hits, 0);
  });

  test('公私混合 A／AAAA：任一位址違規即拒絕', async () => {
    const lookup: Lookup = async () => [{ address: '127.0.0.1', family: 4 }, { address: '2606:4700::1111', family: 6 }];
    await assert.rejects(generateWithProvider(local(host('llm.internal')), null, input, { lookup }), /ENTERPRISE_EGRESS_DENIED/);
    assert.equal(hits, 0);
  });

  test('IPv4-mapped IPv6 解析結果正規化後判斷：mapped 公網拒絕、mapped loopback 允許', async () => {
    await assert.rejects(generateWithProvider(local(host('llm.internal')), null, input, { lookup: async () => [{ address: '::ffff:8.8.8.8', family: 6 }] }), /ENTERPRISE_EGRESS_DENIED/);
    await assert.rejects(generateWithProvider(local(host('llm.internal')), null, input, { lookup: async () => [{ address: '::ffff:808:808', family: 6 }] }), /ENTERPRISE_EGRESS_DENIED/);
    const result = await generateWithProvider(local(host('llm.internal')), null, input, { lookup: async () => [{ address: '::ffff:127.0.0.1', family: 6 }] });
    assert.equal(result.text, 'synthetic result');
  });

  test('DNS rebinding：只解析一次並連到已驗證位址，第二次解析結果不被使用', async () => {
    let calls = 0;
    const lookup: Lookup = async () => { calls += 1; return calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '8.8.8.8', family: 4 }]; };
    const result = await generateWithProvider(local(host('rebind.internal')), null, input, { lookup });
    assert.equal(result.text, 'synthetic result');
    assert.equal(calls, 1);
    assert.ok(collected.includes(MARKER));
  });

  test('解析不到位址、或解析到 link-local（雲端 metadata）一律拒絕', async () => {
    await assert.rejects(generateWithProvider(local(host('empty.internal')), null, input, { lookup: async () => [] }), /ENTERPRISE_EGRESS_DENIED/);
    await assert.rejects(generateWithProvider(local(host('meta.internal')), null, input, { lookup: async () => [{ address: '169.254.169.254', family: 4 }] }), /ENTERPRISE_EGRESS_DENIED/);
  });

  test('CLOUD_ALLOWED：解析到私有／loopback／metadata 位址拒絕（防 SSRF）', async () => {
    const cloud = local('https://api.example.test/v1', { deployment: 'CLOUD_ALLOWED' });
    for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.5', '100.64.0.1']) {
      await assert.rejects(generateWithProvider(cloud, 'k', input, { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] }), /ENTERPRISE_EGRESS_DENIED/, address);
    }
  });

  test('核准的本機模型（loopback 字面 IP）仍正常運作，prompt 只到該端點', async () => {
    const result = await generateWithProvider(local(`http://127.0.0.1:${ports.collector}/v1`), null, input);
    assert.equal(result.text, 'synthetic result');
    assert.equal(hits, 1);
  });
});

describe('ASTRA-002 設定時政策', () => {
  test('URL 直接寫 IPv4-mapped IPv6 或 link-local：設定時就拒絕', () => {
    for (const url of ['http://[::ffff:127.0.0.1]:8080', 'http://[::ffff:7f00:1]', 'http://169.254.169.254', 'http://[fe80::1]', 'ftp://127.0.0.1']) {
      assert.throws(() => decideEgress(local(url), ['restricted']), /ENTERPRISE_EGRESS_DENIED/, url);
    }
  });

  test('位址正規化與網段判斷', () => {
    assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeAddress('::ffff:7f00:1'), '127.0.0.1');
    assert.equal(normalizeAddress('[::1]'), '::1');
    assert.ok(addressAllowed('LOCAL_ONLY', '192.168.1.5', policy));
    assert.ok(!addressAllowed('LOCAL_ONLY', '172.32.0.1', policy));
    assert.ok(!addressAllowed('CLOUD_ALLOWED', '192.168.1.5', policy));
    assert.ok(addressAllowed('CLOUD_ALLOWED', '93.184.216.34', policy));
    assert.ok(!addressAllowed('CLOUD_ALLOWED', '64:ff9b::a00:5', policy), 'NAT64 可內嵌私有位址');
  });

  test('部署網段政策可收窄，但不能把公網加入 LOCAL', () => {
    const narrowed = loadEgressNetworkPolicy({ ENTERPRISE_EGRESS_LOCAL_CIDRS: '10.20.0.0/16' });
    assert.ok(addressAllowed('LOCAL_ONLY', '10.20.1.1', narrowed));
    assert.ok(!addressAllowed('LOCAL_ONLY', '10.21.1.1', narrowed));
    assert.ok(!addressAllowed('LOCAL_ONLY', '127.0.0.1', narrowed));
    assert.throws(() => loadEgressNetworkPolicy({ ENTERPRISE_EGRESS_LOCAL_CIDRS: '8.8.8.0/24' }), /ENTERPRISE_EGRESS_POLICY_INVALID/);
    assert.throws(() => loadEgressNetworkPolicy({ ENTERPRISE_EGRESS_LOCAL_CIDRS: '0.0.0.0/0' }), /ENTERPRISE_EGRESS_POLICY_INVALID/);
  });

  test('redirect allowlist 只接受 host:port，正規化小寫、去重、最多 16 筆', () => {
    assert.deepEqual(parseRedirectAllowlist(['LLM.Internal:8443', 'llm.internal:8443', '10.0.0.5:80']), ['llm.internal:8443', '10.0.0.5:80']);
    for (const bad of [['http://x:1'], ['x'], ['x:0'], ['x:70000'], ['*.internal:80'], Array.from({ length: 17 }, (_, i) => `h${i}:80`)]) {
      assert.throws(() => parseRedirectAllowlist(bad), /ENTERPRISE_INVALID_PROVIDER/, JSON.stringify(bad));
    }
  });
});
