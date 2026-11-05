import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import { MessageFiles } from '@/modules/chat-room/files';

/** 10/21: an image whose file is gone from the server used to stay a grey loading box forever. */

vi.mock('@/shared/api', () => ({ api: { assets: { file: async () => new Response('', { status: 404 }) } } }));

test('a missing image says so instead of loading forever', async () => {
  const view = render(<MessageFiles roomId="r" files={[{ name: 'a.png', stored: '1-2-a.png', size: 10, type: 'image/png' }]} />);
  await waitFor(() => assert.ok(view.getByTestId('chat-file-missing').textContent?.includes('a.png')));
});
