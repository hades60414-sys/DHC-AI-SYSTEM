import { useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

/**
 * DHC CLI 10/07 功能許願池: anyone can drop a feature wish (主題、描述、署名, blank 署名 = 匿名). One list for
 * the whole site, in user_preferences under the global key `dhc.wishes`, so every device and the person building
 * features see the same wishes. A save re-reads the server's copy first, like the to-do lists, so a wish added
 * on another device stays.
 */
export type FeatureWish = {
  id: string;
  title: string;
  description: string;
  author: string;
  createdAt: string;
};

const KEY = 'dhc.wishes';
const MAX_TITLE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_AUTHOR_LENGTH = 30;
const RELOAD_ON_FOCUS_MIN_MS = 30_000;
const EMPTY: FeatureWish[] = [];

export function parseFeatureWishes(value: unknown): FeatureWish[] {
  const raw = value && typeof value === 'object' ? (value as { items?: unknown }).items : null;
  if (!Array.isArray(raw)) return EMPTY;
  return raw.filter((item): item is FeatureWish => (
    Boolean(item) && typeof (item as FeatureWish).id === 'string' && typeof (item as FeatureWish).title === 'string'
  )).map((item) => ({
    id: item.id,
    title: item.title,
    description: typeof item.description === 'string' ? item.description : '',
    author: typeof item.author === 'string' ? item.author : '',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
  }));
}

let wishes: FeatureWish[] = EMPTY;
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

async function fetchServerWishes(): Promise<FeatureWish[]> {
  const response = await api.user.preferences();
  if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
  const payload = (await response.json()) as { preferences?: Record<string, unknown> };
  return parseFeatureWishes(payload.preferences?.[KEY]);
}

export async function loadFeatureWishes(): Promise<void> {
  lastLoadAt = Date.now();
  try {
    const next = await fetchServerWishes();
    if (writesInFlight > 0) return;
    wishes = next;
    notify();
  } catch (error) {
    console.error('[FeatureWishes] Failed to load wishes:', error);
  }
}

/** Loads the wishes now and whenever the tab comes back into view; returns the cleanup. */
export function startFeatureWishesSync(): () => void {
  void loadFeatureWishes();
  const reloadWhenVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadAt > RELOAD_ON_FOCUS_MIN_MS) {
      void loadFeatureWishes();
    }
  };
  document.addEventListener('visibilitychange', reloadWhenVisible);
  return () => document.removeEventListener('visibilitychange', reloadWhenVisible);
}

function updateFeatureWishes(change: (current: FeatureWish[]) => FeatureWish[]): Promise<boolean> {
  wishes = change(wishes);
  notify();
  writesInFlight += 1;
  const write = writeChain.then(async () => {
    try {
      const next = change(await fetchServerWishes());
      const response = await api.user.savePreferences({ [KEY]: { items: next } });
      if (!response.ok) throw new Error(`Failed to save wishes (${response.status})`);
      if (writesInFlight === 1) {
        wishes = next;
        notify();
      }
      return true;
    } catch (error) {
      console.error('[FeatureWishes] Failed to save wishes:', error);
      alert('許願沒有存到伺服器，請重新整理頁面後再試一次。');
      return false;
    } finally {
      writesInFlight -= 1;
    }
  });
  writeChain = write.then(() => undefined);
  return write;
}

export function useFeatureWishes(): FeatureWish[] {
  return useSyncExternalStore(subscribe, () => wishes, () => EMPTY);
}

const oneLine = (text: string, max: number) => text.trim().replace(/\s+/g, ' ').slice(0, max);

type NewWish = { title: string; description: string; author: string };

/** Returns false without saving when the title is blank. */
export function addFeatureWish({ title, description, author }: NewWish): boolean {
  const cleanTitle = oneLine(title, MAX_TITLE_LENGTH);
  if (!cleanTitle) return false;
  const wish: FeatureWish = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: cleanTitle,
    description: description.trim().slice(0, MAX_DESCRIPTION_LENGTH),
    author: oneLine(author, MAX_AUTHOR_LENGTH),
    createdAt: new Date().toISOString(),
  };
  void updateFeatureWishes((current) => [wish, ...current.filter((item) => item.id !== wish.id)]);
  return true;
}

export function removeFeatureWish(id: string): void {
  void updateFeatureWishes((current) => current.filter((item) => item.id !== id));
}

/**
 * The opening message for a new chat that helps shape a wish. It asks how deep to go first, because some people
 * want a quick MVP to try and refine, and others would rather talk it through.
 */
export function wishDiscussionPrompt({ title, description }: Pick<NewWish, 'title' | 'description'>): string {
  const lines = [
    '我想許一個 AI 相關的願望（DHC CLI 介面功能、內部資料自動彙整報告、電腦操作自動化等都算），請陪我把它想清楚，最後整理成可以貼回「功能許願池」的版本。',
    '',
    `主題：${title.trim() || '（還沒想好）'}`,
    `描述：${description.trim() || '（還沒寫）'}`,
    '',
    '進行方式：',
    '1. 先問我想討論多詳細，給我三個選項：',
    '   A. 快速：懶得多想選這個，你直接整理成 MVP（最小可用版本），做出來試用後再慢慢改',
    '   B. 一般：問我 3 個以內最關鍵的問題',
    '   C. 詳細：一起把使用情境、操作流程、例外狀況都聊清楚',
    '2. 照我選的程度討論，每次只問一題，盡量給選項讓我選，少讓我打長字。',
    '3. 最後輸出「許願單」：主題（一句話）、描述（我是誰、在什麼情況下、想做到什麼、做好了長怎樣、MVP 先做哪些、之後可以再加什麼）。',
    '',
    '只要討論和整理文字，不要修改任何程式或檔案。',
  ];
  return lines.join('\n');
}
