// tasui Worker: fixed https://tasui.<account>.workers.dev -> current Cloudflare quick tunnel -> local CloudCLI (127.0.0.1:3001).
// Layers: (1) cookie gate (gate.mjs: fixed password + time code, per-IP rate limit), (2) per-IP rate limit on CloudCLI's login endpoint,
//         (3) EDGE_SEAL so the tunnel URL cannot be hit directly. (Basic-auth gate removed 2026-09-09: it collided with the app's Bearer header.)
// KV key 'target' holds the current trycloudflare URL; the local watchdog POSTs it to /_tunnel-update with EDGE_SEAL.
// WebSocket: upstream 101 responses must be returned as-is (re-wrapping drops the socket).
import { gate, crossOrigin, timingSafeEq } from './gate.mjs';
function basicPassword(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const bytes = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder('utf-8').decode(bytes);
    return decoded.slice(decoded.indexOf(':') + 1);
  } catch { return null; }
}
async function handleTunnelUpdate(req, env) {
  if (req.method !== 'POST') return new Response('method', { status: 405 });
  const seal = req.headers.get('x-tasui-seal') || '';
  if (!env.EDGE_SEAL || !seal || !timingSafeEq(seal, env.EDGE_SEAL)) return new Response('forbidden', { status: 403 });
  const body = (await req.text()).trim();
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(body)) return new Response('bad target format', { status: 400 });
  await env.TUNNEL.put('target', body);
  cached = { target: body, at: Date.now() };
  return new Response('ok');
}
// One KV read per request used to tie the KV daily read quota to page traffic (2026-10-22). Each isolate keeps the
// target for 30s; a tunnel switch reaches other isolates within that window.
const TARGET_TTL = 30 * 1000;
let cached = { target: null, at: 0 };
async function tunnelTarget(env) {
  if (cached.target && Date.now() - cached.at < TARGET_TTL) return cached.target;
  const target = await env.TUNNEL.get('target');
  if (target) cached = { target, at: Date.now() };
  return target;
}
// The gate password key fails closed (audit 2026-10-18 #5): a missing or broken binding must not allow unlimited guessing.
// Other keys keep failing open so a limiter outage does not take the app down.
async function limited(env, key) {
  const closed = key.startsWith('gate:');
  if (!env.FAIL_LIMIT) return closed;
  try { const r = await env.FAIL_LIMIT.limit({ key }); return !r.success; } catch { return closed; }
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/_tunnel-update') return handleTunnelUpdate(req, env);
    const foreign = crossOrigin(req, url);
    if (foreign) return foreign;
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    const blocked = await gate(req, env, url, ip, limited);
    if (blocked) return blocked;
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      if (await limited(env, 'login:' + ip)) return new Response('too many login attempts, wait a minute', { status: 429 });
    }
    const target = await tunnelTarget(env);
    if (!target) return new Response('CC Web UI offline (target not set)', { status: 503 });
    const dest = new URL(target);
    url.protocol = 'https:'; url.hostname = dest.hostname; url.port = '';
    const headers = new Headers(req.headers);
    headers.delete('x-tasui-edge');
    if (env.EDGE_SEAL) headers.set('x-tasui-edge', env.EDGE_SEAL);
    headers.delete('x-tasui-visitor');
    headers.set('x-tasui-visitor', ip);
    const upstream = await fetch(new Request(url, req), { headers });
    if (upstream.status === 101) return upstream;
    const out = new Response(upstream.body, upstream);
    // Hashed build assets never change: let browsers keep them for a year so page loads stop re-requesting
    // ~10 files each (every request through here counts against the account's 100k/day Workers quota).
    if (upstream.status === 200 && url.pathname.startsWith('/assets/')) {
      out.headers.set('cache-control', 'public, max-age=31536000, immutable');
    }
    return out;
  },
};
