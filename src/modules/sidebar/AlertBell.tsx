import { useEffect, useRef, useState } from 'react';
import { Check, ShieldAlert } from 'lucide-react';

import { readActiveSettingsProfile } from '@/shared/userSettings';
import { resolveSiteAlert, startSiteAlertsSync, useSiteAlerts } from '@/shared/siteAlerts';
import type { AlertLevel, SiteAlert } from '@/shared/siteAlerts';
import { cn } from '@/shared/utils';
import { authenticatedFetch } from '@/shared/api';

// DHC CLI 10/14 警示: a quiet button next to refresh / new project. Grey when nothing is open; a small dot when
// something is. Besides the stored list (src/shared/siteAlerts.ts) it shows the host's Claude login running out,
// read from the usage endpoint; that one clears itself once someone logs in again.

type LoginInfo = { state: 'ok' | 'expiring' | 'expired' | 'logged_out'; expires_at?: string; days_left?: number; long_token?: boolean };

const LOGIN_POLL_MS = 300_000;
const SHOWN_RESOLVED = 8;
const POPOVER_WIDTH = 288;

const DOT: Record<AlertLevel, string> = { info: 'bg-sky-500', warn: 'bg-amber-500', danger: 'bg-red-500' };

function loginAlert(login: LoginInfo | null): SiteAlert | null {
  if (!login || login.state === 'ok') return null;
  const day = login.expires_at ? new Date(login.expires_at).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' }) : '';
  const expiring = login.state === 'expiring';
  return {
    id: 'live:claude-login',
    level: expiring ? 'warn' : 'danger',
    title: expiring ? `Claude 登入 ${login.days_left ?? ''} 天後到期` : 'Claude 登入已過期',
    detail: `${day ? `到期日 ${day}。` : ''}在主機上重新登入 Claude（執行 claude 後輸入 /login）後這則會自己消失。`,
    source: '主機',
    createdAt: '',
  };
}

function when(iso: string): string {
  const time = new Date(iso);
  if (!iso || Number.isNaN(time.getTime())) return '';
  return time.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function AlertRow({ item, onResolve }: { item: SiteAlert; onResolve?: () => void }) {
  return (
    <li className={cn('flex items-start gap-2 px-3 py-2', item.resolvedAt && 'opacity-50')}>
      <span className={cn('mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full', item.resolvedAt ? 'bg-muted-foreground/40' : DOT[item.level])} />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground">{item.title}</div>
        {item.detail && <div className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-snug text-muted-foreground">{item.detail}</div>}
        <div className="mt-0.5 text-[10px] text-muted-foreground/60">
          {[item.source, when(item.createdAt)].filter(Boolean).join(' · ')}
          {item.resolvedAt && ` · ${item.resolvedBy ? `${item.resolvedBy} ` : ''}${when(item.resolvedAt)} 已處理`}
        </div>
      </div>
      {onResolve && (
        <button
          onClick={onResolve}
          title="標記為已處理（所有人都會看到）"
          className="flex flex-shrink-0 items-center gap-0.5 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Check className="h-3 w-3" />
          已處理
        </button>
      )}
    </li>
  );
}

export default function AlertBell({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const stored = useSiteAlerts();
  const [login, setLogin] = useState<LoginInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [spot, setSpot] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => startSiteAlertsSync(), []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await authenticatedFetch('/api/dhc/usage', { cache: 'no-store' });
        const payload = (await response.json()) as { login?: LoginInfo };
        if (alive && payload.login) setLogin(payload.login);
      } catch {
        // No proxy, no login alert; the stored list still works.
      }
    };
    void load();
    const timer = setInterval(load, LOGIN_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const live = loginAlert(login);
  const openAlerts = [...(live ? [live] : []), ...stored.filter((item) => !item.resolvedAt)];
  const resolved = stored.filter((item) => item.resolvedAt)
    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))
    .slice(0, SHOWN_RESOLVED);
  const worst: AlertLevel | null = openAlerts.some((item) => item.level === 'danger')
    ? 'danger'
    : openAlerts.some((item) => item.level === 'warn') ? 'warn' : openAlerts.length ? 'info' : null;

  const resolve = (id: string) => resolveSiteAlert(id, readActiveSettingsProfile()?.name ?? '');

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={(event) => {
          // Fixed to the viewport so the narrow sidebar does not clip it; kept on screen on phones.
          const rect = event.currentTarget.getBoundingClientRect();
          setSpot({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - 8)) });
          setOpen((value) => !value);
        }}
        title={openAlerts.length ? `警示：${openAlerts.length} 則待處理` : '警示：目前沒有'}
        aria-label="警示"
        className={cn(
          'relative flex items-center justify-center rounded-lg transition-all',
          size === 'md' ? 'h-8 w-8 bg-muted/50 active:scale-95' : 'h-7 w-7 hover:bg-accent/80',
          worst ? 'text-muted-foreground' : 'text-muted-foreground/50',
        )}
      >
        <ShieldAlert className={size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
        {worst && <span className={cn('absolute right-1 top-1 h-1.5 w-1.5 rounded-full ring-1 ring-background', DOT[worst])} />}
      </button>
      {open && (
        <div style={{ top: spot.top, left: spot.left, width: POPOVER_WIDTH }} className="fixed z-50 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
          <div className="border-b border-border/60 px-3 py-2 text-xs font-medium text-foreground">警示</div>
          <div className="max-h-80 overflow-y-auto">
            {openAlerts.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-muted-foreground">目前沒有待處理的警示。</div>
            ) : (
              <ul className="divide-y divide-border/40">
                {openAlerts.map((item) => (
                  <AlertRow key={item.id} item={item} onResolve={item.id.startsWith('live:') ? undefined : () => resolve(item.id)} />
                ))}
              </ul>
            )}
            {resolved.length > 0 && (
              <>
                <div className="border-t border-border/60 px-3 pb-1 pt-2 text-[10px] text-muted-foreground/60">最近已處理</div>
                <ul className="divide-y divide-border/40">
                  {resolved.map((item) => <AlertRow key={item.id} item={item} />)}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
