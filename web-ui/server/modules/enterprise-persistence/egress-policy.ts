import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * ASTRA-002 / DEC-EGRESS-01：模型外送的目的地政策，在「實際連線」那一層執行。
 *
 * 硬邊界（不可由客戶管理員放寬）：
 * - 每一跳都先 DNS 解析，所有 A／AAAA（IPv4-mapped IPv6 先正規化）都必須符合 deployment 的網段政策，否則 ENTERPRISE_EGRESS_DENIED。
 * - 連線鎖定在已驗證的位址（自訂 lookup），之後再解析得到的結果不會被使用（防 DNS rebinding）。
 * - LOCAL_ONLY 只允許部署網段政策 ENTERPRISE_EGRESS_LOCAL_CIDRS（預設 loopback／RFC1918／ULA，不含 link-local metadata）；
 *   部署端只能收窄，不能把公網加進來。
 * - CLOUD_ALLOWED 只允許全球可路由位址（拒絕私有、loopback、link-local、CGNAT、NAT64、6to4、文件與保留網段），防 SSRF。
 * - redirect 預設拒絕。
 *
 * 彈性（客戶管理員、具名且留稽核）：每個 provider 可設定 redirect allowlist（host:port）。
 * 只有 307／308、未降級、不帶帳密、且目標在清單內時才跟隨，跟隨後的目的地仍要通過上面的網段政策。
 */

export type Deployment = 'LOCAL_ONLY' | 'CLOUD_ALLOWED';
export type ResolvedAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;
export type EgressNetworkPolicy = { local: net.BlockList; localCidrs: string[] };

const DEFAULT_LOCAL_CIDRS = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7'];

/** 非全球可路由（CLOUD_ALLOWED 禁止連到這些位址）。IPv4-mapped 已先正規化成 IPv4，不在此列。 */
const NON_GLOBAL_CIDRS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
  // 不列 ::ffff:0:0/96：Node BlockList 會讓所有 IPv4 命中該段；呼叫前已把 IPv4-mapped 正規化為 IPv4。
  '::/127', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8',
];

function parseCidr(value: string) {
  const match = /^([0-9a-f.:]+)\/(\d{1,3})$/i.exec(value.trim());
  const family = match ? net.isIP(match[1]) : 0;
  const prefix = match ? Number(match[2]) : -1;
  if (!match || !family || prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw new Error('ENTERPRISE_EGRESS_POLICY_INVALID');
  return { address: match[1].toLowerCase(), prefix, type: family === 4 ? 'ipv4' as const : 'ipv6' as const };
}

function blockList(cidrs: string[]) {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    list.addSubnet(parsed.address, parsed.prefix, parsed.type);
  }
  return list;
}

const NON_GLOBAL = blockList(NON_GLOBAL_CIDRS);
const DEFAULT_LOCAL = DEFAULT_LOCAL_CIDRS.map(parseCidr);

function expandIPv6(address: string) {
  let text = address;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    text = text.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.map(group => parseInt(group || '0', 16));
}

/** 去除方括號、轉小寫；IPv4-mapped IPv6（含 ::ffff:7f00:1 十六進位與完整寫法）轉成 IPv4。非 IP 原樣回傳。 */
export function normalizeAddress(value: string) {
  const address = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv6(address)) {
    const groups = expandIPv6(address);
    if (groups.length === 8 && groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
      return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
    }
  }
  return address;
}

function isMappedLiteral(value: string) {
  const address = value.replace(/^\[|\]$/g, '').toLowerCase();
  return net.isIPv6(address) && normalizeAddress(address) !== address;
}

/** 部署網段政策；每個 CIDR 都必須落在預設 loopback／RFC1918／ULA 之內（只能收窄）。 */
export function loadEgressNetworkPolicy(env: Record<string, string | undefined> = process.env): EgressNetworkPolicy {
  const raw = env.ENTERPRISE_EGRESS_LOCAL_CIDRS?.trim();
  const localCidrs = raw ? raw.split(',').map(value => value.trim()).filter(Boolean) : DEFAULT_LOCAL_CIDRS;
  if (localCidrs.length === 0 || localCidrs.length > 64) throw new Error('ENTERPRISE_EGRESS_POLICY_INVALID');
  for (const cidr of localCidrs) {
    const parsed = parseCidr(cidr);
    const inside = DEFAULT_LOCAL.some(range => range.type === parsed.type && parsed.prefix >= range.prefix
      && blockList([`${range.address}/${range.prefix}`]).check(parsed.address, parsed.type));
    if (!inside) throw new Error('ENTERPRISE_EGRESS_POLICY_INVALID');
  }
  return { local: blockList(localCidrs), localCidrs };
}

let processPolicy: EgressNetworkPolicy | null = null;
/** 程序層級政策（讀 process.env 一次）。 */
export function defaultEgressNetworkPolicy() {
  processPolicy ??= loadEgressNetworkPolicy(process.env);
  return processPolicy;
}

export function addressAllowed(deployment: Deployment, value: string, policy: EgressNetworkPolicy) {
  const address = normalizeAddress(value);
  const family = net.isIP(address);
  if (!family) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  return deployment === 'LOCAL_ONLY' ? policy.local.check(address, type) : !NON_GLOBAL.check(address, type);
}

