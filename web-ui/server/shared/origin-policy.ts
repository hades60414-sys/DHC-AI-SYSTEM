/**
 * DHC security audit 2026-11-04 (SEC-WEB-01): cross-origin request guard.
 *
 * The API authenticates with a bearer token (not cookies), so the classic
 * CSRF defence of "the browser won't attach credentials" does not protect the
 * endpoints that need no token: `/api/auth/register` on a fresh install and
 * `/api/auth/login`. With `cors()` defaulting to `Access-Control-Allow-Origin: *`
 * any web page the user visits could register the first account, read the
 * returned JWT and open `/shell` — remote code execution from a drive-by page.
 *
 * Policy (applies only when the request carries an `Origin` header, i.e. it
 * comes from a browser; CLI clients such as curl, the Electron main process
 * and node `ws` send none and are unaffected):
 *   - loopback origins (localhost / 127.0.0.0/8 / [::1]) on any port: allowed
 *     (the Vite dev server and the desktop app live there);
 *   - same-origin (Origin host:port === Host header): allowed (LAN or tunnel
 *     deployments served from the server itself);
 *   - origins listed in `DHC_ALLOWED_ORIGINS` (comma-separated, exact
 *     `scheme://host[:port]`): allowed;
 *   - everything else, including the opaque `null` origin: rejected.
 */
import type { RequestHandler } from 'express';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '[::1]', '::1']);

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(h) || h.endsWith('.localhost')) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

export function parseAllowedOrigins(raw: string | undefined = process.env.DHC_ALLOWED_ORIGINS): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      out.add(new URL(trimmed).origin.toLowerCase());
    } catch {
      // Ignore malformed entries rather than widening the policy.
    }
  }
  return out;
}

/**
 * Returns true when a request with this Origin/Host pair may be served.
 * `origin` undefined means "not a browser cross-origin request".
 */
export function isOriginAllowed(
  origin: string | undefined | null,
  hostHeader: string | undefined | null,
  allowed: Set<string> = parseAllowedOrigins(),
): boolean {
  if (origin === undefined || origin === null || origin === '') return true;
  if (origin === 'null') return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  if (isLoopbackHostname(parsed.hostname)) return true;
  if (allowed.has(parsed.origin.toLowerCase())) return true;
  if (hostHeader && parsed.host.toLowerCase() === hostHeader.trim().toLowerCase()) return true;
  return false;
}

/**
 * Express middleware: rejects browser requests from foreign origins with 403
 * before any route (including the unauthenticated auth routes) runs.
 */
export function createOriginGuard(allowed: Set<string> = parseAllowedOrigins()): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (isOriginAllowed(origin, req.headers.host, allowed)) {
      next();
      return;
    }
    console.warn('[SECURITY] Rejected cross-origin request from', origin, 'to', req.method, req.path);
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin request rejected' },
    });
  };
}

/**
 * DHC security audit 2026-11-04 (SEC-WEB-02): `VITE_IS_PLATFORM=true` makes
 * every REST and WebSocket request run as the first DB user with no token.
 * That is only acceptable when nothing but this machine (or an authenticating
 * reverse proxy) can reach the port. Returns an error message when the
 * combination is unsafe, or null when startup may proceed.
 *
 * Override for a deliberate authenticating-proxy deployment:
 *   DHC_PLATFORM_TRUSTED_PROXY=1
 */
export function checkPlatformModeBinding(
  isPlatform: boolean,
  bindHost: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isPlatform) return null;
  const host = bindHost.trim().replace(/^\[|\]$/g, '');
  if (isLoopbackHostname(host)) return null;
  if (env.DHC_PLATFORM_TRUSTED_PROXY === '1') return null;
  return (
    `Refusing to start: VITE_IS_PLATFORM=true disables authentication, but HOST=${bindHost} ` +
    'is reachable from other machines. Bind to 127.0.0.1, unset VITE_IS_PLATFORM, or set ' +
    'DHC_PLATFORM_TRUSTED_PROXY=1 if an authenticating reverse proxy is the only way in.'
  );
}
