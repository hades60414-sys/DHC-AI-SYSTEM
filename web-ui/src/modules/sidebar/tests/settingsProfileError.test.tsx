import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

/** 10/25 R4: a failed 建立設定檔 shows the friendly line and a 詳細 fold with the raw reason (it used to crash on render). */
vi.mock('@/shared/api', () => ({
  api: { projects: async () => new Response(JSON.stringify([{ projectId: 'proj-me', displayName: '小明', name: 'me', path: 'C:/Users/demo/DHC Workspace/小明', fullPath: 'C:/Users/demo/DHC Workspace/小明', sessions: [] }])) },
}));
vi.mock('@/shared/userSettings', async (original) => ({
  ...(await original<typeof import('@/shared/userSettings')>()),
  listSettingsProfiles: () => [],
  readActiveSettingsProfileId: () => null,
  createSettingsProfile: async () => { throw new Error('HTTP 500 boom'); },
}));

const { SettingsProfilePicker } = await import('@/modules/sidebar/SettingsProfileGate');

test('a failed create shows the friendly message and 詳細 with the raw error', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<SettingsProfilePicker />);
  fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /小明/ })));
  const alert = await waitFor(() => screen.getByRole('alert'));
  assert.match(alert.textContent!, /建立設定檔失敗/);
  assert.ok(screen.getByText('詳細'));
  assert.ok(screen.getByText('HTTP 500 boom'));
});
