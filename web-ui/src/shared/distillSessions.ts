import { useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

/**
 * DHC CLI 10/06 蒸餾模式: a per-session switch like the ⚡ — the flask in the composer. While it is on, every turn
 * of a Claude session carries DISTILL_SYSTEM_NOTE as its system-prompt append (the server passes chat.send options
 * through to the runtime), so the model keeps a decision log under 蒸餾任務 and can turn the task into a skill
 * when the user says 結案. Marks live in one user_preferences key so every device sees the same flasks; a save
 * re-reads the server's list and applies the same change, so marks made elsewhere stay.
 */
const PREF_KEY = 'dhc.distillSessions';
const RELOAD_ON_FOCUS_MIN_MS = 30_000;

export const DISTILL_SYSTEM_NOTE = [
  '# DHC CLI 蒸餾模式',
  '使用者在這個對話開了蒸餾模式（輸入框的燒杯鈕）：想把這件工作裡自己的判斷留下紀錄，結案時整理成之後可以重用的技能。',
  '- 規則在工作區根目錄的 蒸餾任務\\README.md（從專案資料夾看是 ..\\蒸餾任務\\README.md）。這個對話還沒對應到任務資料夾時，先讀它，照「開始」做。',
  '- 每回合照常把事做好；使用者糾正、選擇、加條件、說理由或確認做法時，照 README 追加到任務的決策紀錄，不打斷正事，也不在回覆裡報告。',
  '- 使用者說「結案」時，照 README 的「結案」做。',
].join('\n');

let distillIds: ReadonlySet<string> = new Set();
/** Projects whose next new conversation starts in 蒸餾模式 (the flask was pressed before the first send). */
let pendingNewByProject: ReadonlySet<string> = new Set();
let writeChain: Promise<void> = Promise.resolve();
let writesInFlight = 0;
let lastLoadAt = 0;
const storeListeners = new Set<() => void>();

const notifyStore = () => storeListeners.forEach((listener) => listener());
const subscribeStore = (listener: () => void) => {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
};

export const parseDistillIds = (value: unknown): Set<string> =>
  new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []);

async function fetchServerDistillIds(): Promise<Set<string>> {
  const response = await api.user.preferences();
  if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
  const payload = (await response.json()) as { preferences?: Record<string, unknown> };
  return parseDistillIds(payload.preferences?.[PREF_KEY]);
}

export async function loadDistillSessions(): Promise<void> {
  lastLoadAt = Date.now();
  try {
    const next = await fetchServerDistillIds();
    if (writesInFlight > 0) return;
    distillIds = next;
    notifyStore();
  } catch (error) {
    console.error('[Distill] Failed to load distill marks:', error);
  }
}

/** Loads the marks now and whenever the tab comes back into view; returns the cleanup. */
export function startDistillSessionsSync(): () => void {
  void loadDistillSessions();
  const reloadWhenVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadAt > RELOAD_ON_FOCUS_MIN_MS) {
      void loadDistillSessions();
    }
  };
  document.addEventListener('visibilitychange', reloadWhenVisible);
  return () => document.removeEventListener('visibilitychange', reloadWhenVisible);
}

const withMark = (ids: ReadonlySet<string>, id: string, on: boolean): Set<string> => {
  const next = new Set(ids);
  if (on) next.add(id);
  else next.delete(id);
  return next;
};

export function setSessionDistill(sessionId: string, on: boolean): Promise<void> {
  if (!sessionId || distillIds.has(sessionId) === on) return writeChain;
  distillIds = withMark(distillIds, sessionId, on);
  notifyStore();
  writesInFlight += 1;
  writeChain = writeChain.then(async () => {
    try {
      const next = withMark(await fetchServerDistillIds(), sessionId, on);
      const response = await api.user.savePreferences({ [PREF_KEY]: [...next] });
      if (!response.ok) throw new Error(`Failed to save distill marks (${response.status})`);
      if (writesInFlight === 1) {
        distillIds = next;
        notifyStore();
      }
    } catch (error) {
      console.error('[Distill] Failed to save distill mark:', error);
    } finally {
      writesInFlight -= 1;
    }
  });
  return writeChain;
}

export const isDistillSessionId = (sessionId: string | null | undefined): boolean =>
  Boolean(sessionId && distillIds.has(sessionId));

export function useIsDistillSession(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribeStore, () => isDistillSessionId(sessionId), () => false);
}

export function setNewSessionDistill(projectId: string, on: boolean): void {
  if (pendingNewByProject.has(projectId) === on) return;
  pendingNewByProject = withMark(pendingNewByProject, projectId, on);
  notifyStore();
}

export function useNewSessionDistill(projectId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribeStore, () => Boolean(projectId && pendingNewByProject.has(projectId)), () => false);
}

/** Called when a new conversation gets its id: it starts in 蒸餾模式 if the flask was on before the first send. */
export function fileNewSessionDistill(projectId: string, sessionId: string): void {
  if (!pendingNewByProject.has(projectId)) return;
  setNewSessionDistill(projectId, false);
  void setSessionDistill(sessionId, true);
}
