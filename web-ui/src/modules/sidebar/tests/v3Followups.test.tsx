import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import { visibleRecentTotal } from '@/modules/sidebar/hooks/useSidebarController';
import zhSidebar from '@/modules/i18n/locales/zh-TW/sidebar.json';
import zhCommon from '@/modules/i18n/locales/zh-TW/common.json';
import enCommon from '@/modules/i18n/locales/en/common.json';

/** V3 test follow-ups: recents count, zh-TW strings, Co-Work delay note, empty vs loading project list. */

vi.mock('@/shared/api', () => ({
  api: {
    projects: async () => new Response(JSON.stringify([{ projectId: 'q', displayName: 'Q', name: 'q', path: 'D:/x/內部資料查詢', fullPath: 'D:/x/內部資料查詢', sessions: [] }])),
    renameSession: async () => ({ ok: true }),
    user: {
      preferences: async () => ({ ok: true, json: async () => ({ success: true, preferences: {} }) }),
      savePreferences: async () => ({ ok: true, json: async () => ({ success: true }) }),
    },
  },
}));
vi.mock('@/shared/userSettings', async (original) => ({
  ...(await original<typeof import('@/shared/userSettings')>()),
  listSettingsProfiles: () => [],
  readActiveSettingsProfileId: () => null,
}));

test('recents count drops the rows the filter hides, never below the visible rows', () => {
  assert.equal(visibleRecentTotal(3, 3, 1), 1);
  assert.equal(visibleRecentTotal(40, 20, 15), 35);
  assert.equal(visibleRecentTotal(2, 5, 5), 5);
});

test('zh-TW has the strings that used to fall back to English', () => {
  assert.equal(zhSidebar.running.emptyTitle, '目前沒有執行中的對話');
  assert.equal(zhSidebar.archived.restore, '還原對話');
  assert.equal(zhSidebar.search.archiveOnlyTooltip, '只看已封存');
  const keys = (o: Record<string, unknown>, prefix = ''): string[] => Object.entries(o).flatMap(([k, v]) => (
    v && typeof v === 'object' ? keys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));
  assert.deepEqual(keys(zhCommon.commandPalette).sort(), keys(enCommon.commandPalette).sort());
  assert.equal(zhCommon.commandPalette.title, '指令面板');
});

test('Co-Work dialog tells the sharer the other side may take about a minute', async () => {
  const co = await import('@/shared/coSessions');
  const { default: CoShareDialog } = await import('@/modules/sidebar/CoShareDialog');
  const projects = ['A', 'B'].map((n) => ({ projectId: n, name: n, displayName: n, path: `C:/Users/demo/DHC Workspace/${n}`, fullPath: `C:/Users/demo/DHC Workspace/${n}`, sessions: [] }));
  render(<CoShareDialog projects={projects as never} />);
  act(() => co.openCoShareDialog({ sessionId: 's1', ownerProjectId: 'A', title: 't', provider: 'claude' } as never));
  assert.equal(screen.queryByTestId('co-share-delay-note'), null);
  fireEvent.click(screen.getByRole('checkbox', { name: /B/ }));
  assert.match(screen.getByTestId('co-share-delay-note').textContent!, /1 分鐘/);
});

test('新增個人專案 with a loaded list that has nothing usable says so, not 「還沒載入」', async () => {
  const { SettingsProfilePicker } = await import('@/modules/sidebar/SettingsProfileGate');
  render(<SettingsProfilePicker />);
  const button = screen.getByRole('button', { name: /新增個人專案/ });
  fireEvent.click(button);
  assert.match(screen.getByRole('alert').textContent!, /還沒載入/);
  await waitFor(async () => {
    fireEvent.click(button);
    assert.match(screen.getByRole('alert').textContent!, /已載入，但沒有可用的專案/);
  });
});
