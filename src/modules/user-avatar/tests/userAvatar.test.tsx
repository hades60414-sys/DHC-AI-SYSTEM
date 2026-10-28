import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

/**
 * DHC CLI 頭像: the avatar is a setting of this device's profile (專案設定). The avatar beside a user message
 * shows that profile's pick, clicking it opens the picker, and a pick or 「恢復預設」 is saved under this
 * profile's key only.
 */

const server: Record<string, unknown> = {
  'dhc.profiles': [{ id: 'pa', name: '同事C' }, { id: 'pb', name: '同事A' }],
  'p:pa:userAvatar': 'geo-fox',
  'p:pb:userAvatar': 'soft-koala',
};

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

localStorage.setItem('dhc.settingsProfile', 'pa');
const { hydrateUserPreferences } = await import('@/shared/userSettings');
const { UserAvatarButton } = await import('@/modules/user-avatar');
await hydrateUserPreferences();

test("shows this profile's face, and a pick saves to this profile only", async () => {
  render(<UserAvatarButton className="h-8 w-8" />);
  await screen.findByRole('img', { name: '狐狸' });

  fireEvent.click(screen.getByRole('button', { name: '換頭像' }));
  assert.ok(screen.getByText('選頭像・同事C'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /貓熊/ }));
  });

  await waitFor(() => assert.equal(server['p:pa:userAvatar'], 'geo-panda'));
  assert.equal(server['p:pb:userAvatar'], 'soft-koala');
  assert.ok(screen.getByRole('img', { name: '貓熊' }));
});

test('恢復預設 brings back the 「U」', async () => {
  render(<UserAvatarButton className="h-8 w-8" />);
  fireEvent.click(screen.getAllByRole('button', { name: '換頭像' }).at(-1)!);
  await act(async () => {
    fireEvent.click(screen.getByText('恢復預設「U」'));
  });

  await waitFor(() => assert.equal(server['p:pa:userAvatar'], ''));
  assert.ok(screen.getAllByText('U').length > 0);
});
