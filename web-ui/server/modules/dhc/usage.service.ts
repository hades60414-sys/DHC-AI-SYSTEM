import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude subscription usage (5-hour / weekly / weekly per-model) for the sidebar meters, the same numbers
 * Claude Code's /usage shows. Reads the OAuth token Claude Code keeps in ~/.claude/.credentials.json and
 * sends it only to Anthropic; the browser gets the percentages, never the token.
 *
 * Cadence: a background timer asks Anthropic every 2 minutes while someone is looking (a request in the
 * last 15 minutes), backs off 5 minutes after a 429, and serves the last good numbers (stale: true) in
 * between. The last good payload is saved next to the database so a restart does not blank the panel.
 * The token file is only read: an expired token is reported, and Claude Code refreshes it itself.
 */
export type UsageBucket = { percent: number; resets_at: string | null; severity?: string } | null;
export type LoginInfo = { state: 'ok' | 'expiring' | 'expired' | 'logged_out'; expires_at?: string; days_left?: number };
export type UsageData = { session: UsageBucket; weekly_all: UsageBucket; weekly_fable: UsageBucket; fetched_at: string };
export type UsagePayload = Partial<UsageData> & { error?: string; stale?: boolean; reason?: string; login: LoginInfo };

type OauthRecord = { accessToken?: string; refreshToken?: string; expiresAt?: number; refreshTokenExpiresAt?: number };
type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REFRESH_MS = 2 * 60_000;
const BACKOFF_429_MS = 5 * 60_000;
const IDLE_MS = 15 * 60_000;
const TICK_MS = 10_000;
const LOGIN_WARN_DAYS = 7;

export type UsageServiceOptions = {
  credentialsFile?: string;
  cacheFile?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
};

function readOauth(file: string): OauthRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { claudeAiOauth?: OauthRecord };
    return parsed.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

export function loginInfoOf(oauth: OauthRecord | null, now: number): LoginInfo {
  if (!oauth || (!oauth.refreshToken && !oauth.accessToken)) return { state: 'logged_out' };
  const until = oauth.refreshTokenExpiresAt;
  if (typeof until !== 'number' || !(until > 0)) return { state: 'ok' };
  const days = Math.ceil((until - now) / 86_400_000);
  return { state: days <= 0 ? 'expired' : days <= LOGIN_WARN_DAYS ? 'expiring' : 'ok', expires_at: new Date(until).toISOString(), days_left: days };
}

type Limit = { kind?: string; percent?: number; resets_at?: string | null; severity?: string; scope?: { model?: { display_name?: string } } };
type Window = { utilization?: number; resets_at?: string | null };

/** Maps Anthropic's usage response (newer `limits` list or older five_hour / seven_day fields) to the sidebar shape. */
export function parseUsageResponse(body: unknown, now: number): UsageData {
  const j = (body ?? {}) as { limits?: Limit[]; five_hour?: Window; seven_day?: Window };
  const limits = Array.isArray(j.limits) ? j.limits : [];
  const pick = (match: (limit: Limit) => boolean): UsageBucket => {
    const limit = limits.find(match);
    return limit ? { percent: Number(limit.percent ?? 0), resets_at: limit.resets_at ?? null, severity: limit.severity } : null;
  };
  const fromWindow = (w: Window | undefined): UsageBucket => (w ? { percent: Number(w.utilization ?? 0), resets_at: w.resets_at ?? null } : null);
  return {
    session: pick((l) => l.kind === 'session') ?? fromWindow(j.five_hour),
    weekly_all: pick((l) => l.kind === 'weekly_all') ?? fromWindow(j.seven_day),
    weekly_fable: pick((l) => l.kind === 'weekly_scoped' && /fable/i.test(l.scope?.model?.display_name ?? '')),
    fetched_at: new Date(now).toISOString(),
  };
}

export function createUsageService(options: UsageServiceOptions = {}) {
  const credentialsFile = options.credentialsFile ?? path.join(os.homedir(), '.claude', '.credentials.json');
  const cacheFile = options.cacheFile
    ?? path.join(path.dirname(process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli', 'auth.db')), 'dhc-usage-cache.json');
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;

  let lastGood: UsageData | null = null;
  let lastError: string | null = null;
  let nextFetchAt = 0;
  let lastAskedAt = 0;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  try {
    lastGood = JSON.parse(readFileSync(cacheFile, 'utf8')) as UsageData;
  } catch {
    lastGood = null;
  }

  async function fetchOnce(): Promise<UsageData | { error: string }> {
    const oauth = readOauth(credentialsFile);
    if (!oauth?.accessToken) return { error: 'not_logged_in' };
    if (oauth.expiresAt && now() > oauth.expiresAt - 60_000) return { error: 'token_expired' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'dhc-cli-usage' },
        signal: controller.signal,
      });
      if (response.status !== 200) return { error: `upstream_${response.status}` };
      return parseUsageResponse(await response.json(), now());
    } catch (error) {
      return { error: (error as Error).name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** One upstream call at a time, only on the cadence and only while someone is looking. */
  function refresh(force = false): Promise<void> {
    if (inFlight) return inFlight;
    const t = now();
    if (!force && (t < nextFetchAt || t - lastAskedAt > IDLE_MS)) return Promise.resolve();
    inFlight = fetchOnce().then((data) => {
      if ('error' in data) {
        lastError = data.error;
        nextFetchAt = now() + (data.error === 'upstream_429' ? BACKOFF_429_MS : REFRESH_MS);
      } else {
        lastGood = data;
        lastError = null;
        nextFetchAt = now() + REFRESH_MS;
        try {
          writeFileSync(cacheFile, JSON.stringify(data));
        } catch {
          // The cache only saves a blank panel after a restart; losing it is harmless.
        }
      }
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /** What GET /api/dhc/usage returns. The first call waits for one fetch so a fresh server has numbers. */
  async function read(): Promise<UsagePayload> {
    lastAskedAt = now();
    if (!lastGood && !lastError) await refresh(true);
    else void refresh();
    const login = loginInfoOf(readOauth(credentialsFile), now());
    if (!lastGood) return { error: lastError ?? 'loading', login };
    const fresh = lastError === null && now() - new Date(lastGood.fetched_at).getTime() < 2 * REFRESH_MS;
    return fresh ? { ...lastGood, login } : { ...lastGood, stale: true, reason: lastError ?? 'refreshing', login };
  }

  function start(): void {
    if (!timer) {
      timer = setInterval(() => void refresh(), TICK_MS);
      timer.unref();
    }
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { read, refresh, start, stop };
}

export type UsageService = ReturnType<typeof createUsageService>;
