import assert from 'node:assert/strict';

import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import { loadDistillSessions } from '@/shared/distillSessions';

import { setNightQueueMarks } from '@/shared/nightQueueMarks';
import SessionTypeBadge from '@/modules/sidebar/SessionTypeBadge';

/** DHC CLI 10/02: the moon / bolt on a session row's logo; 10/06 the 蒸餾模式 flask. */

const distillMarks: string[] = [];
vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () => ({
        ok: true,
        json: async () => ({ success: true, preferences: { 'dhc.distillSessions': [...distillMarks] } }),
      }),
      savePreferences: async () => ({ ok: true, json: async () => ({ success: true }) }),
    },
  },
}));

afterEach(async () => {
  act(() => setNightQueueMarks([]));
  distillMarks.length = 0;
  await act(async () => {
    await loadDistillSessions();
  });
});

test('a flask on 蒸餾模式 sessions; the bolt still wins and names it', async () => {
  distillMarks.push('d1', 'd2');
  await act(async () => {
    await loadDistillSessions();
  });
  render(<SessionTypeBadge sessionId="d1" isFlash={false} />);
  render(<SessionTypeBadge sessionId="d2" isFlash />);

  assert.ok(screen.getByRole('img', { name: '蒸餾模式：這個對話的判斷會記下來，結案時整理成技能' }));
  assert.ok(screen.getByRole('img', { name: '快閃任務：做完按 ×，7 天後自動刪除（蒸餾模式）' }));
});

test('a bolt on flash sessions, nothing on ordinary ones', () => {
  const flash = render(<SessionTypeBadge sessionId="s1" isFlash />);
  assert.ok(screen.getByRole('img', { name: '快閃任務：做完按 ×，7 天後自動刪除' }));
  flash.unmount();

  const plain = render(<SessionTypeBadge sessionId="s1" isFlash={false} />);
  assert.equal(plain.container.innerHTML, '');
});

test('a moon while the night queue holds the session, and it wins over the bolt', () => {
  act(() => setNightQueueMarks([
    { sessionId: 's1', enabled: true, queued: 2 },
    { sessionId: 's2', enabled: true, queued: 0 },
  ]));
  render(<SessionTypeBadge sessionId="s1" isFlash />);
  render(<SessionTypeBadge sessionId="s2" isFlash={false} />);

  assert.ok(screen.getByRole('img', { name: '夜間分流：已存 2 則，等排程開跑（快閃任務）' }));
  assert.ok(screen.getByRole('img', { name: '夜間分流開著：新訊息會先存起來' }));
  assert.equal(screen.queryByRole('img', { name: '快閃任務：做完按 ×，7 天後自動刪除' }), null);
});
