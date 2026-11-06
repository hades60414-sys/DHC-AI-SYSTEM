import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, test } from 'node:test';

import {
  costMicros, decideEgress, decryptProviderSecret, encryptProviderSecret, generateWithProvider, resetModelCircuitBreakers, tokenUpperBound,
  type ModelProviderConfig,
} from '../model-gateway.js';

const KEY = randomBytes(32).toString('base64');
const base: ModelProviderConfig = { id: 'p1', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:9', model: 'm', deployment: 'LOCAL_ONLY', inputPriceMicrosPerMtok: 3_000_000, outputPriceMicrosPerMtok: 15_000_000 };
const input = { system: 's', prompt: '[1] 合成段落一\n[2] 合成段落二', maxOutputTokens: 100 };
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => resetModelCircuitBreakers());

describe('BYOK 加密', () => {
  test('可解密；密文竄改或換金鑰失敗；未設定主金鑰拒絕', () => {
    const sealed = encryptProviderSecret('sk-synthetic-123', KEY);
    assert.match(sealed, /^v1\./);
    assert.ok(!sealed.includes('synthetic'));
    assert.equal(decryptProviderSecret(sealed, KEY), 'sk-synthetic-123');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => decryptProviderSecret(parts.join('.'), KEY), /ENTERPRISE_SECRET_UNREADABLE/);
    assert.throws(() => decryptProviderSecret(sealed, randomBytes(32).toString('base64')), /ENTERPRISE_SECRET_UNREADABLE/);
    assert.throws(() => encryptProviderSecret('x', undefined), /ENTERPRISE_SECRET_KEY_UNCONFIGURED/);
  });
});

describe('外送政策與成本', () => {
  test('雲端 provider 只能處理 public/internal；LOCAL_ONLY 必須是客戶內部主機', () => {
    const cloud = { ...base, deployment: 'CLOUD_ALLOWED' as const, baseUrl: 'https://api.example.com/v1' };
    assert.doesNotThrow(() => decideEgress(cloud, ['internal', 'public']));
    assert.throws(() => decideEgress(cloud, ['internal', 'confidential']), /ENTERPRISE_EGRESS_DENIED/);
    for (const url of ['http://127.0.0.1:8080', 'http://10.1.2.3', 'http://192.168.1.5', 'http://ollama:11434', 'http://llm.internal']) {
      assert.doesNotThrow(() => decideEgress({ ...base, baseUrl: url }, ['restricted']), url);
    }
    for (const url of ['https://api.openai.com/v1', 'http://8.8.8.8', 'http://172.32.0.1']) {
      assert.throws(() => decideEgress({ ...base, baseUrl: url }, ['internal']), /ENTERPRISE_EGRESS_DENIED/, url);
    }
  });
  test('成本以整數 micro-USD 計算並無條件進位', () => {
    assert.equal(costMicros(base, 1000, 500), 3000 + 7500);
    assert.equal(costMicros({ ...base, inputPriceMicrosPerMtok: 1, outputPriceMicrosPerMtok: 0 }, 1, 0), 1);
  });
});

