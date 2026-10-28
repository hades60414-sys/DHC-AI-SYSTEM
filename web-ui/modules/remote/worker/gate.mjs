// DHC CLI remote gate — a Cloudflare Worker template.
//
// Sits in front of your Cloudflare Tunnel and lets a request through only with a valid login cookie.
// Everything secret comes from Worker secrets (wrangler secret put ...); nothing is written in this file.
//
//   TUNNEL_ORIGIN   https://<YOUR-TUNNEL-HOSTNAME>   where the tunnel publishes DHC CLI
//   GATE_PASSWORD   <YOUR-LONG-RANDOM-PASSWORD>      what people type on the login page
//   COOKIE_SECRET   <ANOTHER-LONG-RANDOM-STRING>     signs the login cookie; change it to log everyone out
//
// The gate is in addition to DHC CLI's own login, not instead of it.

const COOKIE = 'dhc_gate';
const COOKIE_DAYS = 30;
const OPEN_PATHS = new Set(['/health']);

const encoder = new TextEncoder();

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function makeCookie(env) {
  const expires = Date.now() + COOKIE_DAYS * 86_400_000;
  const value = `${expires}.${await hmac(env.COOKIE_SECRET, String(expires))}`;
  return `${COOKIE}=${value}; Path=/; Max-Age=${COOKIE_DAYS * 86_400}; HttpOnly; Secure; SameSite=Lax`;
}

async function hasValidCookie(request, env) {
  const cookie = (request.headers.get('Cookie') || '').split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  if (!cookie) return false;
  const [expires, signature] = cookie.slice(COOKIE.length + 1).split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  return sameString(signature, await hmac(env.COOKIE_SECRET, expires));
}

function loginPage(message = '') {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DHC CLI</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f6f4;color:#222}
form{display:grid;gap:12px;width:min(320px,90vw)}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #ccc}
button{background:#222;color:#fff;border:0}p{color:#b42318;margin:0}</style>
<form method="post" action="/_gate/login"><h1>DHC CLI</h1>${message ? `<p>${message}</p>` : ''}
<input type="password" name="password" placeholder="密碼" autocomplete="current-password" autofocus required>
<button>登入</button></form>`;
  return new Response(html, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    if (!env.TUNNEL_ORIGIN || !env.GATE_PASSWORD || !env.COOKIE_SECRET) {
      return new Response('Gate is not configured: set TUNNEL_ORIGIN, GATE_PASSWORD and COOKIE_SECRET.', { status: 503 });
    }
    const url = new URL(request.url);

    if (url.pathname === '/_gate/login' && request.method === 'POST') {
      const form = await request.formData();
      if (!sameString(String(form.get('password') || ''), env.GATE_PASSWORD)) return loginPage('密碼不對');
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': await makeCookie(env) } });
    }
    if (url.pathname === '/_gate/logout') {
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
    }

    if (!OPEN_PATHS.has(url.pathname) && !(await hasValidCookie(request, env))) return loginPage();

    // Pass through to the tunnel, WebSocket upgrades included.
    const target = new URL(url.pathname + url.search, env.TUNNEL_ORIGIN);
    return fetch(new Request(target, request));
  },
};
