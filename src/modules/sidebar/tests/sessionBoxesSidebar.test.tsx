import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * DHC CLI 收納盒 in the sidebar: under a project, boxes come first and hold the sessions moved into
 * them; everything not moved stays outside. Sessions move by drag and drop, and a box's + starts a
 * conversation that lands in it.
 */

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

vi.mock('@/modules/sidebar/SidebarSessionItem', () => ({
  default: ({ session }: { session: SessionWithProvider }) => <div data-row={session.id}>{session.id}</div>,
}));

const boxes = await import('@/shared/sessionBoxes');
const { default: SidebarProjectSessions } = await import('@/modules/sidebar/SidebarProjectSessions');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};
const NONE: ReadonlySet<string> = new Set<string>();

let projectSeq = 0;
const newProject = (folder = '同事B') => {
  projectSeq += 1;
  return {
    projectId: `p${projectSeq}`,
    name: folder,
    displayName: folder,
    fullPath: `C:\\Users\\demo\\DHC Workspace\\${folder}`,
    sessions: [],
  } as unknown as Project;
};
const sessionsOf = (...ids: string[]) => ids.map((id) => ({ id, summary: id, __provider: 'claude' })) as unknown as SessionWithProvider[];
const dataTransfer = () => ({ dropEffect: '', effectAllowed: '', setData: noop, getData: () => '' });

/** Gives the project one box 報表 holding `inBox`. Ids differ per test, because which boxes are open is module state. */
const withBox = async (project: Project, inBox: string[] = []) => {
  const id = `${project.projectId}-box`;
  server[`dhc.boxes:${project.projectId}`] = {
    boxes: [{ id, name: '報表' }],
    assign: Object.fromEntries(inBox.map((sessionId) => [sessionId, id])),
  };
  await boxes.loadSessionBoxes();
  return id;
};

const boxElement = (id: string) => document.querySelector(`[data-session-box="${id}"]`) as HTMLElement;
const rowIds = (root: HTMLElement) => [...root.querySelectorAll('[data-row]')].map((row) => row.getAttribute('data-row'));

type Overrides = Partial<{
  sessions: SessionWithProvider[];
  hasMoreSessions: boolean;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
}>;

const renderSessions = (project: Project, overrides: Overrides = {}) => {
  const props = {
    project,
    isExpanded: true,
    sessions: overrides.sessions ?? sessionsOf('s1', 's2', 's3'),
    selectedSession: null,
    initialSessionsLoaded: true,
    hasMoreSessions: overrides.hasMoreSessions ?? false,
    isLoadingMoreSessions: false,
    activeSessions: NONE,
    attentionSessionIds: NONE,
    currentTime: new Date('2026-10-02T08:00:00.000Z'),
    sessionRenameId: null,
    sessionRenameDraft: '',
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    onDeleteSession: noop,
    onLoadMoreSessions: overrides.onLoadMoreSessions ?? noop,
    onNewSession: overrides.onNewSession ?? noop,
    t,
  };
  const view = render(<SidebarProjectSessions {...props} />);
  return { ...view, rerenderWith: (next: Overrides) => view.rerender(<SidebarProjectSessions {...props} {...next} />) };
};

beforeEach(() => {
  boxes.endSessionDrag();
});

test('a box shows its count; opened, it holds its sessions and the rest stay outside', async () => {
  const project = newProject();
  const boxId = await withBox(project, ['s2']);
  renderSessions(project);

  assert.deepEqual(rowIds(document.body), ['s1', 's3'], 'a closed box hides its sessions');
  assert.ok(within(boxElement(boxId)).getByText('1'));

  fireEvent.click(within(boxElement(boxId)).getByRole('button', { name: /^報表/ }));

  assert.deepEqual(rowIds(boxElement(boxId)), ['s2']);
  assert.deepEqual(rowIds(document.body), ['s2', 's1', 's3']);
});