describe('generateWithProvider', () => {
  test('mock：離線、確定性、標示未使用模型', async () => {
    const a = await generateWithProvider({ ...base, kind: 'mock' }, null, input);
    const b = await generateWithProvider({ ...base, kind: 'mock' }, null, input);
    assert.deepEqual(a, b);
    assert.match(a.text, /未使用語言模型/);
    assert.match(a.text, /合成段落一 \[1\]/);
  });
  test('OpenAI-compatible：送出正確格式並讀取 usage', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const result = await generateWithProvider(base, 'key-1', input, { fetchImpl: async (url, init) => {
      seen = { url, headers: init.headers, body: init.body };
      return json(200, { choices: [{ message: { content: '草稿' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
    } });
    assert.deepEqual(result, { text: '草稿', inputTokens: 10, outputTokens: 4, usageSource: 'provider_reported' });
    assert.equal(seen!.url, 'http://127.0.0.1:9/chat/completions');
    assert.equal(seen!.headers.authorization, 'Bearer key-1');
    assert.equal(JSON.parse(seen!.body).max_tokens, 100);
  });
  test('Anthropic：需要金鑰、使用 messages API 格式', async () => {
    const provider = { ...base, kind: 'anthropic' as const, baseUrl: 'http://127.0.0.1:9' };
    await assert.rejects(generateWithProvider(provider, null, input, { fetchImpl: async () => json(200, {}) }), /ENTERPRISE_PROVIDER_MISCONFIGURED/);
    let headers: Record<string, string> = {};
    const result = await generateWithProvider(provider, 'k', input, { fetchImpl: async (_url, init) => {
      headers = init.headers;
      return json(200, { content: [{ type: 'text', text: '回覆' }], usage: { input_tokens: 7, output_tokens: 3 } });
    } });
    assert.equal(headers['x-api-key'], 'k');
    assert.deepEqual(result, { text: '回覆', inputTokens: 7, outputTokens: 3, usageSource: 'provider_reported' });
  });
  test('暫時性錯誤重試一次；4xx 不重試；錯誤不帶 provider 內容', async () => {
    let calls = 0;
    const flaky = await generateWithProvider(base, null, input, { fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? json(503, { error: 'secret detail' }) : json(200, { choices: [{ message: { content: 'ok' } }] });
    } });
    assert.equal(flaky.text, 'ok');
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(generateWithProvider({ ...base, id: 'p2' }, null, input, { fetchImpl: async () => { calls += 1; return json(401, { error: 'secret detail' }); } }),
      (error: Error) => error.message === 'ENTERPRISE_PROVIDER_REJECTED');
    assert.equal(calls, 1);
  });
  test('逾時與 circuit breaker：連續 3 次失敗後開路，不再呼叫', async () => {
    let calls = 0;
    const hang = async (_url: string, init: { signal: AbortSignal }) => {
      calls += 1;
      return new Promise<never>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    };
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(generateWithProvider({ ...base, id: 'p3' }, null, input, { fetchImpl: hang as never, timeoutMs: 20 }), /ENTERPRISE_PROVIDER_TIMEOUT/);
    }
    const before = calls;
    await assert.rejects(generateWithProvider({ ...base, id: 'p3' }, null, input, { fetchImpl: hang as never, timeoutMs: 20 }), /ENTERPRISE_PROVIDER_CIRCUIT_OPEN/);
    assert.equal(calls, before);
  });
});

describe('ASTRA-008 用量來源與 attempt', () => {
  test('供應商沒回報用量：不記 0，改用 UTF-8 bytes 上界並標 estimated（OpenAI 與 Anthropic）', async () => {
    const openai = await generateWithProvider({ ...base, id: 'u1' }, null, input, { fetchImpl: async () => json(200, { choices: [{ message: { content: '中文草稿' } }] }) });
    assert.equal(openai.usageSource, 'estimated');
    assert.equal(openai.inputTokens, tokenUpperBound(input.system, input.prompt));
    assert.ok(openai.outputTokens > 0 && openai.outputTokens <= input.maxOutputTokens);
    const anthropic = await generateWithProvider({ ...base, id: 'u2', kind: 'anthropic' }, 'k', input, { fetchImpl: async () => json(200, { content: [{ type: 'text', text: '回覆' }] }) });
    assert.equal(anthropic.usageSource, 'estimated');
    assert.ok(anthropic.inputTokens > 0);
    const partial = await generateWithProvider({ ...base, id: 'u3' }, null, input, { fetchImpl: async () => json(200, { choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 5 } }) });
    assert.equal(partial.usageSource, 'estimated', '只回報一半也視為未回報');
  });

  test('tokenUpperBound：中文每字 3 bytes，上界不小於字元數', () => {
    assert.equal(tokenUpperBound('合成'), 6 + 32);
    assert.ok(tokenUpperBound('a'.repeat(100)) >= 100);
  });

  test('maxAttempts: 1：暫時性錯誤不在 gateway 內重試（由 worker 逐筆記帳後重試）', async () => {
    let calls = 0;
    await assert.rejects(generateWithProvider({ ...base, id: 'u4' }, null, input, { maxAttempts: 1, fetchImpl: async () => { calls += 1; return json(503, {}); } }), /ENTERPRISE_PROVIDER_HTTP_ERROR/);
    assert.equal(calls, 1);
  });

  test('實際連線：送出前連不上＝UNREACHABLE；送出後被切斷＝CONNECTION_LOST（可能已計費）', async () => {
    const dropper = http.createServer((req, res) => { req.on('data', () => undefined); req.on('end', () => { res.socket?.destroy(); }); });
    await new Promise<void>(resolve => dropper.listen(0, '127.0.0.1', resolve));
    try {
      const port = (dropper.address() as AddressInfo).port;
      await assert.rejects(generateWithProvider({ ...base, id: 'u5', baseUrl: `http://127.0.0.1:${port}/v1` }, null, input, { maxAttempts: 1 }), /ENTERPRISE_PROVIDER_CONNECTION_LOST/);
    } finally {
      await new Promise(resolve => dropper.close(resolve));
    }
    await assert.rejects(generateWithProvider({ ...base, id: 'u6', baseUrl: 'http://127.0.0.1:9/v1' }, null, input, { maxAttempts: 1 }), /ENTERPRISE_PROVIDER_UNREACHABLE/);
  });
});
