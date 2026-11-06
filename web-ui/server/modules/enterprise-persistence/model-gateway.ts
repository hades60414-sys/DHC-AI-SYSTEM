import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  authorizeRedirect, defaultEgressNetworkPolicy, pinnedRequest, resolveDestination, staticDestinationAllowed,
  type EgressNetworkPolicy, type Lookup,
} from './egress-policy.js';

import type { ModelProviderConfig } from '@/shared/index.js';

/** 型別定義在 server/shared/types.ts；在此重新匯出維持既有匯入點。 */
export type { ModelProviderConfig };
type GenerateInput = { system: string; prompt: string; maxOutputTokens: number };
/** usageSource：provider_reported＝供應商回報；estimated＝供應商沒回報，以 UTF-8 bytes 上界估算（需對帳）；none＝mock 不計費。 */
type GenerateResult = { text: string; inputTokens: number; outputTokens: number; usageSource: 'provider_reported' | 'estimated' | 'none' };
/** 只供測試注入；正式路徑一律走 DNS 驗證＋鎖定位址的 pinnedRequest。注入時仍強制 redirect: 'manual' 並逐跳檢查。 */
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect?: 'manual' }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null };
}>;
type SendOptions = { fetchImpl?: FetchLike; lookup?: Lookup; policy?: EgressNetworkPolicy };
const MAX_REDIRECT_HOPS = 3;

// ------------------------------------------------------------------ BYOK

function masterKey(encoded: string | undefined) {
  const key = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('ENTERPRISE_SECRET_KEY_UNCONFIGURED');
  return key;
}

