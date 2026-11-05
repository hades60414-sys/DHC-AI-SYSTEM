import { isQueryProject } from '@/modules/sidebar/hooks/useSidebarController';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * DHC 無痕查詢 (2026-10-31): conversations in the 內部資料查詢 zones are not kept. Leaving one deletes it for
 * good (DB row + transcript); one left behind by a closed tab goes on the next page load once it has been idle
 * this long, so a query still being read on another device is not pulled away.
 */
export const QUERY_IDLE_PURGE_MS = 2 * 60 * 60 * 1000;

/** Only conversations started after 無痕 went live are purged; the older ones stay until the user decides (a backup is retained). */
export const QUERY_INCOGNITO_SINCE = Date.parse('2026-10-30T20:00:00Z');

// The projects payload carries no creation time, only lastActivity; the 89 older query conversations all end
// before 2026-10-21, so they stay out unless someone reopens one and keeps talking in it.
const createdMs = (session: ProjectSession): number => {
  const raw = session.createdAt ?? session.created_at ?? session.lastActivity;
  const t = raw ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** A query conversation that 無痕 may delete: started (or last active) after QUERY_INCOGNITO_SINCE; no time at all is kept. */
export const isIncognitoSession = (session: ProjectSession): boolean => createdMs(session) >= QUERY_INCOGNITO_SINCE;

const lastActivityMs = (session: ProjectSession): number => {
  const raw = session.lastActivity ?? session.updated_at ?? session.createdAt ?? session.created_at;
  const t = raw ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** Delay before the page-load idle purge, so running sessions are known first. */
export const QUERY_PURGE_DELAY_MS = 30_000;

/** On leaving: delete only a session the payload lists under a query project with post-cutoff activity. */
export function isListedIncognitoQuery(projects: ReadonlyArray<Project>, sessionId: string): boolean {
  return projects.some((project) => isQueryProject(project)
    && (project.sessions ?? []).some((session) => session.id === sessionId && isIncognitoSession(session)));
}

/** Query sessions left while still running; their ids wait here until the run ends (survives a reload). */
export const QUERY_PURGE_PENDING_KEY = 'dhc.queryPurgePending';
const PENDING_MAX = 50;

export function readPendingQueryPurges(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(QUERY_PURGE_PENDING_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writePendingQueryPurges(ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(QUERY_PURGE_PENDING_KEY);
    else localStorage.setItem(QUERY_PURGE_PENDING_KEY, JSON.stringify(ids.slice(-PENDING_MAX)));
  } catch {
    // storage full or blocked: the idle purge on a later page load is the fallback
  }
}

export function addPendingQueryPurge(id: string): void {
  const ids = readPendingQueryPurges();
  if (!ids.includes(id)) writePendingQueryPurges([...ids, id]);
}

export function removePendingQueryPurge(id: string): void {
  writePendingQueryPurges(readPendingQueryPurges().filter((pending) => pending !== id));
}

/** Pending ids that may be deleted now: still listed as incognito query sessions, not on screen, no longer running. */
export function duePendingQueryPurges(
  projects: ReadonlyArray<Project>,
  pending: ReadonlyArray<string>,
  keepId: string | null,
  isBusy: (sessionId: string) => boolean,
): string[] {
  return pending.filter((id) => id !== keepId && !isBusy(id) && isListedIncognitoQuery(projects, id));
}

/** Query sessions idle past QUERY_IDLE_PURGE_MS, except the one on screen and any still running. */
export function staleQuerySessionIds(
  projects: ReadonlyArray<Project>,
  now: number,
  keepId: string | null,
  isBusy: (sessionId: string) => boolean,
): string[] {
  return projects
    .filter((project) => isQueryProject(project))
    .flatMap((project) => project.sessions ?? [])
    .filter((session) => isIncognitoSession(session) && session.id !== keepId && !isBusy(session.id) && now - lastActivityMs(session) > QUERY_IDLE_PURGE_MS)
    .map((session) => session.id);
}

/** The text a 「轉到專案開工」 hand-off puts in the target project's new-session composer. */
export function handoffDraft(zone: string, question: string, answer: string): string {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
  return [
    `接續剛才的查詢（${zone}）：`,
    `問：${clip(question.trim(), 600)}`,
    `答：${clip(answer.trim(), 2000)}`,
    '',
    '請接著幫我：',
  ].join('\n');
}
