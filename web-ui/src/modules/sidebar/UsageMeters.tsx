import { useEffect, useState } from 'react';
import { AlertTriangle, Gauge } from 'lucide-react';

import { authenticatedFetch } from '@/shared/api';

// DHC CLI addition: Claude subscription usage meters (mirrors Claude Code's /usage).
// Data comes from the server (GET /api/dhc/usage, refreshed every 2 minutes), which calls Anthropic's OAuth usage API.

type Bucket = { percent: number; resets_at: string | null; severity?: string } | null;
type LoginInfo = { state: 'ok' | 'expiring' | 'expired' | 'logged_out'; expires_at?: string; days_left?: number; long_token?: boolean };
type UsagePayload = { session?: Bucket; weekly_all?: Bucket; weekly_fable?: Bucket; fetched_at?: string; error?: string; stale?: boolean; reason?: string; login?: LoginInfo };

// Readable reasons for GET /api/dhc/usage errors; anything else is shown as its code.
const USAGE_ERRORS: Record<string, string> = {
  not_logged_in: '這台主機還沒登入 Claude',
  token_expired: '登入權杖已過期，用一次 Claude Code 就會更新',
  upstream_429: '查詢太頻繁，5 分鐘後再試',
  network: '連不到伺服器',
  timeout: '查詢逾時',
};
const POLL_MS = 120_000; // server refreshes upstream on its own cadence; this only re-reads the cache

function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '即將重置';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  const parts = d > 0 ? `${d}天${h}小時` : h > 0 ? `${h}小時${mm}分` : `${mm}分`;
  const at = new Date(iso);
  const clock = `${String(at.getMonth() + 1).padStart(2, '0')}/${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `${parts}後重置（${clock}）`;
}

function barColor(p: number): string {
  if (p >= 90) return 'bg-red-500';
  if (p >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function clockOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  return `${String(at.getMonth() + 1).padStart(2, '0')}/${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

function Meter({ label, bucket, now, stale }: { label: string; bucket: Bucket; now: number; stale: boolean }) {
  if (!bucket) return null;
  const p = Math.max(0, Math.min(100, Math.round(bucket.percent ?? 0)));
  // 2026-09-21: old numbers whose window has already reset were shown as if current ("Fable 100%", "即將重置"
  // a day after the fact). A stale bucket past its reset is unknown, not full — say so and draw nothing.
  const resetPassed = Boolean(bucket.resets_at) && new Date(bucket.resets_at as string).getTime() <= now;
  if (stale && resetPassed) {
    return (
      <div className="space-y-0.5" title={`上次拿到的數字已在 ${clockOf(bucket.resets_at)} 重置，新數字要等用量 API 恢復`}>
        <div className="flex items-center justify-between text-[11px] leading-tight">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium text-muted-foreground/60">—</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" />
        <div className="truncate text-[10px] leading-tight text-muted-foreground/80">已重置，數字待更新</div>
      </div>
    );
  }
  return (
    <div className="space-y-0.5" title={relTime(bucket.resets_at, now)}>
      <div className="flex items-center justify-between text-[11px] leading-tight">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-medium ${stale ? 'text-muted-foreground/70' : p >= 90 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>{p}%{stale ? '（舊）' : ''}</span>
      </div>
      <div className={`h-1.5 w-full overflow-hidden rounded-full bg-muted ${stale ? 'opacity-50' : ''}`}>
        <div className={`h-full rounded-full ${barColor(p)}`} style={{ width: `${p}%` }} />
      </div>
      <div className="truncate text-[10px] leading-tight text-muted-foreground/80">{relTime(bucket.resets_at, now)}</div>
    </div>
  );
}

// 2026-10-12: the Claude login on the host runs out about every 30 days; once it does no conversation gets a reply.
// The usage endpoint reports the remaining days so this can warn a week ahead instead of people finding out by failing.
function LoginWarning({ login }: { login: LoginInfo | null }) {
  if (!login || login.state === 'ok') return null;
  const dead = login.state !== 'expiring';
  // With the one-year token in place the conversations keep working; only the usage numbers stop.
  const effect = login.long_token ? '用量數字會停止更新（對話不受影響）' : '對話不會有回覆';
  return (
    <div
      className={`mx-3 mt-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11px] leading-snug ${dead && !login.long_token ? 'border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-300' : 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <span>
        {dead
          ? `Claude 登入已失效，${effect}。請通知管理者在主機重新登入。`
          : `Claude 登入 ${login.days_left} 天後到期（${clockOf(login.expires_at)}），到期後${effect}。請通知管理者在主機重新登入。`}
      </span>
    </div>
  );
}

/** Rendered by SidebarFooter (desktop) above the settings row. */
export default function UsageMeters() {
  const [data, setData] = useState<UsagePayload | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [login, setLogin] = useState<LoginInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await authenticatedFetch('/api/dhc/usage', { cache: 'no-store' });
        const j = (await r.json()) as UsagePayload;
        if (alive && j.login) setLogin(j.login);
        // Keep the last good numbers on screen; only surface an error if we never had data.
        if (alive) setData((prev) => (j.error && prev && !prev.error ? { ...prev, stale: true } : j));
      } catch {
        if (alive) setData((prev) => (prev && !prev.error ? { ...prev, stale: true } : { error: 'network' }));
      }
    };
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { alive = false; clearInterval(poll); clearInterval(tick); };
  }, []);

  if (!data) return null;
  if (data.error) {
    return (
      <>
        <LoginWarning login={login} />
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground/70">
          <Gauge className="mr-1 inline h-3 w-3" />用量：無法取得（{USAGE_ERRORS[data.error] ?? data.error}）
        </div>
      </>
    );
  }
  return (
    <>
    <LoginWarning login={login} />
    <div className="space-y-2 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
        <Gauge className="h-3.5 w-3.5 text-primary" />
        Claude 用量
        {data.stale && (
          <span
            className="ml-auto text-[10px] font-normal text-amber-600 dark:text-amber-400"
            title={`用量 API 目前拿不到新數字（${data.reason ?? '連線中'}），下面是 ${clockOf(data.fetched_at)} 的資料`}
          >
            舊資料 {clockOf(data.fetched_at)}
          </span>
        )}
      </div>
      <Meter label="目前時段（5 小時）" bucket={data.session ?? null} now={now} stale={Boolean(data.stale)} />
      <Meter label="本週（全部模型）" bucket={data.weekly_all ?? null} now={now} stale={Boolean(data.stale)} />
      <Meter label="本週（Fable）" bucket={data.weekly_fable ?? null} now={now} stale={Boolean(data.stale)} />
    </div>
    </>
  );
}