/** 供同模組 workflow service 使用：AES-256-GCM 加密 BYOK 金鑰，格式 `v1.<iv>.<tag>.<ciphertext>`（base64url）。 */
export function encryptProviderSecret(plaintext: string, encodedMasterKey: string | undefined) {
  if (typeof plaintext !== 'string' || !plaintext || plaintext.length > 1000) throw new Error('ENTERPRISE_INVALID_SECRET');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(encodedMasterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** 供同模組 workflow service 使用：解密失敗（金鑰錯、密文被改）丟 ENTERPRISE_SECRET_UNREADABLE。 */
export function decryptProviderSecret(sealed: string, encodedMasterKey: string | undefined) {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('ENTERPRISE_SECRET_UNREADABLE');
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey(encodedMasterKey), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if ((error as Error).message === 'ENTERPRISE_SECRET_KEY_UNCONFIGURED') throw error;
    throw new Error('ENTERPRISE_SECRET_UNREADABLE');
  }
}

// ------------------------------------------------------------------ 政策

const CLOUD_ALLOWED_CLASSIFICATIONS = new Set(['public', 'internal']);

/**
 * 供同模組 workflow service 使用：資料外送決策（預設拒絕）。
 * - CLOUD_ALLOWED provider：引用到的每份文件分級都必須是 public/internal，否則 ENTERPRISE_EGRESS_DENIED。
 * - LOCAL_ONLY provider：base_url 必須是部署網段政策內的 IP，或 localhost／單段主機名／.internal／.local（實際連線時再以 DNS 結果驗證）。
 * - IPv4-mapped IPv6 字面值、link-local（含雲端 metadata）、非 http(s)、帶帳密的 URL 一律拒絕。
 * 這是設定與排程前的靜態檢查；真正的硬邊界在 generateWithProvider 的每一跳連線（egress-policy.ts）。
 */
export function decideEgress(provider: ModelProviderConfig, classifications: string[], policy: EgressNetworkPolicy = defaultEgressNetworkPolicy()) {
  if (provider.kind === 'mock') return;
  if (provider.deployment === 'CLOUD_ALLOWED') {
    if (classifications.some(value => !CLOUD_ALLOWED_CLASSIFICATIONS.has(value))) throw new Error('ENTERPRISE_EGRESS_DENIED');
    if (provider.baseUrl && !staticAllowed(provider.deployment, provider.baseUrl, policy)) throw new Error('ENTERPRISE_EGRESS_DENIED');
    return;
  }
  if (!provider.baseUrl || !staticAllowed(provider.deployment, provider.baseUrl, policy)) throw new Error('ENTERPRISE_EGRESS_DENIED');
}

function staticAllowed(deployment: ModelProviderConfig['deployment'], baseUrl: string, policy: EgressNetworkPolicy) {
  try { return staticDestinationAllowed(deployment, new URL(baseUrl), policy); } catch { return false; }
}

/** 供同模組 workflow service 使用：依 provider 價格快照計算成本（micro-USD，整數，無浮點誤差）。 */
export function costMicros(provider: ModelProviderConfig, inputTokens: number, outputTokens: number) {
  return Math.ceil((inputTokens * provider.inputPriceMicrosPerMtok + outputTokens * provider.outputPriceMicrosPerMtok) / 1_000_000);
}

/** 呼叫前的粗估：輸入約每 2 字元 1 token（只用於顯示與 mock）。預算請用 tokenUpperBound。 */
export function estimateTokens(text: string) {
  return Math.ceil(text.length / 2);
}

/**
 * ASTRA-008：token 數上界。位元組層級 BPE（OpenAI／Anthropic 等）每個 token 至少 1 byte，故 tokens ≤ UTF-8 bytes；
 * 另加每則訊息 32 tokens 的格式開銷。用於預算預留與「供應商未回報用量」時的保守成本。
 */
export function tokenUpperBound(...texts: string[]) {
  return texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8') + 32, 0);
}

// ------------------------------------------------------------------ 呼叫

const breakers = new Map<string, { failures: number; openUntil: number }>();
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 60_000;

/** 只供測試重設 circuit breaker 狀態。 */
export function resetModelCircuitBreakers() {
  breakers.clear();
}

function mockGenerate(input: GenerateInput): GenerateResult {
  // 確定性、離線：只整理提示中的來源段落，明確標示為未經模型的合成草稿。
  const sources = [...input.prompt.matchAll(/^\[(\d+)\] (.+)$/gm)].map(match => `- ${match[2].slice(0, 200)} [${match[1]}]`);
  const text = ['（本草稿由離線 mock provider 依引用段落整理，未使用語言模型，需人工撰寫與核對）', '', ...sources].join('\n');
  return { text, inputTokens: estimateTokens(input.system + input.prompt), outputTokens: estimateTokens(text), usageSource: 'none' as const };
}

function usageOf(reportedInput: unknown, reportedOutput: unknown, input: GenerateInput, text: string) {
  const inputTokens = Number(reportedInput);
  const outputTokens = Number(reportedOutput);
  if (Number.isSafeInteger(inputTokens) && inputTokens >= 0 && Number.isSafeInteger(outputTokens) && outputTokens >= 0 && reportedInput !== undefined && reportedOutput !== undefined) {
    return { inputTokens, outputTokens, usageSource: 'provider_reported' as const };
  }
  // 供應商沒回報：不能記 0；用上界並標記待對帳（輸出不超過 max_tokens）。
  return { inputTokens: tokenUpperBound(input.system, input.prompt), outputTokens: Math.min(tokenUpperBound(text), input.maxOutputTokens), usageSource: 'estimated' as const };
}

/**
 * 送出一次請求並逐跳處理 redirect：每一跳都先通過網段政策（正式路徑解析 DNS 並鎖定位址），
 * 3xx 只有在 provider allowlist 核准時才跟隨，最多 3 跳；其餘一律 ENTERPRISE_EGRESS_REDIRECT_DENIED，請求內容不送往下一跳。
 */
async function send(provider: ModelProviderConfig, first: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }, options: SendOptions) {
  const policy = options.policy ?? defaultEgressNetworkPolicy();
  let url = new URL(first);
  const origin = url.origin;
  let request = init;
  for (let hop = 0; ; hop += 1) {
    let status: number;
    let location: string | null;
    let parse: () => Promise<unknown>;
    if (options.fetchImpl) {
      if (!staticDestinationAllowed(provider.deployment, url, policy)) throw new Error('ENTERPRISE_EGRESS_DENIED');
      const response = await options.fetchImpl(url.href, { ...request, redirect: 'manual' });
      status = response.status;
      location = response.headers?.get('location') ?? null;
      parse = () => response.json();
    } else {
      const pinned = await resolveDestination(url, provider.deployment, policy, options.lookup);
      const response = await pinnedRequest(url, pinned, request);
      status = response.status;
      location = response.location;
      parse = async () => {
        try { return JSON.parse(response.body) as unknown; } catch { throw new Error('ENTERPRISE_PROVIDER_BAD_RESPONSE'); }
      };
    }
    if (status >= 300 && status < 400) {
      if (hop >= MAX_REDIRECT_HOPS) throw new Error('ENTERPRISE_EGRESS_REDIRECT_DENIED');
      url = authorizeRedirect(url, location, status, provider.redirectAllowlist ?? []);
      // OCR 審查：跨 origin 跟隨時不轉送憑證（與瀏覽器行為一致）；需要憑證的供應商應直接把 baseUrl 設為最終主機
      if (url.origin !== origin) {
        const { authorization: _authorization, 'x-api-key': _apiKey, ...headers } = request.headers;
        request = { ...request, headers };
      }
      continue;
    }
    return { ok: status >= 200 && status < 300, status, json: parse };
  }
}

