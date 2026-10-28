import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as FlashTasks from '@/shared/flashTasks';
import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/** DHC CLI 10/02 快閃任務區: rows of that project carry an × that deletes at once, without the dialog. */

const endFlashSession = vi.fn();
vi.mock('@/shared/flashTasks', async (importOriginal) => ({
  ...(await importOriginal<typeof FlashTasks>()),
  endFlashSession: (...args: unknown[]) => endFlashSession(...args),
}));
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key)) as unknown as SidebarProjectListProps['t'];
const noop = () => {};

const project = (fullPath: string) => ({ projectId: 'p1', name: 'p1', displayName: 'p1', fullPath, sessions: [] }) as unknown as Project;
const FLASH = project('C:\\Users\\demo\\DHC Workspace\\快閃任務區');
const OTHER = project('C:\\Users\\demo\\DHC Workspace\\工具實驗');
const SESSION = { id: 's1', summary: '查匯率', lastActivity: '2026-10-02T03:00:00.000Z', __provider: 'claude' } as unknown as SessionWithProvider;

type RowOverrides = { isProcessing?: boolean; onDeleteSession?: () => void; onSessionSelect?: () => void };

const renderRow = (rowProject: Project, overrides: RowOverrides = {}) => render(
  <SidebarSessionItem
    project={rowProject}
    session={SESSION}
    selectedSession={null}
    isProcessing={overrides.isProcessing ?? false}
    needsAttention={false}
    currentTime={new Date('2026-10-02T03:10:00.000Z')}
    isEditing={false}
    renameDraft=""
    onRenameDraftChange={noop}
    onStartEditingSession={noop}
    onCancelEditingSession={noop}
    onSaveEditingSession={noop}
    onProjectSelect={noop}
    onSessionSelect={overrides.onSessionSelect ?? noop}
    onDeleteSession={overrides.onDeleteSession ?? noop}
    t={t}
  />,
);

const endButton = () => screen.queryByRole('button', { name: '結束 查匯率' });

afterEach(() => {
  endFlashSession.mockReset();
});

test('a flash row ends on the × without opening the archive-or-delete dialog', () => {
  const onDeleteSession = vi.fn();
  const onSessionSelect = vi.fn();
  renderRow(FLASH, { onDeleteSession, onSessionSelect });

  const button = endButton();
  assert.ok(button);
  fireEvent.click(button);

  assert.deepEqual(endFlashSession.mock.calls, [['s1']]);
  assert.equal(onDeleteSession.mock.calls.length, 0);
  assert.equal(onSessionSelect.mock.calls.length, 0);
});

test('flash rows carry the bolt on their logo; other rows do not', () => {
  const other = renderRow(OTHER);
  assert.ok(screen.queryByRole('img', { name: /快閃任務/ }) === null, 'expected no bolt');
  other.unmount();

  renderRow(FLASH);
  assert.ok(screen.getByRole('img', { name: '快閃任務：做完按 ×，7 天後自動刪除' }));
});

test('no × outside the flash zone, nor while the session is running', () => {
  const other = renderRow(OTHER);
  assert.ok(endButton() === null, 'expected no end button');
  other.unmount();

  renderRow(FLASH, { isProcessing: true });
  assert.ok(endButton() === null, 'expected no end button');
});