test('dropping a row on a box moves it in; dropping a boxed row outside moves it out', async () => {
  const project = newProject();
  const boxId = await withBox(project);
  renderSessions(project);

  boxes.startSessionDrag({ sessionId: 's1', projectId: project.projectId });
  fireEvent.dragOver(boxElement(boxId), { dataTransfer: dataTransfer() });
  fireEvent.drop(boxElement(boxId), { dataTransfer: dataTransfer() });

  assert.equal(boxes.readProjectBoxes(project.projectId).assign.s1, boxId);
  assert.deepEqual(rowIds(document.body), ['s2', 's3']);

  boxes.startSessionDrag({ sessionId: 's1', projectId: project.projectId });
  const outsideZone = await screen.findByText('拖到這裡移出收納盒');
  fireEvent.dragOver(outsideZone, { dataTransfer: dataTransfer() });
  fireEvent.drop(outsideZone, { dataTransfer: dataTransfer() });

  assert.equal(boxes.readProjectBoxes(project.projectId).assign.s1, undefined);
  assert.equal(screen.queryByText('拖到這裡移出收納盒'), null);
  assert.deepEqual(rowIds(document.body), ['s1', 's2', 's3']);
});

test('a row from another project is not accepted', async () => {
  const project = newProject();
  const boxId = await withBox(project);
  renderSessions(project);

  boxes.startSessionDrag({ sessionId: 'x1', projectId: 'someone-else' });
  fireEvent.drop(boxElement(boxId), { dataTransfer: dataTransfer() });

  assert.deepEqual(boxes.readProjectBoxes(project.projectId).assign, {});
});

test('an open box whose sessions are on older pages loads more, and stops when a page brings nothing', async () => {
  const project = newProject();
  const boxId = await withBox(project, ['old1']);
  boxes.toggleBoxOpen(boxId);
  const onLoadMoreSessions = vi.fn();
  const view = renderSessions(project, { sessions: sessionsOf('s1'), hasMoreSessions: true, onLoadMoreSessions });

  assert.deepEqual(onLoadMoreSessions.mock.calls, [[project.projectId]]);

  view.rerenderWith({ sessions: sessionsOf('s1'), onLoadMoreSessions });
  assert.equal(onLoadMoreSessions.mock.calls.length, 1, 'no new sessions came in: do not ask again');

  view.rerenderWith({ sessions: sessionsOf('s1', 's2'), onLoadMoreSessions });
  assert.equal(onLoadMoreSessions.mock.calls.length, 2);

  view.rerenderWith({ sessions: sessionsOf('s1', 's2', 'old1'), onLoadMoreSessions });
  assert.equal(onLoadMoreSessions.mock.calls.length, 2, 'the box is complete');
  assert.deepEqual(rowIds(boxElement(boxId)), ['old1']);
});

test('the + on a box starts a conversation filed into it; the plain button clears that pick', async () => {
  const project = newProject();
  const boxId = await withBox(project);
  const onNewSession = vi.fn();
  renderSessions(project, { onNewSession });

  fireEvent.click(screen.getByRole('button', { name: '在「報表」開新對話' }));
  assert.equal(onNewSession.mock.calls.length, 1);
  boxes.fileNewSessionIntoBox(project.projectId, 'n1');
  assert.equal(boxes.readProjectBoxes(project.projectId).assign.n1, boxId);

  fireEvent.click(screen.getByRole('button', { name: '在「報表」開新對話' }));
  fireEvent.click(screen.getByRole('button', { name: /sessions\.newSession/ }));
  boxes.fileNewSessionIntoBox(project.projectId, 'n2');
  assert.equal(boxes.readProjectBoxes(project.projectId).assign.n2, undefined);
});

test('a box is created from the name field', async () => {
  const project = newProject();
  renderSessions(project);

  fireEvent.click(screen.getByRole('button', { name: '新增收納盒' }));
  const field = screen.getByRole('textbox', { name: '收納盒名稱' });
  fireEvent.change(field, { target: { value: '週報' } });
  fireEvent.keyDown(field, { key: 'Enter' });

  assert.equal(screen.queryByRole('textbox', { name: '收納盒名稱' }), null);
  assert.ok(screen.getByRole('button', { name: /^週報/ }));
  assert.deepEqual(boxes.readProjectBoxes(project.projectId).boxes.map((box) => box.name), ['週報']);
});

test('the flash zone keeps a flat list: no boxes, no box button', async () => {
  const project = newProject('快閃任務區');
  const boxId = await withBox(project, ['s2']);
  renderSessions(project);

  assert.equal(screen.queryByRole('button', { name: '新增收納盒' }), null);
  assert.equal(boxElement(boxId), null);
  assert.deepEqual(rowIds(document.body), ['s1', 's2', 's3']);
});
