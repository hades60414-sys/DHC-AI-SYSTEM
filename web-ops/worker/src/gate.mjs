// Cookie gate in front of everything the Worker forwards (added 2026-10-08).
// Password = env.GATE_PW + Taipei-time hhddmm (hour, day, month); a correct login sets a 30-day cookie signed with env.GATE_KEY.
// Cookie-based on purpose: a Basic-auth gate collides with the app's own Authorization: Bearer header.
// Missing GATE_PW or GATE_KEY means nobody gets in (fail closed).
const enc = new TextEncoder();
const MAX_AGE = 30 * 24 * 3600;
const HOUR = 3600e3;
const taipei = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei', hourCycle: 'h23', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

export function timingSafeEq(a, b) {
  const [x, y] = [enc.encode(a), enc.encode(b)];
  if (x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
function taipeiParts(ms) {
  const p = {};
  for (const { type, value } of taipei.formatToParts(new Date(ms))) p[type] = value;
  return p;
}
// Codes accepted at this instant: the current hour, plus the neighbouring hour within 5 minutes of the boundary.
export function gateCodes(ms) {
  const code = (t) => { const p = taipeiParts(t); return p.hour + p.day + p.month; };
  const minute = Number(taipeiParts(ms).minute);
  const out = [code(ms)];
  if (minute < 5) out.push(code(ms - HOUR));
  if (minute >= 55) out.push(code(ms + HOUR));
  return out;
}
export function passwordOk(pw, given, ms) {
  if (!pw || typeof given !== 'string') return false;
  let ok = false;
  for (const c of gateCodes(ms)) if (timingSafeEq(given, pw + c)) ok = true;
  return ok;
}
async function sign(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function makeCookie(key, ms) {
  const exp = Math.floor(ms / 1000) + MAX_AGE;
  return `${exp}.${await sign(key, String(exp))}`;
}
export async function cookieOk(key, header, ms) {
  const m = /(?:^|;\s*)tasui_gate=(\d{1,12})\.([0-9a-f]{64})(?:;|$)/.exec(header || '');
  if (!key || !m || Number(m[1]) * 1000 <= ms) return false;
  return timingSafeEq(m[2], await sign(key, m[1]));
}
// Only same-site paths may be used as the post-login redirect.
export function safeNext(n) {
  return typeof n === 'string' && /^\/(?![/\\])/.test(n) ? n : '/';
}
// Reachable without the cookie: health probes (scheduled checks) and asset downloads (remote agents fetch installers with curl).
export function isOpenPath(method, path) {
  if (path === '/health') return true;
  if (method !== 'GET' && method !== 'HEAD') return false;
  return /^\/api\/assets\/files\/[^/]+$/.test(path) && !/%2f|%5c/i.test(path);
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page(next, error, status) {
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>DHC CLI</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}
form{display:grid;gap:12px;width:min(20rem,86vw)}input,button{font-size:16px;padding:10px;border-radius:6px;border:1px solid #444;background:#1c1c1c;color:#eee}
button{background:#eee;color:#111;cursor:pointer}p{margin:0;color:#f88;font-size:14px}</style></head>
<body><form method="post" action="/_gate"><input type="hidden" name="next" value="${esc(next)}">
<input type="password" name="pw" placeholder="通行密碼" autofocus autocomplete="off" required>
<button type="submit">進入</button>${error ? `<p>${esc(error)}</p>` : ''}</form></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// Login log, kept in the TUNNEL KV namespace under gatelog:<inverted time>:... so a list call returns newest first;
// the details sit in key metadata, so the log page needs one list call and no gets. Entries expire after 180 days.
// Successes get one entry each. Failures get one entry per IP per hour: a guessing run must not burn the daily
// KV write quota that the tunnel updater depends on.
const LOG_TTL = 180 * 24 * 3600;
const inverted = (ms) => String(9999999999999 - ms).padStart(13, '0');
// Short device label from the browser's self-reported User-Agent (a hint, not an identity).
export function deviceLabel(ua) {
  if (!ua) return '未提供';
  const android = /Android [\d.]+; ([^;)]+)/.exec(ua);
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
    : android ? 'Android ' + android[1].trim() : /Android/.test(ua) ? 'Android'
    : /Windows NT/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '其他';
  const has = (...names) => names.some((n) => ua.includes(n + '/'));
  const browser = has('Edg', 'Edge', 'EdgA', 'EdgiOS') ? 'Edge' : has('Firefox', 'FxiOS') ? 'Firefox'
    : has('Chrome', 'CriOS') ? 'Chrome' : has('Safari') ? 'Safari' : ua.startsWith('curl/') ? 'curl' : '其他';
  return os + ' · ' + browser;
}
async function logLogin(env, ok, req, ip, now) {
  try {
    const ua = (req.headers.get('user-agent') || '').slice(0, 300);
    const cf = req.cf || {};
    const metadata = {
      t: now, ok, ip, ua, dev: deviceLabel(ua),
      loc: [cf.country, cf.city].filter(Boolean).join(' ').slice(0, 60), org: String(cf.asOrganization || '').slice(0, 60),
    };
    let key = `gatelog:${inverted(now)}:${crypto.randomUUID().slice(0, 8)}`;
    if (!ok) {
      key = `gatelog:${inverted(now - (now % HOUR))}:fail:${ip}`;
      if (await env.TUNNEL.get(key) !== null) return;
    }
    await env.TUNNEL.put(key, '1', { metadata, expirationTtl: LOG_TTL });
  } catch { /* logging must never block a login */ }
}
const logTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium' });
async function logPage(env) {
  const { keys } = await env.TUNNEL.list({ prefix: 'gatelog:', limit: 300 });
  const rows = keys.map(({ metadata: m }) => m ? `<tr class="${m.ok ? '' : 'bad'}"><td>${esc(logTime.format(new Date(m.t)))}</td>
<td>${m.ok ? '成功' : '失敗'}</td><td>${esc(m.ip)}</td><td>${esc([m.loc, m.org].filter(Boolean).join('｜'))}</td>
<td>${esc(m.dev)}<small>${esc(m.ua)}</small></td></tr>` : '').join('');
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>登入紀錄</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;margin:16px}table{border-collapse:collapse;width:100%;font-size:14px}
td,th{border-bottom:1px solid #333;padding:6px 8px;text-align:left;vertical-align:top}small{display:block;color:#888;word-break:break-all}
.bad td{color:#f88}p{color:#aaa;font-size:13px}</style></head><body><h3>登入紀錄（台灣時間，新的在上，保留 180 天）</h3>
<p>失敗的嘗試每個 IP 每小時只記第一筆。裝置是瀏覽器自己報的，只能當參考。</p>
<table><tr><th>時間</th><th>結果</th><th>IP</th><th>地點｜網路</th><th>裝置</th></tr>${rows}</table></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// The remote agents (srv-db/srv-rag/srv-main) upload their signed, encrypted reports with curl and cannot carry the cookie.
// Only that upload passes without one: small multipart posts whose every file name is an agent report name.
const AGENT_UPLOAD = /^[a-z0-9]+-agent-(report|heartbeat|enrollment)\.cms\.b64\.txt$/;
const AGENT_UPLOAD_MAX = 5 * 1024 * 1024;
export async function isAgentUpload(req, url) {
  if (req.method !== 'POST' || url.pathname !== '/api/assets/files') return false;
  const length = Number(req.headers.get('content-length'));
  if (!(length > 0 && length <= AGENT_UPLOAD_MAX)) return false;
  try {
    const parts = [...(await req.clone().formData()).entries()];
    return parts.length > 0 && parts.every(([k, v]) => k === 'files' && typeof v !== 'string' && AGENT_UPLOAD.test(v.name));
  } catch { return false; }
}

// Cross-site guard (audit 2026-10-18 #4): another Worker on the same workers.dev account counts as same-site, so the
// SameSite=Lax cookie rides along. A WebSocket upgrade or a non-GET request whose Origin is present and differs from
// this Worker's own origin gets 403. curl callers (agents, /_tunnel-update) send no Origin and are unaffected.
export function crossOrigin(req, url) {
  const origin = req.headers.get('origin');
  if (origin === null) return null;
  if (req.method === 'GET' && !req.headers.get('upgrade')) return null;
  if (origin === url.origin) return null;
  return new Response('cross-origin request refused', { status: 403, headers: { 'cache-control': 'no-store' } });
}

// Returns a Response when the request must not be forwarded, null when it may pass.
export async function gate(req, env, url, ip, limited) {
  const now = Date.now();
  if (url.pathname === '/_gate') {
    if (req.method !== 'POST') return page(safeNext(url.searchParams.get('next')), '', 200);
    if (await limited(env, 'gate:' + ip)) return page('/', '嘗試太多次，請一分鐘後再試', 429);
    let form;
    try { form = await req.formData(); } catch { return page('/', '密碼不對', 401); }
    const next = safeNext(form.get('next'));
    const ok = !!env.GATE_KEY && passwordOk(env.GATE_PW, form.get('pw'), now);
    await logLogin(env, ok, req, ip, now);
    if (!ok) return page(next, '密碼不對', 401);
    return new Response(null, {
      status: 302,
      headers: {
        location: next,
        'cache-control': 'no-store',
        'set-cookie': `tasui_gate=${await makeCookie(env.GATE_KEY, now)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`,
      },
    });
  }
  if (isOpenPath(req.method, url.pathname)) return null;
  if (await cookieOk(env.GATE_KEY, req.headers.get('cookie'), now)) return url.pathname === '/_gate/log' ? logPage(env) : null;
  // Uploads without the cookie get a per-IP limit (audit 2026-10-18 #3); agents retry a refused report on their next loop.
  if (req.method === 'POST' && url.pathname === '/api/assets/files' && await limited(env, 'up:' + ip)) {
    return new Response('too many uploads, wait a minute', { status: 429, headers: { 'cache-control': 'no-store' } });
  }
  if (await isAgentUpload(req, url)) return null;
  if (req.method === 'GET' && (req.headers.get('accept') || '').includes('text/html')) {
    return new Response(null, {
      status: 302,
      headers: { location: '/_gate?next=' + encodeURIComponent(url.pathname + url.search), 'cache-control': 'no-store' },
    });
  }
  return new Response('login required', { status: 401, headers: { 'cache-control': 'no-store' } });
}
