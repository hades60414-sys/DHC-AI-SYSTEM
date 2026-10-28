import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/** DHC CLI 收納盒 on one session row: it drags (desktop) and its menu offers the other boxes. */

const server: Record<string, unknown> = {};

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () => ({ ok: true, json: async () => ({ success: true, preferences: structuredClone(server) }) }),
      savePreferences: async (updates: Record<string, unknown>) => {
        Object.assign(server, structuredClone(updates));
        return { ok: true, json: async () => ({ success: true }) };
      },
    },
  },
}));

type BoxMenu = { otherBoxes: Array<{ id: string; name: string }>; isInBox: boolean; onMove: (boxId: string | null) => void };
const optionsProps: Array<{ boxMenu?: BoxMenu }> = [];
vi.mock('@/modules/sidebar/SessionOptions', () => ({
  default: (props: { boxMenu?: BoxMenu }) => {
    optionsProps.push(props);
    return null;
  },
}));

const boxes = await import('@/shared/sessionBoxes');
const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key)) as unknown as SidebarProjectListProps['t'];
const noop = () => {};
const SESSION = { id: 's1', summary: '月報', lastActivity: '2026-10-02T03:00:00.000Z', __provider: 'claude' } as unknown as SessionWithProvider;
const projectNamed = (projectId: string) => ({
  projectId,
  name: projectId,
  displayName: projectId,
  fullPath: `C:\\Users\\demo\\DHC Workspace\\${projectId}`,
  sessions: [],
}) as unknown as Project;

const renderRow = (project: Project) => render(
  <SidebarSessionItem
    project={project}
    session={SESSION}
    selectedSession={null}
    isProcessing={false}
    needsAttention={false}
    currentTime={new Date('2026-10-02T03:10:00.000Z')}
    isEditing={false}
    renameDraft=""
    onRenameDraftChange={noop}
    onStartEditingSession={noop}
    onCancelEditingSession={noop}
    onSaveEditingSession={noop}
    onProjectSelect={noop}
    onSessionSelect={noop}
    onDeleteSession={noop}
    t={t}
  />,
);

const link = () => screen.getByRole('link');
const lastBoxMenu = () => optionsProps[optionsProps.length - 1]?.boxMenu;

test('without boxes the row offers no box moves and drags like a plain link', () => {
  renderRow(projectNamed('rowA'));

  assert.equal(lastBoxMenu(), undefined);
  fireEvent.dragStart(link(), { dataTransfer: { setData: noop, effectAllowed: '' } });
  assert.equal(boxes.readDraggedSession(), null);
});

test('a boxed row offers the other boxes and a way out, and moves when picked', async () => {
  server['dhc.boxes:rowB'] = {
    boxes: [{ id: 'b1', name: '報表' }, { id: 'b2', name: '研究' }],
    assign: { s1: 'b1' },
  };
  await boxes.loadSessionBoxes();
  renderRow(projectNamed('rowB'));

  const menu = lastBoxMenu();
  assert.ok(menu);
  assert.deepEqual(menu.otherBoxes.map((box) => box.name), ['研究']);
  assert.equal(menu.isInBox, true);

  menu.onMove(null);
  assert.equal(boxes.readProjectBoxes('rowB').assign.s1, undefined);
});

test('dragging the row tells the boxes which session is coming, until the drag ends', async () => {
  server['dhc.boxes:rowC'] = { boxes: [{ id: 'c1', name: '報表' }], assign: {} };
  await boxes.loadSessionBoxes();
  renderRow(projectNamed('rowC'));

  fireEvent.dragStart(link(), { dataTransfer: { setData: noop, effectAllowed: '' } });
  assert.deepEqual(boxes.readDraggedSession(), { sessionId: 's1', projectId: 'rowC' });

  fireEvent.dragEnd(link());
  assert.equal(boxes.readDraggedSession(), null);
});
