import { useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

/**
 * DHC CLI 10/14 工具庫 小工具工坊: 「大家的工具」, one list for the whole site in user_preferences under the global
 * key `dhc.sharedTools`. A save re-reads the server's copy first (like featureWishes), so a tool shared from
 * another device stays. Each item is a copy: later edits to the author's own tool do not change it.
 */
export type SharedTool = {
  id: string;
  name: string;
  html: string;
  author: string;
  sharedAt: string;
};

const KEY = 'dhc.sharedTools';
export const MAX_SHARED_HTML = 200 * 1024;
export const MAX_SHARED_TOOLS = 100;
const MAX_NAME_LENGTH = 60;
const MAX_AUTHOR_LENGTH = 30;
const RELOAD_ON_FOCUS_MIN_MS = 30_000;
const EMPTY: SharedTool[] = [];

export function parseSharedTools(value: unknown): SharedTool[] {
  const raw = value && typeof value === 'object' ? (value as { items?: unknown }).items : null;
  if (!Array.isArray(raw)) return EMPTY;
  return raw.filter((item): item is SharedTool => (
    Boolean(item) && typeof (item as SharedTool).id === 'string' && typeof (item as SharedTool).html === 'string'
  )).map((item) => ({
    id: item.id,
    name: typeof item.name === 'string' ? item.name : '',
    html: item.html,
    author: typeof item.author === 'string' ? item.author : '',
    sharedAt: typeof item.sharedAt === 'string' ? item.sharedAt : '',
  }));
}

let tools: SharedTool[] = EMPTY;
let writesInFlight = 0;
let writeChain: Promise<void> = Promise.resolve();
let lastLoadAt = 0;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

async function fetchServerTools(): Promise<SharedTool[]> {
  const response = await api.user.preferences();
  if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
  const payload = (await response.json()) as { preferences?: Record<string, unknown> };
  return parseSharedTools(payload.preferences?.[KEY]);
}

export async function loadSharedTools(): Promise<void> {
  lastLoadAt = Date.now();
  try {
    const next = await fetchServerTools();
    if (writesInFlight > 0) return;
    tools = next;
    notify();
  } catch (error) {
    console.error('[SharedTools] Failed to load:', error);
  }
}

/** Loads the list now and whenever the tab comes back into view; returns the cleanup. */
export function startSharedToolsSync(): () => void {
  void loadSharedTools();
  const reloadWhenVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadAt > RELOAD_ON_FOCUS_MIN_MS) {
      void loadSharedTools();
    }
  };
  document.addEventListener('visibilitychange', reloadWhenVisible);
  return () => document.removeEventListener('visibilitychange', reloadWhenVisible);
}

/** Newest first, capped. */
export const capSharedTools = (list: SharedTool[]) => list.slice(0, MAX_SHARED_TOOLS);

function updateSharedTools(change: (current: SharedTool[]) => SharedTool[]): Promise<boolean> {
  tools = change(tools);
  notify();
  writesInFlight += 1;
  const write = writeChain.then(async () => {
    try {
      const next = change(await fetchServerTools());
      const response = await api.user.savePreferences({ [KEY]: { items: next } });
      if (!response.ok) throw new Error(`Failed to save shared tools (${response.status})`);
      if (writesInFlight === 1) {
        tools = next;
        notify();
      }
      return true;
    } catch (error) {
      console.error('[SharedTools] Failed to save:', error);
      alert('分享沒有存到伺服器，請重新整理頁面後再試一次。');
      return false;
    } finally {
      writesInFlight -= 1;
    }
  });
  writeChain = write.then(() => undefined);
  return write;
}

export function useSharedTools(): SharedTool[] {
  return useSyncExternalStore(subscribe, () => tools, () => EMPTY);
}

const oneLine = (text: string, max: number) => text.trim().replace(/\s+/g, ' ').slice(0, max);

/** Returns false without saving when the name or page is blank or the page is over 200KB. */
export function shareTool({ name, html, author }: { name: string; html: string; author: string }): boolean {
  const cleanName = oneLine(name, MAX_NAME_LENGTH);
  if (!cleanName || !html.trim() || new Blob([html]).size > MAX_SHARED_HTML) return false;
  const item: SharedTool = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: cleanName,
    html,
    author: oneLine(author, MAX_AUTHOR_LENGTH),
    sharedAt: new Date().toISOString(),
  };
  void updateSharedTools((current) => capSharedTools([item, ...current.filter((entry) => entry.id !== item.id)]));
  return true;
}

export function removeSharedTool(id: string): void {
  void updateSharedTools((current) => current.filter((item) => item.id !== id));
}
