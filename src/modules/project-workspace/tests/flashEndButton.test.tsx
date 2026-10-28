import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as FlashTasks from '@/shared/flashTasks';
import type { AppTab, Project, ProjectSession } from '@/shared/types';

/** DHC CLI 10/02 快閃任務區: the open flash session can be ended from above the chat. */

const endFlashSession = vi.fn();
let busy: ReadonlySet<string> = new Set();
vi.mock('@/shared/flashTasks', async (importOriginal) => ({
  ...(await importOriginal<typeof FlashTasks>()),
  endFlashSession: (...args: unknown[]) => endFlashSession(...args),
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({ useBusySessionIdSet: () => busy }));
vi.mock('@/modules/project-workspace/WorkspaceTitle', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/WorkspaceTabs', () => ({ default: () => null }));

const { default: WorkspaceHeader } = await import('@/modules/project-workspace/WorkspaceHeader');

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const project = (fullPath: string) => ({ projectId: 'p1', name: 'p1', displayName: 'p1', fullPath }) as unknown as Project;
const FLASH = project('C:\\Users\\demo\\DHC Workspace\\快閃任務區');
const OTHER = project('C:\\Users\\demo\\DHC Workspace\\工具實驗');
const SESSION = { id: 's1', summary: '查匯率', __provider: 'claude' } as unknown as ProjectSession;

const renderHeader = (selectedProject: Project, selectedSession: ProjectSession | null, activeTab: AppTab = 'chat') => render(
  <WorkspaceHeader
    activeTab={activeTab}
    setActiveTab={() => {}}
    selectedProject={selectedProject}
    selectedSession={selectedSession}
    shouldShowTasksTab={false}
    shouldShowBrowserTab={false}
    isMobile={false}
    onMenuClick={() => {}}
  />,
);

const endButton = () => screen.queryByRole('button', { name: /結束任務/ });

afterEach(() => {
  endFlashSession.mockReset();
  busy = new Set();
});

test('an open flash session shows 結束任務, which ends it straight away', () => {
  renderHeader(FLASH, SESSION);
  const button = endButton();
  assert.ok(button);
  fireEvent.click(button);
  assert.deepEqual(endFlashSession.mock.calls, [['s1']]);
});

test('hidden for other projects, a new session, other tabs, and while it runs', () => {
  const cases: Array<() => ReturnType<typeof renderHeader>> = [
    () => renderHeader(OTHER, SESSION),
    () => renderHeader(FLASH, null),
    () => renderHeader(FLASH, SESSION, 'files'),
    () => {
      busy = new Set(['s1']);
      return renderHeader(FLASH, SESSION);
    },
  ];
  for (const renderCase of cases) {
    const view = renderCase();
    assert.ok(endButton() === null, 'expected no end button');
    view.unmount();
  }
});
