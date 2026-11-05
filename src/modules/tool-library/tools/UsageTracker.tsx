import { useEffect, useRef, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';

import type { ToolProps } from '@/modules/tool-library/catalog';
import ToolFrame from '@/modules/tool-library/ToolFrame';
import { authenticatedFetch } from '@/shared/api';
import { cn } from '@/shared/utils';

// DHC CLI 10/27 用量追蹤: the shared Claude subscription by window (目前 5 小時／本週／今天), split by person, by
// 對話 vs 排程與系統, and the sessions that spent the most. Official percentages come from the usage API;
// who-spent-what comes from /_usage/top, served by an optional transcript scanner on this host.

type Kind = '對話' | '排程與系統';
type Row = { id: string; title: string; person: string; kind: Kind; where: string; w: number; n: number; share: number; sub_share: number; maxctx: number; last: string; model: string };
type Person = { person: string; w: number; n: number; sessions: number; share: number; 對話: number; 排程與系統: number };
type Win = {
  start: string; end: string; percent: number | null; edge_from: 'oauth' | 'rolling' | 'local';
  total: { w: number; n: number; sessions: number; cr: number; cw: number; out: number };
  by_person: Person[]; by_kind: { kind: Kind; w: number; n: number; sessions: number; share: number }[];
  top: Row[]; series?: { t: string; 對話: number; 排程與系統: number }[]; last_hour_w?: number;
};
type TopPayload = { generated_at?: string; weights?: string; windows?: Record<'session' | 'week' | 'today', Win>; error?: string };
type Bucket = { percent: number; resets_at: string | null } | null;
type UsagePayload = { session?: Bucket; weekly_all?: Bucket; error?: string };

const TABS = [['session', '目前 5 小時'], ['week', '本週'], ['today', '今天']] as const;
type Tab = (typeof TABS)[number][0];
const KIND_COLOR: Record<Kind, string> = { 對話: 'bg-sky-500', 排程與系統: 'bg-violet-500' };
const POLL_MS = 120_000;

const clock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const pct = (v: number) => `${(v * 100).toFixed(v >= 0.1 ? 0 : 1)}%`;
const kTok = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}k`);

/**
 * At the last hour's pace, when does the 5-hour window hit 100%? Uses the window's own ratio of official percent to
 * weighted tokens, so it is only as good as "this hour looks like the rest of the window".
 */
export function paceNote(win: Win | undefined, now: number): string | null {
  if (!win || win.percent == null || !win.total.w || !win.last_hour_w) return null;
  const perHour = (win.percent / win.total.w) * win.last_hour_w;
  if (perHour <= 0.5) return '最近一小時幾乎沒用';
  const hitAt = now + ((100 - win.percent) / perHour) * 3_600_000;
  const resetAt = new Date(win.end).getTime();
  return hitAt >= resetAt
    ? `照最近一小時的速度（每小時約 ${perHour.toFixed(0)}%），撐得到 ${clock(win.end)} 重置`
    : `照最近一小時的速度（每小時約 ${perHour.toFixed(0)}%），約 ${clock(new Date(hitAt).toISOString())} 用完，比重置早 ${Math.round((resetAt - hitAt) / 60000)} 分鐘`;
}

function Bar({ share, className }: { share: number; className?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn('h-full rounded-full', className ?? 'bg-primary')} style={{ width: `${Math.max(0, Math.min(100, share * 100))}%` }} />
    </div>
  );
}

/** Every hour from the window start to now, empty hours included, so the axis is real time. */
export function fillHours(series: NonNullable<Win['series']>, start: string, now: number): NonNullable<Win['series']> {
  const byHour = new Map(series.map((e) => [new Date(e.t).getTime(), e]));
  const out: NonNullable<Win['series']> = [];
  for (let t = Math.floor(new Date(start).getTime() / 3_600_000) * 3_600_000; t <= now; t += 3_600_000) {
    out.push(byHour.get(t) ?? { t: new Date(t).toISOString(), 對話: 0, 排程與系統: 0 });
  }
  return out;
}

function Series({ series }: { series: NonNullable<Win['series']> }) {
  const max = Math.max(1, ...series.map((e) => e.對話 + e.排程與系統));
  return (
    <div className="flex h-24 items-end gap-px" role="img" aria-label="每小時用量">
      {series.map((e) => {
        const total = e.對話 + e.排程與系統;
        return (
          <div key={e.t} className="flex h-full min-w-[3px] flex-1 flex-col justify-end" title={`${clock(e.t)}　${kTok(total)}（對話 ${kTok(e.對話)}、排程與系統 ${kTok(e.排程與系統)}）`}>
            <div className={KIND_COLOR['排程與系統']} style={{ height: `${(e.排程與系統 / max) * 100}%` }} />
            <div className={KIND_COLOR['對話']} style={{ height: `${(e.對話 / max) * 100}%` }} />
          </div>
        );
      })}
    </div>
  );
}

export default function UsageTracker({ isMobile, onClose, profileName }: ToolProps) {
  const [tab, setTab] = useState<Tab>('session');
  const [top, setTop] = useState<TopPayload | null>(null);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  // 11/01: when the numbers on screen were last refreshed, set once a refresh has failed (they used to look current).
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const okAt = useRef<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const asked = Date.now();
      const getTop = () => fetch('/_usage/top', { cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error('top unavailable');
        return r.json() as Promise<TopPayload>;
      });
      let [t, u] = await Promise.all([
        getTop(),
        authenticatedFetch('/api/dhc/usage', { cache: 'no-store' }).then((r) => r.json() as Promise<UsagePayload>).catch(() => null),
      ]);
      // 10/28: the proxy hands out the last scan and starts a new one; if that one is older than this click, wait for
      // the new scan (well under a second, plus the process start) so a rename or new spending shows on 重新整理.
      if (t.generated_at && new Date(t.generated_at).getTime() < asked - 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        t = await getTop().catch(() => t);
      }
      setTop(t); setUsage(u); setNow(Date.now());
      okAt.current = Date.now();
      setStaleSince(null);
    } catch {
      setTop((prev) => prev ?? { error: 'network' });
      if (okAt.current !== null) setStaleSince(okAt.current);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => clearInterval(poll);
  }, []);

  const win = top?.windows?.[tab];
  const official = tab === 'session' ? usage?.session : tab === 'week' ? usage?.weekly_all : null;
  const pace = tab === 'session' ? paceNote(top?.windows?.session, now) : null;
  const hours = win?.series && win.series.length > 0 ? fillHours(win.series, win.start, Math.min(now, new Date(win.end).getTime())) : null;

  return (
    <ToolFrame
      icon={Gauge}
      title="用量追蹤"
      profileName={profileName}
      isMobile={isMobile}
      onClose={onClose}
      headerExtra={(
        <>
          {TABS.map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={cn('shrink-0 rounded-md px-2 py-1 text-xs', tab === id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
              {label}
            </button>
          ))}
          <button type="button" onClick={() => void load()} disabled={loading} aria-label="重新整理" className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {top?.generated_at ? `更新於 ${clock(top.generated_at).slice(6)}` : '重新整理'}
          </button>
        </>
      )}
    >
      {!top ? (
        <p className="p-6 text-sm text-muted-foreground">載入中…</p>
      ) : !win ? (
        <p className="p-6 text-sm text-muted-foreground">用量資料第一次整理要十幾秒，稍後按右上「重新整理」。（{top.error ?? '沒有資料'}）</p>
      ) : (
        <div className="mx-auto max-w-5xl space-y-5 p-4 text-sm">
          {staleSince !== null && (
            <p role="alert" className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">更新失敗，顯示的是 {clock(new Date(staleSince).toISOString()).slice(6)} 的資料</p>
          )}
          <section aria-label="總覽" className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border p-3">
              <div className="text-xs text-muted-foreground">官方額度</div>
              <div className="mt-1 text-2xl font-semibold text-foreground">{official ? `${Math.round(official.percent)}%` : '—'}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {official?.resets_at ? `${clock(official.resets_at)} 重置` : tab === 'today' ? '今天沒有官方額度，看下面的分配' : '讀不到官方數字'}
              </div>
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-xs text-muted-foreground">這段期間</div>
              <div className="mt-1 text-2xl font-semibold text-foreground">{win.total.n.toLocaleString()} 次呼叫</div>
              <div className="mt-1 text-xs text-muted-foreground">{win.total.sessions} 個對話　{clock(win.start)} – {clock(win.end)}</div>
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-xs text-muted-foreground">對話 vs 排程與系統</div>
              <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                {win.by_kind.map((k) => <div key={k.kind} className={KIND_COLOR[k.kind]} style={{ width: `${k.share * 100}%` }} title={`${k.kind} ${pct(k.share)}`} />)}
              </div>
              <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                {win.by_kind.map((k) => <div key={k.kind}><span className={cn('mr-1 inline-block h-2 w-2 rounded-full', KIND_COLOR[k.kind])} />{k.kind} {pct(k.share)}（{k.sessions} 個）</div>)}
              </div>
            </div>
          </section>
          {pace && <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-foreground">{pace}</p>}

          {hours && hours.length > 1 && (
            <section aria-label="每小時">
              <h3 className="mb-1.5 text-xs font-semibold text-foreground">每小時用量</h3>
              <Series series={hours} />
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>{clock(hours[0].t)}</span><span>{clock(hours[hours.length - 1].t)}</span></div>
            </section>
          )}

          <section aria-label="每個人">
            <h3 className="mb-1.5 text-xs font-semibold text-foreground">每個人（依專案資料夾）</h3>
            <div className="space-y-1.5">
              {win.by_person.map((p) => (
                <div key={p.person} className="grid grid-cols-[7rem_1fr_9rem] items-center gap-2 text-xs">
                  <span className="truncate text-foreground" title={p.person}>{p.person}</span>
                  <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" title={`對話 ${pct(p.對話 / (p.w || 1))}、排程與系統 ${pct(p.排程與系統 / (p.w || 1))}`}>
                    <div className={KIND_COLOR['對話']} style={{ width: `${(p.對話 / (win.total.w || 1)) * 100}%` }} />
                    <div className={KIND_COLOR['排程與系統']} style={{ width: `${(p.排程與系統 / (win.total.w || 1)) * 100}%` }} />
                  </div>
                  <span className="text-right text-muted-foreground">{pct(p.share)}　{p.sessions} 個・{p.n} 次</span>
                </div>
              ))}
            </div>
          </section>

          <section aria-label="最燒的對話">
            <h3 className="mb-1.5 text-xs font-semibold text-foreground">最燒的對話</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-1 pr-2 font-normal">對話</th><th className="px-2 font-normal">誰</th><th className="px-2 font-normal">占比</th>
                    <th className="px-2 font-normal">呼叫</th><th className="px-2 font-normal" title="這段期間單次送出的最大上下文">最大上下文</th><th className="px-2 font-normal">最後動作</th>
                  </tr>
                </thead>
                <tbody>
                  {win.top.slice(0, 20).map((r) => (
                    <tr key={r.id} className="border-b border-border/50 align-top">
                      <td className="max-w-[22rem] py-1.5 pr-2">
                        <div className="truncate text-foreground" title={`${r.title}\n${r.where}\n${r.id}`}>
                          <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', KIND_COLOR[r.kind])} title={r.kind} />{r.title}
                        </div>
                        <div className="text-[10px] text-muted-foreground">{r.model}{r.sub_share >= 0.05 ? `・子代理 ${pct(r.sub_share)}` : ''}</div>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.person}</td>
                      <td className="w-28 px-2 py-1.5"><div className="mb-0.5 text-foreground">{pct(r.share)}</div><Bar share={r.share} className={KIND_COLOR[r.kind]} /></td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.n}</td>
                      <td className={cn('px-2 py-1.5', r.maxctx >= 400_000 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground')} title={r.maxctx >= 400_000 ? '上下文很大：每次呼叫都重送整包，考慮 /compact 或開新對話' : undefined}>{kTok(r.maxctx)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">{clock(r.last)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p data-tutorial className="text-[11px] leading-relaxed text-muted-foreground">
            占比＝這段期間的等效用量（{top.weights}；同一模型內的相對值，不是金額）。來源是主機上的對話紀錄，子代理算進它的主對話；
            claude.ai、手機和不留紀錄的呼叫不在這裡，所以加總可能比官方百分比少。{win.edge_from === 'rolling' && '官方重置時間讀不到，這裡用往回推的時間。'}
          </p>
        </div>
      )}
    </ToolFrame>
  );
}
