import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project, SidebarProjectListProps } from '@/shared/types';

/**
 * DHC CLI: "load more sessions" decided whether to fetch inside a state updater. React runs an updater
 * later when the component already has an update queued, so the fetch was skipped while the loading
 * flag still got set: the button stayed on "loading" for good. The 收納盒 auto-load calls it from an
 * effect, which is exactly that situation.
 */

const okResponse = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) });
vi.mock('@/shared/api', () => ({
  api: new Proxy({}, { get: () => new Proxy(() => okResponse(), { get: () => () => okResponse() }) }),
}));
const paletteOps = new Proxy({}, { get: () => () => {} });
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => paletteOps }));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};
const PROJECTS: Project[] = [];
const NONE: ReadonlySet<string> = new Set<string>();

test('loading more still fetches when the sidebar already has an update queued', async () => {
  const onLoadMoreSessions = vi.fn(async () => {});
  const { result } = renderHook(() => useSidebarController({
    projects: PROJECTS,
    selectedProject: null,
    selectedSession: null,
    activeSessions: NONE,
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    onLoadMoreSessions,
    setCurrentProject: noop,
    setSidebarVisible: noop,
    sidebarVisible: true,
  }));

  act(() => {
    result.current.setSearchMode('conversations');
    void result.current.loadMoreSessionsForProject('p1');
  });

  await waitFor(() => assert.deepEqual(onLoadMoreSessions.mock.calls, [['p1']]));
  await waitFor(() => assert.equal(result.current.loadingMoreProjects.has('p1'), false));
});
