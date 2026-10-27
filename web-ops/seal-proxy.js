// seal-proxy.js — local gate in front of CloudCLI.
// Listens on 127.0.0.1:3002 (what the tunnel points at). Forwards to 127.0.0.1:3001 only when the request
// carries x-tasui-edge equal to TASUI_EDGE_SEAL from .env — i.e. it came through the tasui Worker, not the raw
// trycloudflare URL. Handles both HTTP and WebSocket upgrades. No dependencies.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const m = env.match(/^TASUI_EDGE_SEAL=(.+)$/m);
if (!m) { console.error('seal-proxy: TASUI_EDGE_SEAL missing in .env'); process.exit(1); }
const SEAL = Buffer.from(m[1].trim());
const LISTEN = 3002, TARGET = 3001;

function sealed(req) {
  const h = req.headers['x-tasui-edge'];
  if (!h) return false;
  const b = Buffer.from(String(h));
  return b.length === SEAL.length && crypto.timingSafeEqual(b, SEAL);
}
function strip(headers) {
  const out = { ...headers };
  delete out['x-tasui-edge'];
  return out;
}

// /_usage: Claude subscription usage (5h / weekly / weekly Fable) for the DHC CLI sidebar.
// Reads the OAuth token Claude Code keeps in ~/.claude/.credentials.json (refreshed by the running CC hosts),
// calls the same endpoint CC's /usage uses, caches 60s. Token never leaves this machine except to Anthropic.
const https = require('https');
const os = require('os');
let usageCache = { at: 0, body: null };
const CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
function readOauth() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).claudeAiOauth || null; } catch { return null; }
}
function readOauthToken() {
  const o = readOauth();
  return o && o.accessToken;
}
// 2026-09-21: the token only gets refreshed when a Claude turn runs on this machine, so over a weekend it
// expired (9/20 18:42) and the sidebar kept showing the previous day's 89% / 100% as if current. When the
// stored token is past expiresAt, refresh it the way Claude Code does (same endpoint, same client id,
// grant_type=refresh_token) and write the new pair back into the same file so CC keeps working.
// Guard rails: at most one attempt per 10 min; re-read the file before writing and skip if another
// process (a CC run) already replaced the token; temp file + rename so a crash never truncates it.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_RETRY_MS = 10 * 60000;
let nextRefreshAt = 0, refreshing = false, lastRefreshError = null;
function refreshOauthToken(cb) {
  const before = readOauth();
  if (!before || !before.refreshToken) return cb('no_refresh_token');
  if (refreshing) return cb('refresh_in_progress');
  if (Date.now() < nextRefreshAt) return cb(lastRefreshError || 'refresh_backoff');
  refreshing = true; nextRefreshAt = Date.now() + REFRESH_RETRY_MS;
  const body = JSON.stringify({ grant_type: 'refresh_token', refresh_token: before.refreshToken, client_id: OAUTH_CLIENT_ID });
  const r = https.request({ host: 'platform.claude.com', path: '/v1/oauth/token', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'User-Agent': 'dhc-cli-usage/0.1' } }, (ur) => {
    let d = ''; ur.on('data', (c) => d += c); ur.on('end', () => {
      refreshing = false;
      if (ur.statusCode !== 200) { lastRefreshError = 'refresh_' + ur.statusCode; return cb(lastRefreshError); }
      let j; try { j = JSON.parse(d); } catch { lastRefreshError = 'refresh_parse'; return cb(lastRefreshError); }
      if (!j.access_token) { lastRefreshError = 'refresh_no_token'; return cb(lastRefreshError); }
      const current = readOauth();
      if (!current || current.accessToken !== before.accessToken) {
        // Someone else (a running Claude turn) refreshed meanwhile; theirs is the live pair, ours is void.
        lastRefreshError = null; return cb(null);
      }
      const next = { ...current, accessToken: j.access_token,
        refreshToken: j.refresh_token || current.refreshToken,
        expiresAt: Date.now() + (Number(j.expires_in) > 0 ? Number(j.expires_in) * 1000 : 3600000),
        // Claude Code stops trusting the login once this date passes, so keep it in step when the server sends a new one.
        refreshTokenExpiresAt: Number(j.refresh_token_expires_in) > 0 ? Date.now() + Number(j.refresh_token_expires_in) * 1000 : current.refreshTokenExpiresAt };
      try {
        const raw = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
        raw.claudeAiOauth = next;
        const tmp = CRED_FILE + '.dhc-tmp';
        fs.writeFileSync(tmp, JSON.stringify(raw), { mode: 0o600 });
        try { fs.renameSync(tmp, CRED_FILE); }
        catch { fs.writeFileSync(CRED_FILE, JSON.stringify(raw), { mode: 0o600 }); try { fs.unlinkSync(tmp); } catch {} }
        lastRefreshError = null; nextRefreshAt = 0;
        console.log('seal-proxy: refreshed Claude OAuth token, expires ' + new Date(next.expiresAt).toISOString());
        cb(null);
      } catch (e) { lastRefreshError = 'refresh_write'; console.error('seal-proxy: token write failed', e.message); cb(lastRefreshError); }
    });
  });
  r.on('error', () => { refreshing = false; lastRefreshError = 'refresh_network'; cb(lastRefreshError); });
  r.setTimeout(15000, () => { r.destroy(); refreshing = false; lastRefreshError = 'refresh_timeout'; cb(lastRefreshError); });
  r.end(body);
}
// 2026-10-12: the Claude login itself runs out (refreshTokenExpiresAt, about 30 days after `claude auth login`); Claude Code
// then empties the tokens and every DHC CLI turn fails. Report it with the usage numbers so the sidebar can warn a week ahead.
const LOGIN_WARN_DAYS = 7;
// long_token: conversations run on the one-year token (claude-token.txt, see start-cc-web.cmd), so a dead login only stops the usage numbers.
const LONG_TOKEN_FILE = path.join(__dirname, 'claude-token.txt');
function loginInfo() { return { ...loginState(), long_token: fs.existsSync(LONG_TOKEN_FILE) }; }
function loginState() {
  const o = readOauth();
  if (!o || !o.refreshToken) return { state: 'logged_out' };
  const t = o.refreshTokenExpiresAt;
  if (typeof t !== 'number' || !(t > 0)) return { state: 'ok' };
  const days = Math.ceil((t - Date.now()) / 86400000);
  return { state: days <= 0 ? 'expired' : days <= LOGIN_WARN_DAYS ? 'expiring' : 'ok', expires_at: new Date(t).toISOString(), days_left: days };
}
function fetchUsage(cb) {
  const o = readOauth();
  if (!o || !o.accessToken) return cb(null, { error: 'no_token' });
  // Expired (or about to): refresh first instead of hammering the usage API with a dead token (that 429s).
  // TAS 2026-10-20: srv-main refreshes this login even with claude-token.txt present (only this proxy uses the file).
  if (o.expiresAt && Date.now() > o.expiresAt - 60000) {
    return refreshOauthToken((err) => {
      if (err) return cb(null, { error: 'token_expired:' + err });
      fetchUsageWith(readOauthToken(), cb);
    });
  }
  fetchUsageWith(o.accessToken, cb);
}
function fetchUsageWith(tok, cb) {
  if (!tok) return cb(null, { error: 'no_token' });
  const r = https.request({ host: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET',
    headers: { Authorization: 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'dhc-cli-usage/0.1' } }, (ur) => {
    let d = ''; ur.on('data', (c) => d += c); ur.on('end', () => {
      if (ur.statusCode !== 200) return cb(null, { error: 'upstream_' + ur.statusCode });
      try {
        const j = JSON.parse(d);
        const lim = Array.isArray(j.limits) ? j.limits : [];
        const pick = (f) => { const x = lim.find(f); return x ? { percent: x.percent, resets_at: x.resets_at, severity: x.severity } : null; };
        cb(null, {
          session: pick((x) => x.kind === 'session') || (j.five_hour && { percent: j.five_hour.utilization, resets_at: j.five_hour.resets_at }),
          weekly_all: pick((x) => x.kind === 'weekly_all') || (j.seven_day && { percent: j.seven_day.utilization, resets_at: j.seven_day.resets_at }),
          weekly_fable: pick((x) => x.kind === 'weekly_scoped' && x.scope && x.scope.model && /fable/i.test(x.scope.model.display_name || '')),
          fetched_at: new Date().toISOString(),
        });
      } catch (e) { cb(null, { error: 'parse' }); }
    });
  });
  r.on('error', (e) => cb(null, { error: 'network' }));
  r.setTimeout(15000, () => { r.destroy(); cb(null, { error: 'timeout' }); });
  r.end();
}
// Cache policy: success -> 60s; failure -> back off (429: 5 min, others: 60s) and keep serving the last good
// numbers with stale:true so the sidebar never blanks. Concurrent requests share one upstream call (single-flight).
// Upstream is polled on a fixed cadence by a background timer (never by client requests), so N open tabs cost
// the same as one. Last good payload is persisted to usage-cache.json so a restart never shows an empty panel.
const USAGE_FILE = path.join(__dirname, 'usage-cache.json');
const REFRESH_MS = 120000, BACKOFF_429_MS = 300000, IDLE_MS = 15 * 60000;
let lastGood = null, lastError = null, nextFetchAt = 0, lastAskedAt = 0, fetching = false;
try { lastGood = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch {}
function refreshUsage() {
  const now = Date.now();
  if (fetching || now < nextFetchAt || now - lastAskedAt > IDLE_MS) return;
  fetching = true;
  fetchUsage((_, data) => {
    fetching = false;
    if (!data.error) {
      lastGood = data; lastError = null; nextFetchAt = Date.now() + REFRESH_MS;
      try { fs.writeFileSync(USAGE_FILE, JSON.stringify(data)); } catch {}
    } else {
      lastError = data.error; nextFetchAt = Date.now() + (data.error === 'upstream_429' ? BACKOFF_429_MS : REFRESH_MS);
    }
  });
}
setInterval(refreshUsage, 10000);
function serveUsage(res) {
  lastAskedAt = Date.now();
  refreshUsage();
  const fresh = lastGood && lastError === null && (Date.now() - new Date(lastGood.fetched_at).getTime()) < 2 * REFRESH_MS;
  // `reason` tells the sidebar why the numbers are old, so it can say so instead of showing them as current.
  const out = lastGood ? (fresh ? lastGood : { ...lastGood, stale: true, reason: lastError || 'refreshing' }) : { error: lastError || 'loading' };
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ...out, login: loginInfo() }));
}