async function callRemote(provider: ModelProviderConfig, apiKey: string | null, input: GenerateInput, sendOptions: SendOptions, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (provider.kind === 'openai_compatible') {
      if (!provider.baseUrl) throw new Error('ENTERPRISE_PROVIDER_MISCONFIGURED');
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const response = await send(provider, `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ model: provider.model, max_tokens: input.maxOutputTokens, messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.prompt }] }),
      }, sendOptions);
      if (!response.ok) throw httpError(response.status);
      const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('ENTERPRISE_PROVIDER_BAD_RESPONSE');
      return { text, ...usageOf(data.usage?.prompt_tokens, data.usage?.completion_tokens, input, text) };
    }
    if (!apiKey) throw new Error('ENTERPRISE_PROVIDER_MISCONFIGURED');
    const response = await send(provider, `${(provider.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: provider.model, max_tokens: input.maxOutputTokens, system: input.system, messages: [{ role: 'user', content: input.prompt }] }),
    }, sendOptions);
    if (!response.ok) throw httpError(response.status);
    const data = await response.json() as { content?: Array<{ type?: string; text?: unknown }>; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    const text = data.content?.filter(part => part.type === 'text').map(part => part.text).join('');
    if (typeof text !== 'string' || !text.trim()) throw new Error('ENTERPRISE_PROVIDER_BAD_RESPONSE');
    return { text, ...usageOf(data.usage?.input_tokens, data.usage?.output_tokens, input, text) };
  } catch (error) {
    if ((error as Error).name === 'AbortError' || controller.signal.aborted) throw new Error('ENTERPRISE_PROVIDER_TIMEOUT');
    if (error instanceof Error && error.message.startsWith('ENTERPRISE_')) throw error;
    throw new Error('ENTERPRISE_PROVIDER_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }
}

/** 4xx（408／429 除外）是供應商明確拒絕：不重試（ENTERPRISE_PROVIDER_REJECTED）；5xx／408／429 才是暫時性 HTTP_ERROR。 */
function httpError(status: number) {
  const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return Object.assign(new Error(permanent ? 'ENTERPRISE_PROVIDER_REJECTED' : 'ENTERPRISE_PROVIDER_HTTP_ERROR'), { status });
}

function isTransient(error: unknown) {
  const message = (error as Error).message;
  const status = (error as { status?: number }).status ?? 0;
  return ['ENTERPRISE_PROVIDER_TIMEOUT', 'ENTERPRISE_PROVIDER_UNREACHABLE', 'ENTERPRISE_PROVIDER_CONNECTION_LOST'].includes(message) || status >= 500 || status === 429;
}

/**
 * 供同模組 workflow worker 使用：呼叫 provider，含逾時、一次重試（只對暫時性錯誤）與 circuit breaker（連續 3 次失敗開路 60 秒）。
 * 回傳錯誤只會是 ENTERPRISE_* 代碼，不帶 provider 回應內容。
 */
export async function generateWithProvider(provider: ModelProviderConfig, apiKey: string | null, input: GenerateInput,
  options: SendOptions & { timeoutMs?: number; now?: () => number; maxAttempts?: 1 | 2 } = {}): Promise<GenerateResult> {
  if (provider.kind === 'mock') return mockGenerate(input);
  const now = options.now ?? Date.now;
  const breaker = breakers.get(provider.id) ?? { failures: 0, openUntil: 0 };
  if (breaker.openUntil > now()) throw new Error('ENTERPRISE_PROVIDER_CIRCUIT_OPEN');
  let lastError: unknown;
  // worker 傳 maxAttempts: 1：每次 HTTP 呼叫都由 worker 逐筆記帳（ASTRA-008），重試交給 worker。
  for (let attempt = 1; attempt <= (options.maxAttempts ?? 2); attempt += 1) {
    try {
      const result = await callRemote(provider, apiKey, input, { fetchImpl: options.fetchImpl, lookup: options.lookup, policy: options.policy }, options.timeoutMs ?? 30_000);
      breakers.set(provider.id, { failures: 0, openUntil: 0 });
      return result;
    } catch (error) {
      lastError = error;
      // 外送政策拒絕不是 provider 故障：不重試、不累計 circuit breaker。
      if ((error as Error).message?.startsWith('ENTERPRISE_EGRESS_')) throw error;
      if (!isTransient(error)) break;
    }
  }
  const failures = breaker.failures + 1;
  breakers.set(provider.id, { failures, openUntil: failures >= BREAKER_THRESHOLD ? now() + BREAKER_OPEN_MS : 0 });
  throw new Error((lastError as Error).message.startsWith('ENTERPRISE_') ? (lastError as Error).message : 'ENTERPRISE_PROVIDER_UNREACHABLE');
}
