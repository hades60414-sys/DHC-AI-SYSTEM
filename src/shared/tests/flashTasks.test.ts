import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

/**
 * DHC CLI 快閃任務: the × / header button ends a session by archiving it into a 7-day trash (10/05; before
 * that it deleted outright). A page load after the 7 days deletes it — only if it is still archived.
 */

const server: Record<string, unknown> = {};
const deleteSession = vi.fn();
const getArchivedSessions = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    deleteSession: (...args: unknown[]) => deleteSession(...args),
    getArchivedSessions: () => getArchivedSessions(),
    user: {
      preferences: async () => ({ ok: true, json: async () => ({ success: true, preferences: structuredClone(server) }) }),
      savePreferences: async (updates: Record<string, unknown>) => {
        Object.assign(server, structuredClone(updates));
        return { ok: true, json: async () => ({ success: true }) };
      },
    },
  },
}));

const {
  endFlashSession,
  flashTrashDaysLeft,
  forgetFlashTrash,
  isFlashProject,
  onFlashSessionEnded,
  purgeExpiredFlashTrash,
} = await import('@/shared/flashTasks');

const FLASH = 'C:\\Users\\demo\\DHC Workspace\\快閃任務區';
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-20T08:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();
const trash = () => server['dhc.flashTrash'] as Record<string, string> | undefined;
/** Trash writes are chained; a no-op forget resolves only after every earlier write has landed. */
const settleWrites = () => forgetFlashTrash('__none__');
const archivedList = (...ids: string[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, data: { sessions: ids.map((sessionId) => ({ sessionId })) } }),
});

afterEach(() => {
  deleteSession.mockReset();
  getArchivedSessions.mockReset();
  for (const key of Object.keys(server)) delete server[key];
  vi.restoreAllMocks();
});

test('only the 快閃任務區 folder directly under the workspace root is the flash zone', () => {
  assert.equal(isFlashProject({ fullPath: FLASH }), true);
  assert.equal(isFlashProject({ fullPath: `${FLASH}\\` }), true);
  assert.equal(isFlashProject({ path: FLASH.replace(/\\/g, '/') }), true);

  assert.equal(isFlashProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\工具實驗' }), false);
  assert.equal(isFlashProject({ fullPath: `${FLASH}\\sub` }), false);
  assert.equal(isFlashProject({ fullPath: 'D:\\other\\快閃任務區' }), false);
  assert.equal(isFlashProject(null), false);
});

test('ending a session archives it (no hard delete), tells every listener, and starts its 7 days', async () => {
  deleteSession.mockResolvedValue({ ok: true, status: 200 });
  const ended: string[] = [];
  const stop = onFlashSessionEnded((id) => ended.push(id));

  await endFlashSession('s1');
  stop();
  await endFlashSession('s2');
  await settleWrites();

  assert.deepEqual(deleteSession.mock.calls, [['s1', false], ['s2', false]]);
  assert.deepEqual(ended, ['s1']);
  assert.deepEqual(Object.keys(trash() ?? {}).sort(), ['s1', 's2']);
  assert.ok(Date.now() - Date.parse(trash()!.s1) < 60_000, 'the 7 days start now');
});

test('already gone (404) counts as ended; a server error keeps the row and says so', async () => {
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const ended: string[] = [];
  const stop = onFlashSessionEnded((id) => ended.push(id));

  deleteSession.mockResolvedValueOnce({ ok: false, status: 404 });
  await endFlashSession('gone');
  deleteSession.mockResolvedValueOnce({ ok: false, status: 500 });
  await endFlashSession('broken');
  deleteSession.mockRejectedValueOnce(new Error('offline'));
  await endFlashSession('offline');
  stop();
  await settleWrites();

  assert.deepEqual(ended, ['gone']);
  assert.equal(alert.mock.calls.length, 2);
  assert.deepEqual(Object.keys(trash() ?? {}), ['gone'], 'a failed end puts nothing in the trash');
});

test('after 7 days the trash deletes sessions that are still archived and lets restored ones go', async () => {
  server['dhc.flashTrash'] = { old: daysAgo(8), restored: daysAgo(8), fresh: daysAgo(1) };
  getArchivedSessions.mockResolvedValue(archivedList('old', 'fresh'));
  deleteSession.mockResolvedValue({ ok: true, status: 200 });

  await purgeExpiredFlashTrash(NOW);

  assert.deepEqual(deleteSession.mock.calls, [['old', true]], 'only the expired, still-archived one is deleted');
  assert.deepEqual(Object.keys(trash() ?? {}), ['fresh']);
});

test('nothing expired: no archive lookup and nothing deleted', async () => {
  server['dhc.flashTrash'] = { fresh: daysAgo(6.9) };

  await purgeExpiredFlashTrash(NOW);

  assert.equal(getArchivedSessions.mock.calls.length, 0);
  assert.equal(deleteSession.mock.calls.length, 0);
  assert.deepEqual(Object.keys(trash() ?? {}), ['fresh']);
});

test('a hard delete that fails stays in the trash for the next load; 404 counts as done', async () => {
  server['dhc.flashTrash'] = { failing: daysAgo(9), vanished: daysAgo(9) };
  getArchivedSessions.mockResolvedValue(archivedList('failing', 'vanished'));
  deleteSession.mockImplementation(async (id: string) => (id === 'failing' ? { ok: false, status: 500 } : { ok: false, status: 404 }));

  await purgeExpiredFlashTrash(NOW);

  assert.deepEqual(Object.keys(trash() ?? {}), ['failing']);
});

test('restoring takes a session out of the trash so it is never purged later', async () => {
  server['dhc.flashTrash'] = { s1: daysAgo(2), s2: daysAgo(2) };

  await forgetFlashTrash('s1');

  assert.deepEqual(Object.keys(trash() ?? {}), ['s2']);
});

test('days left counts down from 7 and never shows less than 1 while waiting', () => {
  assert.equal(flashTrashDaysLeft(new Date(NOW).toISOString(), NOW), 7);
  assert.equal(flashTrashDaysLeft(new Date(NOW + 45_000).toISOString(), NOW), 7, 'a sidebar clock a tick behind still says 7');
  assert.equal(flashTrashDaysLeft(daysAgo(6.5), NOW), 1);
  assert.equal(flashTrashDaysLeft(daysAgo(9), NOW), 1);
  assert.equal(flashTrashDaysLeft(undefined, NOW), null);
});