// 2026-10-22: Cloudflare free plan allows 100k Worker requests (and 100k KV reads) per account per UTC day. Every
// request a Worker forwards lands here. Two Workers on two accounts point at this tunnel (tasui on example for the
// remote agents, the TAS front door on <account> for browsers), so count per Worker and raise one amber shield alert per Worker per day at 50%. Requests a Worker's login gate
// rejects never reach us, so these are lower bounds.
const { execFile } = require('child_process');
const CF_FILE = path.join(__dirname, 'cf-requests.json');
// 2026-10-27 使用者：50% 的黃點天天亮太煩 → 75% 黃、90% 紅；台灣 08:00（UTC 換日）把前一天的收掉。
const CF_LIMIT = 100000, CF_LEVELS = [[0.75, 'warn'], [0.9, 'danger']];
const cfAlert = (...args) => execFile(process.execPath, [path.join(__dirname, 'alert.cjs'), ...args], () => {});
let cf = { day: '', workers: {} };
try { cf = JSON.parse(fs.readFileSync(CF_FILE, 'utf8')); } catch {}
if (!cf.workers) cf = { day: cf.day || '', workers: {} };
let cfDirty = false;
// Per-path tally (query dropped, ids folded to :id) to see which poller drives the count.
const pathKey = (u) => String(u || '').split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}|\b[0-9a-f]{16,}\b|\b\d+\b/gi, ':id').slice(0, 120);
function countRequest(req) {
  const day = new Date().toISOString().slice(0, 10);
  if (cf.day !== day) { cf = { day, workers: {} }; cfAlert('resolve', 'cf-requests-', '--by', '隔天自動'); }
  // cf-worker only says trycloudflare.com for both; the page address in Origin/Referer tells them apart. No page address =
  // the remote agents' curl/PowerShell, which only use tasui.
  const page = /^https?:\/\/([^/]+)/.exec(String(req.headers.origin || req.headers.referer || ''));
  const name = page ? page[1].slice(0, 60) : '無來源頁（遠端代理程式，走 tasui）';
  const w = cf.workers[name] || (cf.workers[name] = { count: 0, paths: {} });
  w.count++; cfDirty = true;
  const p = (req.headers.upgrade ? 'WS ' : req.method + ' ') + pathKey(req.url);
  w.paths[p] = (w.paths[p] || 0) + 1;
  for (const [share, level] of CF_LEVELS) {
    if (w.count !== Math.round(CF_LIMIT * share)) continue;
    const pct = Math.round(share * 100);
    cfAlert('add', level, 'Cloudflare 今日請求已過 ' + pct + '%（' + name + '）',
      `UTC ${day}（台灣 08:00 起算）${name} 已轉發 ${w.count} 個請求，免費額度每帳號每日 ${CF_LIMIT}。到上限時經過它的連線會斷到隔天 08:00。隔天 08:00 這則會自動收掉。`,
      '--source', 'seal-proxy', '--key', 'cf-requests-' + pct + '-' + name + '-' + day);
  }
}
setInterval(() => { if (cfDirty) { cfDirty = false; try { fs.writeFileSync(CF_FILE, JSON.stringify(cf)); } catch {} } }, 60000);

const server = http.createServer((req, res) => {
  if (!sealed(req)) { res.writeHead(403); res.end('forbidden (no edge seal)'); return; }
  countRequest(req);
  if (req.url === '/_usage' && req.method === 'GET') return serveUsage(res);
  const up = http.request({ host: '127.0.0.1', port: TARGET, method: req.method, path: req.url, headers: strip(req.headers) }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502); res.end('upstream error: ' + e.message);
  });
  res.on('close', () => up.destroy());
  req.pipe(up);
});

server.on('upgrade', (req, socket, head) => {
  if (!sealed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  countRequest(req);
  const up = net.connect(TARGET, '127.0.0.1', () => {
    const headers = strip(req.headers);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) raw += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
    up.write(raw + '\r\n');
    if (head && head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(LISTEN, '127.0.0.1', () => console.log(`seal-proxy: 127.0.0.1:${LISTEN} -> 127.0.0.1:${TARGET} (sealed)`));
