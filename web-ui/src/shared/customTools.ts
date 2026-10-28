import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

/**
 * DHC CLI 10/14 工具庫: each person's five 自選 slots (tool ids, null = empty) and each tool's own saved data.
 * Both belong to the person, i.e. this device's 專案設定 profile, in user_preferences (`dhc.picks:p:<profileId>`,
 * `dhc.tool:<toolId>:p:<profileId>`), so every device of that person shows the same. A device without a profile
 * keeps its picks in this browser only.
 */
export const PICK_SLOTS = 5;
export type Picks = Array<string | null>;

const picksKeyOf = (profileId: string) => `dhc.picks:p:${profileId}`;
const LOCAL_PICKS_KEY = 'dhc.picks.local';
const toolKeyOf = (toolId: string, profileId: string) => `dhc.tool:${toolId}:p:${profileId}`;
const SAVE_DELAY_MS = 800;

export const emptyPicks = (): Picks => Array.from({ length: PICK_SLOTS }, () => null);

export function parsePicks(value: unknown): Picks {
  const raw = Array.isArray(value) ? value : [];
  return emptyPicks().map((_, index) => (typeof raw[index] === 'string' && raw[index] ? raw[index] as string : null));
}

async function fetchPreferences(): Promise<Record<string, unknown>> {
  const response = await api.user.preferences();
  if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
  const payload = (await response.json()) as { preferences?: Record<string, unknown> };
  return payload.preferences ?? {};
}

const readLocalPicks = (): Picks => {
  try {
    return parsePicks(JSON.parse(localStorage.getItem(LOCAL_PICKS_KEY) ?? 'null'));
  } catch {
    return emptyPicks();
  }
};

/** The person's five slots; setPicks saves them at once. */
export function usePicks(profileId: string | null): [Picks, (next: Picks) => void] {
  const [picks, setPicksState] = useState<Picks>(() => (profileId ? emptyPicks() : readLocalPicks()));

  useEffect(() => {
    if (!profileId) {
      setPicksState(readLocalPicks());
      return undefined;
    }
    let cancelled = false;
    fetchPreferences()
      .then((preferences) => { if (!cancelled) setPicksState(parsePicks(preferences[picksKeyOf(profileId)])); })
      .catch(() => { /* Empty slots until the next open. */ });
    return () => { cancelled = true; };
  }, [profileId]);

  const setPicks = (next: Picks) => {
    const clean = parsePicks(next);
    setPicksState(clean);
    if (!profileId) {
      try { localStorage.setItem(LOCAL_PICKS_KEY, JSON.stringify(clean)); } catch { /* this page load only */ }
      return;
    }
    void api.user.savePreferences({ [picksKeyOf(profileId)]: clean }).catch(() => {
      // The slots stay as set on this page; the next change tries again.
    });
  };

  return [picks, setPicks];
}

/** Puts a tool in the first empty slot; false when all five are taken or it is already there. */
export function addPick(picks: Picks, toolId: string): Picks | null {
  if (picks.includes(toolId)) return null;
  const free = picks.indexOf(null);
  if (free < 0) return null;
  return picks.map((item, index) => (index === free ? toolId : item));
}

export function removePick(picks: Picks, toolId: string): Picks {
  return picks.map((item) => (item === toolId ? null : item));
}

/** Swaps a slot with its neighbour (-1 = left, 1 = right). */
export function movePick(picks: Picks, index: number, step: -1 | 1): Picks {
  const target = index + step;
  if (target < 0 || target >= picks.length) return picks;
  const next = [...picks];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export async function loadToolData(toolId: string, profileId: string): Promise<unknown> {
  return (await fetchPreferences())[toolKeyOf(toolId, profileId)] ?? null;
}

/**
 * Saves one tool's data for one person a moment after the last change (the whole value; the tool is open on one
 * device at a time, so the last save wins). onError runs when the server refused it.
 */
export function createToolSaver(toolId: string, profileId: string, onError: () => void) {
  let waiting: { value: unknown } | null = null;
  let timer: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  const flush = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (!waiting) return chain;
    const { value } = waiting;
    waiting = null;
    chain = chain.then(async () => {
      try {
        const response = await api.user.savePreferences({ [toolKeyOf(toolId, profileId)]: value });
        if (!response.ok) throw new Error(`Failed to save ${toolId} (${response.status})`);
      } catch (error) {
        console.error('[CustomTools] Failed to save:', error);
        onError();
      }
    });
    return chain;
  };

  return {
    save(value: unknown) {
      waiting = { value };
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void flush(); }, SAVE_DELAY_MS);
    },
    /** Writes anything still waiting now (closing the tool, starting work). */
    flush,
  };
}

export type AssistMessage = { role: 'user' | 'assistant'; text: string };
export type AssistAnswer = { reply: string; result: unknown };

/** Asks the AI beside a tool; never throws, a failure comes back as a reply saying so. */
export async function askToolAssist(
  tool: string,
  input: { message: string; context: unknown; chat: AssistMessage[] },
): Promise<AssistAnswer> {
  try {
    const response = await api.toolAssist({ tool, ...input });
    const payload = (await response.json().catch(() => null)) as { data?: { reply?: string; result?: unknown } } | null;
    if (!response.ok || !payload?.data) {
      return { reply: response.status === 404 ? '要等系統重啟後才能用 AI。' : 'AI 這次沒有回應，稍後再試一次。', result: null };
    }
    return { reply: payload.data.reply ?? '', result: payload.data.result ?? null };
  } catch {
    return { reply: '連不到伺服器，稍後再試一次。', result: null };
  }
}
