import { useCallback, useSyncExternalStore } from 'react';

/**
 * DHC CLI: sessions whose turn is over but whose CLI is still working — background subagents or shells, or
 * the follow-up turn the CLI starts when they report back. The server lists them beside the running sessions
 * in the 5-second poll (SessionProtectionContext); sidebar rows read them here and keep a violet light on, so
 * a session does not look finished while its subagents are still going.
 */
export type BackgroundWork = {
  agents: number;
  shells: number;
  others: number;
  /** The CLI is answering what the background work reported. */
  followUp: boolean;
  descriptions: string[];
};

let byId: ReadonlyMap<string, BackgroundWork> = new Map();
let lastKey = '[]';
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getById = () => byId;

const readTask = (task: unknown): { type: string; description: string } => {
  const record = task && typeof task === 'object' ? (task as Record<string, unknown>) : {};
  return {
    type: typeof record.type === 'string' ? record.type : '',
    description: typeof record.description === 'string' ? record.description.trim() : '',
  };
};

/**
 * Replaces the whole picture with the server's list (`background` of GET /sessions/running). Readers are only
 * told when something actually changed, so the 5-second poll does not redraw the sidebar on its own.
 */
export function setBackgroundWork(items: unknown): void {
  const next = new Map<string, BackgroundWork>();
  for (const item of Array.isArray(items) ? items : []) {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    if (typeof record.sessionId !== 'string' || !record.sessionId) continue;
    const work: BackgroundWork = { agents: 0, shells: 0, others: 0, followUp: record.followUp === true, descriptions: [] };
    for (const task of (Array.isArray(record.tasks) ? record.tasks : []).map(readTask)) {
      if (/agent|workflow/i.test(task.type)) work.agents += 1;
      else if (/bash|shell/i.test(task.type)) work.shells += 1;
      else work.others += 1;
      if (task.description) work.descriptions.push(task.description);
    }
    next.set(record.sessionId, work);
  }

  const key = JSON.stringify([...next].sort(([a], [b]) => a.localeCompare(b)));
  if (key === lastKey) return;
  lastKey = key;
  byId = next;
  listeners.forEach((listener) => listener());
}

/** This session's after-turn work, or null. Same object until that session's work changes. */
export function useBackgroundWork(sessionId: string): BackgroundWork | null {
  const getSnapshot = useCallback(() => byId.get(sessionId) ?? null, [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Every session with after-turn work, by id; the same Map until the server's list changes. */
export function useBackgroundWorkMap(): ReadonlyMap<string, BackgroundWork> {
  return useSyncExternalStore(subscribe, getById, getById);
}

/** One line for a tooltip, e.g. 「背景還在跑：2 個子代理、1 個指令（審查、npm test）」. */
export function describeBackgroundWork(work: BackgroundWork): string {
  const counts = [
    work.agents ? `${work.agents} 個子代理` : '',
    work.shells ? `${work.shells} 個指令` : '',
    work.others ? `${work.others} 個背景工作` : '',
  ].filter(Boolean);
  const names = work.descriptions.length > 3
    ? `${work.descriptions.slice(0, 3).join('、')}…`
    : work.descriptions.join('、');
  const running = counts.length > 0 ? `背景還在跑：${counts.join('、')}${names ? `（${names}）` : ''}` : '';
  if (!work.followUp) return running || '背景還在跑';
  return running ? `${running}；Claude 正在處理已回報的結果` : '背景工作已回報，Claude 正在收尾';
}
