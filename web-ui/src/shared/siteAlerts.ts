import { useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

/**
 * DHC CLI 10/14 警示: one quiet list of things someone should look at — a prompt-injection attempt, an attack on the
 * login gate, a channel or key about to expire. One list for the whole site, in user_preferences under the global
 * key `dhc.alerts`, so whoever handles an alert clears it for everyone. Host scripts add alerts through the same
 * preferences API. A resolved alert stays in the list, marked, until it ages out.
 */
export type AlertLevel = 'info' | 'warn' | 'danger';

export type SiteAlert = {
  id: string;
  level: AlertLevel;
  title: string;
  detail: string;
  source: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  /** Dedupe key set by the script that raised the alert; kept so a save from the page does not drop it. */
  key?: string;
};

const KEY = 'dhc.alerts';
const RELOAD_MS = 120_000;
const EMPTY: SiteAlert[] = [];
const LEVELS: AlertLevel[] = ['info', 'warn', 'danger'];

export function parseSiteAlerts(value: unknown): SiteAlert[] {
  const raw = value && typeof value === 'object' ? (value as { items?: unknown }).items : null;
  if (!Array.isArray(raw)) return EMPTY;
  return raw.filter((item): item is SiteAlert => (
    Boolean(item) && typeof (item as SiteAlert).id === 'string' && typeof (item as SiteAlert).title === 'string'
  )).map((item) => ({
    id: item.id,
    level: LEVELS.includes(item.level) ? item.level : 'warn',
    title: item.title,
    detail: typeof item.detail === 'string' ? item.detail : '',
    source: typeof item.source === 'string' ? item.source : '',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    ...(typeof item.resolvedAt === 'string' ? { resolvedAt: item.resolvedAt } : {}),
    ...(typeof item.resolvedBy === 'string' ? { resolvedBy: item.resolvedBy } : {}),
    ...(typeof item.key === 'string' ? { key: item.key } : {}),
  }));
}

let alerts: SiteAlert[] = EMPTY;
let writesInFlight = 0;
let writeChain: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

async function fetchServerAlerts(): Promise<SiteAlert[]> {
  const response = await api.user.preferences();
  if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
  const payload = (await response.json()) as { preferences?: Record<string, unknown> };
  return parseSiteAlerts(payload.preferences?.[KEY]);
}

async function loadSiteAlerts(): Promise<void> {
  try {
    const next = await fetchServerAlerts();
    if (writesInFlight > 0) return;
    alerts = next;
    notify();
  } catch (error) {
    console.error('[SiteAlerts] Failed to load alerts:', error);
  }
}

/** Loads now, every two minutes, and when the tab comes back into view; returns the cleanup. */
export function startSiteAlertsSync(): () => void {
  void loadSiteAlerts();
  const timer = setInterval(() => void loadSiteAlerts(), RELOAD_MS);
  const reloadWhenVisible = () => {
    if (document.visibilityState === 'visible') void loadSiteAlerts();
  };
  document.addEventListener('visibilitychange', reloadWhenVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', reloadWhenVisible);
  };
}

function updateSiteAlerts(change: (current: SiteAlert[]) => SiteAlert[]): void {
  alerts = change(alerts);
  notify();
  writesInFlight += 1;
  writeChain = writeChain.then(async () => {
    try {
      const next = change(await fetchServerAlerts());
      const response = await api.user.savePreferences({ [KEY]: { items: next } });
      if (!response.ok) throw new Error(`Failed to save alerts (${response.status})`);
      if (writesInFlight === 1) {
        alerts = next;
        notify();
      }
    } catch (error) {
      console.error('[SiteAlerts] Failed to save alerts:', error);
      alert('警示狀態沒有存到伺服器，請重新整理頁面後再試一次。');
    } finally {
      writesInFlight -= 1;
    }
  });
}

export function useSiteAlerts(): SiteAlert[] {
  return useSyncExternalStore(subscribe, () => alerts, () => EMPTY);
}

export function resolveSiteAlert(id: string, by: string): void {
  const resolvedAt = new Date().toISOString();
  updateSiteAlerts((current) => current.map((item) => (
    item.id === id && !item.resolvedAt ? { ...item, resolvedAt, ...(by ? { resolvedBy: by } : {}) } : item
  )));
}