/** 設定時（不解析 DNS）的靜態檢查：scheme、IP 字面值與主機名語法。 */
export function staticDestinationAllowed(deployment: Deployment, url: URL, policy: EgressNetworkPolicy) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isMappedLiteral(host)) return false;
  if (net.isIP(host)) return addressAllowed(deployment, host, policy);
  if (deployment === 'CLOUD_ALLOWED') return host.includes('.') && !host.endsWith('.internal') && !host.endsWith('.local') && host !== 'localhost';
  return host === 'localhost' || /^[a-z0-9-]+$/.test(host) || host.endsWith('.internal') || host.endsWith('.local');
}

const HOST_PORT = /^(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*):(\d{1,5})$/;

/** redirect allowlist：只接受精確 host:port（無萬用字元、無 scheme），正規化小寫、去重、最多 16 筆。 */
export function parseRedirectAllowlist(values: unknown) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values) || values.length > 16) throw new Error('ENTERPRISE_INVALID_PROVIDER');
  const result: string[] = [];
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    const match = HOST_PORT.exec(text);
    const port = match ? Number(match[2]) : 0;
    if (!match || port < 1 || port > 65535 || isMappedLiteral(match[1])) throw new Error('ENTERPRISE_INVALID_PROVIDER');
    if (!result.includes(text)) result.push(text);
  }
  return result;
}

function hostPort(url: URL) {
  return `${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}

/** 判斷一個 3xx 是否可以跟隨；可以就回傳下一跳 URL（目的地網段仍需另外驗證）。 */
export function authorizeRedirect(from: URL, location: string | undefined | null, status: number, allowlist: string[]) {
  if (status !== 307 && status !== 308) throw new Error('ENTERPRISE_EGRESS_REDIRECT_DENIED');
  if (!location) throw new Error('ENTERPRISE_EGRESS_REDIRECT_DENIED');
  let next: URL;
  try { next = new URL(location, from); } catch { throw new Error('ENTERPRISE_EGRESS_REDIRECT_DENIED'); }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('ENTERPRISE_EGRESS_REDIRECT_DENIED');
  if (from.protocol === 'https:' && next.protocol !== 'https:') throw new Error('ENTERPRISE_EGRESS_REDIRECT_DENIED');
  if (next.username || next.password) throw new Error('ENTERPRISE_EGRESS_REDIRECT_DENIED');
  if (!allowlist.includes(hostPort(next))) throw new Error('ENTERPRISE_EGRESS_REDIRECT_DENIED');
  return next;
}

const systemLookup: Lookup = async hostname => dns.lookup(hostname, { all: true, verbatim: true });

/** 解析一次，所有位址都必須符合政策；回傳要鎖定的位址。DNS 本身失敗視為暫時性（UNREACHABLE）。 */
export async function resolveDestination(url: URL, deployment: Deployment, policy: EgressNetworkPolicy, lookup: Lookup = systemLookup): Promise<ResolvedAddress> {
  if (!staticDestinationAllowed(deployment, url, policy)) throw new Error('ENTERPRISE_EGRESS_DENIED');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: ResolvedAddress[];
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    try { addresses = await lookup(host); } catch { throw new Error('ENTERPRISE_PROVIDER_UNREACHABLE'); }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error('ENTERPRISE_EGRESS_DENIED');
  const normalized = addresses.map(entry => normalizeAddress(String(entry?.address ?? '')));
  if (normalized.some(address => !addressAllowed(deployment, address, policy))) throw new Error('ENTERPRISE_EGRESS_DENIED');
  return { address: normalized[0], family: net.isIP(normalized[0]) };
}

export type PinnedResponse = { status: number; location: string | null; body: string };
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 連到已鎖定的位址送出一次請求；不跟隨 redirect；回應上限 4 MiB。Host／TLS SNI 仍使用原主機名。 */
export function pinnedRequest(url: URL, pinned: ResolvedAddress, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const lookup = (_hostname: string, options: { all?: boolean } | number | undefined, callback: (...args: unknown[]) => void) => {
    if (typeof options === 'object' && options?.all) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<PinnedResponse>((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol, hostname: net.isIP(host) ? pinned.address : host, port: url.port || undefined, path: `${url.pathname}${url.search}`,
      method: init.method, headers: { ...init.headers, host: url.host, 'content-length': Buffer.byteLength(init.body) },
      lookup: lookup as never, signal: init.signal, agent: false,
      ...(url.protocol === 'https:' && !net.isIP(host) ? { servername: host } : {}),
    }, response => {
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { response.destroy(); reject(new Error('ENTERPRISE_PROVIDER_BAD_RESPONSE')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, location: response.headers.location ?? null, body: Buffer.concat(chunks).toString('utf8') }));
      // 回應途中斷線：請求已被處理的可能性存在 → CONNECTION_LOST（用量 unknown）
      response.on('aborted', () => reject(new Error('ENTERPRISE_PROVIDER_CONNECTION_LOST')));
      response.on('error', () => reject(new Error('ENTERPRISE_PROVIDER_CONNECTION_LOST')));
    });
    // ASTRA-008：區分「請求送出前就連不上」（未計費）與「送出後斷線」（可能已計費）。
    let sent = false;
    request.on('finish', () => { sent = true; });
    request.on('error', () => reject(new Error(sent ? 'ENTERPRISE_PROVIDER_CONNECTION_LOST' : 'ENTERPRISE_PROVIDER_UNREACHABLE')));
    request.end(init.body);
  });
}
