import { beforeEach, describe, expect, it } from 'vitest';

import { addPendingQueryPurge, duePendingQueryPurges, handoffDraft, isIncognitoSession, isListedIncognitoQuery, QUERY_IDLE_PURGE_MS, QUERY_PURGE_PENDING_KEY, readPendingQueryPurges, removePendingQueryPurge, staleQuerySessionIds } from '@/modules/project-workspace/utils/incognitoQuery';
import type { Project } from '@/shared/types';

const now = Date.parse('2026-10-31T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const project = (path: string, sessions: { id: string; lastActivity: string; createdAt?: string }[]) =>
  ({ projectId: path, name: path, displayName: path, fullPath: path, path, sessions: sessions.map((s) => ({ createdAt: ago(QUERY_IDLE_PURGE_MS * 5), ...s })) }) as unknown as Project;

describe('無痕查詢', () => {
  const projects = [
    project(String.raw`C:\Users\demo\DHC Workspace\內部資料查詢`, [
      { id: 'old', lastActivity: ago(QUERY_IDLE_PURGE_MS + 60_000) },
      { id: 'fresh', lastActivity: ago(10 * 60_000) },
      { id: 'open', lastActivity: ago(QUERY_IDLE_PURGE_MS * 3) },
      { id: 'busy', lastActivity: ago(QUERY_IDLE_PURGE_MS * 3) },
      { id: 'pre-incognito', lastActivity: ago(QUERY_IDLE_PURGE_MS * 3), createdAt: '2026-10-19T00:59:15Z' },
      { id: 'pre-incognito-no-created', lastActivity: '2026-10-20T06:30:09Z', createdAt: undefined },
    ]),
    project(String.raw`C:\Users\demo\DHC Workspace\內部資料查詢\DHC CLI教學`, [{ id: 'teach-old', lastActivity: ago(QUERY_IDLE_PURGE_MS * 2) }]),
    project(String.raw`C:\Users\demo\DHC Workspace\同事C`, [{ id: 'work-old', lastActivity: ago(QUERY_IDLE_PURGE_MS * 10) }]),
  ];

  it('purges only idle query sessions, never the open, running, or ordinary ones', () => {
    expect(staleQuerySessionIds(projects, now, 'open', (id) => id === 'busy').sort()).toEqual(['old', 'teach-old']);
  });

  it('the 89 pre-incognito conversations (payload has only lastActivity) are never purged', () => {
    expect(isIncognitoSession({ id: 'a', lastActivity: '2026-10-20T06:30:09.000Z' } as never)).toBe(false);
    expect(isIncognitoSession({ id: 'b', lastActivity: ago(60_000) } as never)).toBe(true);
    expect(isIncognitoSession({ id: 'c' } as never)).toBe(false);
  });

  it('leaving deletes only a listed, post-cutoff query session — never a placeholder, an old one, or another project', () => {
    const recent = [
      project(String.raw`C:\Users\demo\DHC Workspace\內部資料查詢`, [{ id: 'q-new', lastActivity: ago(1000) }, { id: 'q-old', lastActivity: '2026-10-20T06:30:09Z', createdAt: '2026-10-19T00:59:15Z' }]),
      project(String.raw`C:\Users\demo\DHC Workspace\同事C`,[{ id: 'work-new', lastActivity: ago(1000) }]),
    ];
    expect(isListedIncognitoQuery(recent, 'q-new')).toBe(true);
    expect(isListedIncognitoQuery(recent, 'q-old')).toBe(false);
    expect(isListedIncognitoQuery(recent, 'work-new')).toBe(false);
    expect(isListedIncognitoQuery(recent, 'placeholder-not-listed')).toBe(false);
  });

  it('the hand-off draft carries the zone, question and a clipped answer', () => {
    const draft = handoffDraft('法遵專區', ' 自營部位限額怎麼算？ ', 'x'.repeat(2500));
    expect(draft.startsWith('接續剛才的查詢（法遵專區）：\n問：自營部位限額怎麼算？\n答：')).toBe(true);
    expect(draft).toContain('…');
    expect(draft.endsWith('請接著幫我：')).toBe(true);
  });

  describe('left while running', () => {
    beforeEach(() => localStorage.removeItem(QUERY_PURGE_PENDING_KEY));
    const listed = [project(String.raw`C:\Users\demo\DHC Workspace\內部資料查詢`, [{ id: 'q1', lastActivity: ago(1000) }, { id: 'q2', lastActivity: ago(1000) }])];

    it('remembers ids without duplicates and forgets them on removal', () => {
      addPendingQueryPurge('q1');
      addPendingQueryPurge('q1');
      addPendingQueryPurge('q2');
      expect(readPendingQueryPurges()).toEqual(['q1', 'q2']);
      removePendingQueryPurge('q1');
      expect(readPendingQueryPurges()).toEqual(['q2']);
      removePendingQueryPurge('q2');
      expect(localStorage.getItem(QUERY_PURGE_PENDING_KEY)).toBeNull();
    });

    it('ignores corrupt storage', () => {
      localStorage.setItem(QUERY_PURGE_PENDING_KEY, '{oops');
      expect(readPendingQueryPurges()).toEqual([]);
      localStorage.setItem(QUERY_PURGE_PENDING_KEY, JSON.stringify(['q1', 7, null]));
      expect(readPendingQueryPurges()).toEqual(['q1']);
    });

    it('is due only when stopped, off screen and still a listed incognito query', () => {
      const pending = ['q1', 'q2', 'work-new', 'unlisted'];
      const withWork = [...listed, project(String.raw`C:\Users\demo\DHC Workspace\同事C`, [{ id: 'work-new', lastActivity: ago(1000) }])];
      expect(duePendingQueryPurges(withWork, pending, null, () => false)).toEqual(['q1', 'q2']);
      expect(duePendingQueryPurges(withWork, pending, null, (id) => id === 'q1')).toEqual(['q2']);
      expect(duePendingQueryPurges(withWork, pending, 'q2', () => false)).toEqual(['q1']);
    });
  });
});
