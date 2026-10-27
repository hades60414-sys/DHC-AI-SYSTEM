// TAS Worker. One script, deployed under many names in the TAS Cloudflare account.
// ROLE=front: the browser entrance. Only the deployment whose SELF equals KV 'current' serves the app (cookie gate ->
//   current quick tunnel -> srv-main CloudCLI); every older front shows the wave page pointing at KV 'current_url'.
//   tas-rotate.cjs deploys a new front each week and flips 'current'.
// ROLE=mailbox: fixed URL baked into the remote agents. No UI: only agent uploads/downloads, /health, /_where, /_tunnel-update.
// KV 'target' holds the trycloudflare URL; the srv-main watchdog POSTs it to /_tunnel-update with EDGE_SEAL.
// WebSocket: upstream 101 responses must be returned as-is (re-wrapping drops the socket).
import { gate, crossOrigin, timingSafeEq, isOpenPath, isAgentUpload } from './gate.mjs';
import movedHtml from './moved.html';

async function handleTunnelUpdate(req, env) {
  if (req.method !== 'POST') return new Response('method', { status: 405 });
  const seal = req.headers.get('x-tasui-seal') || '';
  if (!env.EDGE_SEAL || !seal || !timingSafeEq(seal, env.EDGE_SEAL)) return new Response('forbidden', { status: 403 });
  const body = (await req.text()).trim();
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(body)) return new Response('bad target format', { status: 400 });
  await env.TUNNEL.put('target', body);
  return new Response('ok');
}
// The gate password key fails closed (audit 2026-10-18 #5): a missing or broken binding must not allow unlimited guessing.
// Other keys keep failing open so a limiter outage does not take the app down.
async function limited(env, key) {
  const closed = key.startsWith('gate:');
  if (!env.FAIL_LIMIT) return closed;
  try { const r = await env.FAIL_LIMIT.limit({ key }); return !r.success; } catch { return closed; }
}
const noStore = { 'cache-control': 'no-store' };
// KV reads count against the free plan's 100k/day; on 2026-10-21 00:03 Taipei the quota ran out and every request threw
// until the 08:00 reset. Keep each value in isolate memory for 30s, and if KV fails serve the last value we had.
const KV_TTL_MS = 30_000;
const memo = new Map();
async function kv(env, key) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < KV_TTL_MS) return hit.value;
  try {
    const value = await env.TUNNEL.get(key);
    memo.set(key, { value, at: Date.now() });
    return value;
  } catch (e) {
    if (hit) return hit.value;
    throw e;
  }
}
async function where(env) {
  const url = (await kv(env, 'current_url')) || '';
  return new Response(JSON.stringify({ url }), {
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...noStore },
  });
}
async function moved(env) {
  const url = (await kv(env, 'current_url')) || '#';
  const safe = /^https:\/\/[a-z0-9.-]+\/?$/.test(url) ? url : '#';
  return new Response(movedHtml.replace('{{URL}}', safe), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', ...noStore },
  });
}
async function forward(req, env, url, ip) {
  const target = await kv(env, 'target');
  if (!target) return new Response('TAS offline (target not set)', { status: 503 });
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
  // Hashed build assets never change: let browsers keep them for a year (every request counts against the daily quota).
  if (upstream.status === 200 && url.pathname.startsWith('/assets/')) {
    out.headers.set('cache-control', 'public, max-age=31536000, immutable');
  }
  return out;
}

async function mailbox(req, env, url, ip) {
  if (url.pathname === '/_where') return where(env);
  const download = isOpenPath(req.method, url.pathname);
  if (!download) {
    if (req.method === 'POST' && url.pathname === '/api/assets/files' && await limited(env, 'up:' + ip)) {
      return new Response('too many uploads, wait a minute', { status: 429, headers: noStore });
    }
    if (!(await isAgentUpload(req, url))) return new Response('not found', { status: 404, headers: noStore });
  }
  return forward(req, env, url, ip);
}

async function front(req, env, url, ip) {
  if (env.SELF !== await kv(env, 'current')) {
    if (url.pathname === '/_where') return where(env);
    if (req.method === 'GET' && !req.headers.get('upgrade')) return moved(env);
    return new Response('moved', { status: 410, headers: noStore });
  }
  const foreign = crossOrigin(req, url);
  if (foreign) return foreign;
  const blocked = await gate(req, env, url, ip, limited);
  if (blocked) return blocked;
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    if (await limited(env, 'login:' + ip)) return new Response('too many login attempts, wait a minute', { status: 429 });
  }
  return forward(req, env, url, ip);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/_tunnel-update') return handleTunnelUpdate(req, env);
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    try {
      return await (env.ROLE === 'mailbox' ? mailbox(req, env, url, ip) : front(req, env, url, ip));
    } catch (e) {
      // Readable text instead of Cloudflare's opaque error page. Stays 500: health-check treats 502/503/504/530 as a broken tunnel and would replace it.
      return new Response('TAS 入口暫時讀不到設定（多半是 Cloudflare 每日免費額度用完，台北 08:00 重置）：' + String(e && e.message || e).slice(0, 200),
        { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', ...noStore } });
    }
  },
};
