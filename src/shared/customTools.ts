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

/**
 * The person's five slots; setPicks saves them at once. With a profile, nothing is saved until the server's slots
 * have loaded (else the empty placeholder would overwrite them); the third value is a message when a change was
 * refused or did not reach the server.
 */
export function usePicks(profileId: string | null): [Picks, (next: Picks) => void, string] {
  const [picks, setPicksState] = useState<Picks>(() => (profileId ? emptyPicks() : readLocalPicks()));
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!profileId) {
      setPicksState(readLocalPicks());
      return undefined;
    }
    let cancelled = false;
    setLoaded(false);
    fetchPreferences()
      .then((preferences) => {
        if (cancelled) return;
        setPicksState(parsePicks(preferences[picksKeyOf(profileId)]));
        setLoaded(true);
      })
      .catch(() => { /* Not loaded: changes are refused until the next open. */ });
    return () => { cancelled = true; };
  }, [profileId]);

  const setPicks = (next: Picks) => {
    const clean = parsePicks(next);
    if (!profileId) {
      setPicksState(clean);
      try { localStorage.setItem(LOCAL_PICKS_KEY, JSON.stringify(clean)); } catch { /* this page load only */ }
      return;
    }
    if (!loaded) {
      setError('自選還沒從伺服器載入，這次沒有儲存。請關掉工具庫再打開。');
      return;
    }
    setError('');
    setPicksState(clean);
    void api.user.savePreferences({ [picksKeyOf(profileId)]: clean })
      .then((response) => { if (!response.ok) throw new Error(String(response.status)); })
      .catch(() => { setError('自選沒存到伺服器，換頁後可能會還原，請再試一次。'); });
  };

  return [picks, setPicks, error];
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
/** `lostResult`: the AI sent something to apply that could not be read (server tool-assist.service.ts). */
export type AssistAnswer = { reply: string; result: unknown; lostResult?: boolean };

// Codes from server/modules/providers/services/tool-assist/tool-assist.service.ts (FAILURE_CODES).
const FAILURE_TEXT: Record<string, string> = {
  ASSIST_TIMEOUT: 'AI 逾時：超過 5 分鐘沒做完，已經停掉。可以把要求拆小一點再試。',
  ASSIST_QUOTA: 'AI 額度用完了，要等額度重置後再試。',
  ASSIST_AUTH: '主機的 Claude 登入過期了，要請管理主機的人重新登入。',
  ASSIST_FORMAT: 'AI 的回應格式錯誤，讀不出內容，再試一次。',
  ASSIST_ABORTED: '已停止。',
};

/** The plain-Chinese reason for a failed answer; anything unknown shows the first 80 characters of the original. */
export function assistFailureText(error: { code?: unknown; message?: unknown } | null | undefined): string {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : '沒有錯誤訊息';
  return FAILURE_TEXT[code] ?? `AI 這次沒有完成。其他：${message.slice(0, 80)}`;
}

/** Asks the AI beside a tool; never throws, a failure comes back as a reply saying why. */
export async function askToolAssist(
  tool: string,
  input: { message: string; context: unknown; chat: AssistMessage[]; projectId?: string | null },
  signal?: AbortSignal,
): Promise<AssistAnswer> {
  try {
    const response = await api.toolAssist({ tool, ...input }, signal);
    // The server sends 200 at once and the outcome later, so a failure is {success:false,error} under 200.
    const payload = (await response.json().catch(() => null)) as
      | { data?: { reply?: string; result?: unknown; lostResult?: boolean }; error?: { code?: unknown; message?: unknown } }
      | null;
    if (response.status === 404) return { reply: '要等系統重啟後才能用 AI。', result: null };
    if (!response.ok || !payload?.data) {
      return { reply: payload?.error ? assistFailureText(payload.error) : `AI 這次沒有回應（HTTP ${response.status}），稍後再試一次。`, result: null };
    }
    return { reply: payload.data.reply ?? '', result: payload.data.result ?? null, lostResult: payload.data.lostResult === true };
  } catch {
    if (signal?.aborted) return { reply: FAILURE_TEXT.ASSIST_ABORTED, result: null };
    return { reply: '連不到伺服器，稍後再試一次。', result: null };
  }
}

/** The reply says it changed something, yet nothing came back to apply. */
export const claimsChange = (reply: string) => /已(經)?(修改|更新|新增|加上|加入|改好|做好|調整|刪除|套用|拆成|排好|補上|改寫)|做好了|改好了/.test(reply);
