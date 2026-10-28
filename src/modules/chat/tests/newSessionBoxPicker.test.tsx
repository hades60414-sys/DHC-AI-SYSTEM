import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

/** DHC CLI 收納盒: a new conversation's page says which box it will land in, and that can be changed. */

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

const boxes = await import('@/shared/sessionBoxes');
const { default: NewSessionBoxPicker } = await import('@/modules/chat/transcript/NewSessionBoxPicker');

test('hidden while the project has no boxes', () => {
  const { container } = render(<NewSessionBoxPicker projectId="none" />);

  assert.equal(container.innerHTML, '');
});

test('shows the box picked by the sidebar +, and the conversation lands where the picker says', async () => {
  server['dhc.boxes:pk'] = { boxes: [{ id: 'r', name: '報表' }, { id: 'y', name: '研究' }], assign: {} };
  await boxes.loadSessionBoxes();
  boxes.setNewSessionBox('pk', 'r');
  render(<NewSessionBoxPicker projectId="pk" />);

  const picker = screen.getByRole('combobox') as HTMLSelectElement;
  assert.equal(picker.value, 'r');

  fireEvent.change(picker, { target: { value: 'y' } });
  boxes.fileNewSessionIntoBox('pk', 'new1');

  assert.equal(boxes.readProjectBoxes('pk').assign.new1, 'y');
});

test('choosing 不放收納盒 keeps the conversation outside', async () => {
  server['dhc.boxes:pn'] = { boxes: [{ id: 'r', name: '報表' }], assign: {} };
  await boxes.loadSessionBoxes();
  boxes.setNewSessionBox('pn', 'r');
  render(<NewSessionBoxPicker projectId="pn" />);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
  boxes.fileNewSessionIntoBox('pn', 'new2');

  assert.equal(boxes.readProjectBoxes('pn').assign.new2, undefined);
});
