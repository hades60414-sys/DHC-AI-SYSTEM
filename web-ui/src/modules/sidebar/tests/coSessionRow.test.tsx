import assert from 'node:assert/strict';

import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';
import { setDhcConfig } from '@/shared/dhcConfig';

/**
 * DHC CLI Co-workspace in the sidebar: a shared session shows its people where the model logo was, its menu
 * offers 「Co-workspace」, and the people it is shared with find it under their own project.
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

type OptionsProps = { sessionId: string; projectId: string | null; canDelete?: boolean; isShared?: boolean; onShare?: () => void };
const optionsProps: OptionsProps[] = [];
vi.mock('@/modules/sidebar/SessionOptions', () => ({
  default: (props: OptionsProps) => {
    optionsProps.push(props);
    return null;
  },
}));

const co = await import('@/shared/coSessions');
const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');
const { default: SidebarProjectSessions } = await import('@/modules/sidebar/SidebarProjectSessions');

const t = ((key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key)) as unknown as SidebarProjectListProps['t'];
const noop = () => {};
const NOW = new Date('2026-10-08T03:10:00.000Z');
const sessionNamed = (id: string, summary: string) => (
  { id, summary, lastActivity: '2026-10-08T03:00:00.000Z', __provider: 'claude' } as unknown as SessionWithProvider
);
const projectNamed = (projectId: string) => ({
  projectId,
  name: projectId,
  displayName: projectId,
  fullPath: `C:\\Users\\demo\\DHC Workspace\\${projectId}`,
  sessions: [],
}) as unknown as Project;

const rowProps = {
  selectedSession: null,
  isProcessing: false,
  needsAttention: false,
  currentTime: NOW,
  isEditing: false,
  renameDraft: '',
  onRenameDraftChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  onProjectSelect: noop,
  onDeleteSession: noop,
  t,
};

const listProps = {
  isExpanded: true,
  selectedSession: null,
  initialSessionsLoaded: true,
  hasMoreSessions: false,
  isLoadingMoreSessions: false,
  activeSessions: new Set<string>(),
  attentionSessionIds: new Set<string>(),
  currentTime: NOW,
  sessionRenameId: null,
  sessionRenameDraft: '',
  onRenameDraftChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  onProjectSelect: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  onNewSession: noop,
  t,
};

const lastOptions = () => optionsProps[optionsProps.length - 1];
const share = (sessionId: string, ownerProjectId: string, members: string[], title = '月報') => (
  co.setCoSessionMembers(sessionId, { ownerProjectId, title, provider: 'claude' }, members)
);

// Co-Work is a team feature (dhc.config.json "mode": "team").
beforeEach(() => setDhcConfig({ mode: 'team' }));
afterEach(() => setDhcConfig({ mode: 'personal' }));

test('personal mode: no Co-workspace in the menu, and a shared session keeps the model logo', async () => {
  server['dhc.profiles'] = [{ id: 'po', name: 'Olive', projectId: 'olive' }, { id: 'pa', name: 'Amy', projectId: 'amy' }];
  await co.loadCoSessions();
  await share('sharedPersonal', 'olive', ['amy']);
  setDhcConfig({ mode: 'personal' });

  render(<SidebarSessionItem {...rowProps} project={projectNamed('olive')} session={sessionNamed('sharedPersonal', '月報')} onSessionSelect={noop} />);

  assert.equal(screen.queryByLabelText(/^共享：/), null);
  assert.equal(lastOptions().onShare, undefined);
});

test('an unshared session keeps the model logo and offers Co-workspace', () => {
  render(<SidebarSessionItem {...rowProps} project={projectNamed('olive')} session={sessionNamed('plain', '月報')} onSessionSelect={noop} />);

  assert.equal(screen.queryByLabelText(/^共享：/), null);
  assert.equal(lastOptions().isShared, false);
  assert.equal(typeof lastOptions().onShare, 'function');
});

test('a shared session shows its people instead of the model logo', async () => {
  server['dhc.profiles'] = [{ id: 'po', name: 'Olive', projectId: 'olive' }, { id: 'pa', name: 'Amy', projectId: 'amy' }];
  await co.loadCoSessions();
  await share('shared1', 'olive', ['amy']);

  render(<SidebarSessionItem {...rowProps} project={projectNamed('olive')} session={sessionNamed('shared1', '月報')} onSessionSelect={noop} />);

  assert.ok(screen.getByLabelText('共享：Olive、Amy'));
  assert.equal(lastOptions().isShared, true);
});

test('Co-workspace in the menu opens the share dialog for that session', () => {
  render(<SidebarSessionItem {...rowProps} project={projectNamed('olive')} session={sessionNamed('toShare', '週報')} onSessionSelect={noop} />);

  lastOptions().onShare?.();

  const target = renderHook(() => co.useCoShareTarget()).result.current;
  assert.deepEqual(target, { sessionId: 'toShare', ownerProjectId: 'olive', title: '週報', provider: 'claude' });
  co.openCoShareDialog(null);
});

test('the session is listed under a member project and opens under its owner', async () => {
  await share('fromOlive', 'olive', ['amy'], 'Olive 的月報');
  const opened: Array<[string, string]> = [];

  render(
    <SidebarProjectSessions
      {...listProps}
      project={projectNamed('amy')}
      sessions={[sessionNamed('amyOwn', 'Amy 自己的')]}
      onSessionSelect={(session, projectId) => opened.push([session.id, projectId])}
    />,
  );

  assert.ok(screen.getByTitle('Amy 自己的'));
  fireEvent.click(screen.getByTitle('Olive 的月報'));

  assert.deepEqual(opened, [['fromOlive', 'olive']]);
  const sharedRow = optionsProps.filter((props) => props.sessionId === 'fromOlive').pop();
  assert.equal(sharedRow?.projectId, 'olive', 'rename goes to the owner project');
  assert.equal(sharedRow?.canDelete, false, 'a member cannot delete a session that is not theirs');
});

test('a project the session is not shared with does not list it', async () => {
  await share('notForBob', 'olive', ['amy'], '只給 Amy');

  render(<SidebarProjectSessions {...listProps} project={projectNamed('bob')} sessions={[]} onSessionSelect={noop} />);

  assert.equal(screen.queryByTitle('只給 Amy'), null);
});
