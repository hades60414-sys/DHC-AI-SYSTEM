import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import UsageMeters from '@/modules/sidebar/UsageMeters';
import UsageTracker from '@/modules/tool-library/tools/UsageTracker';

/** 11/01: after a failed refresh the usage tracker and the sidebar's 本週分流 say the numbers are old instead of looking current. */

const H = 3_600_000;
const t0 = Date.parse('2026-10-27T12:00:00Z');
const win = {
  start: new Date(t0).toISOString(), end: new Date(t0 + 5 * H).toISOString(), percent: 40, edge_from: 'oauth',
  total: { w: 1000, n: 12, sessions: 2, cr: 0, cw: 0, out: 0, in: 600 },
  by_person: [{ person: '小明', w: 800, n: 10, sessions: 1, share: 0.8, 對話: 800, 排程與系統: 0 }, { person: '系統', w: 200, n: 2, sessions: 1, share: 0.2, 對話: 0, 排程與系統: 200 }],
  by_kind: [{ kind: '對話', w: 800, n: 10, sessions: 1, share: 0.8 }, { kind: '排程與系統', w: 200, n: 2, sessions: 1, share: 0.2 }],
  top: [
    { id: 's1', title: '大對話', person: '小明', kind: '對話', where: '小明', w: 800, n: 10, share: 0.8, sub_share: 0.3, maxctx: 600_000, last: new Date(t0 + H).toISOString(), model: 'opus-5-5' },
  ],
  last_hour_w: 500,
  offload: { Codex: { tokens: 600, calls: 3, models: {} } },
};
const topPayload = () => ({ generated_at: new Date().toISOString(), weights: 'w', windows: { session: win, week: win, today: win } });

let topFails = false;
afterEach(() => {
  topFails = false;
  vi.unstubAllGlobals();
});
const stubFetch = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  if (url === '/_usage/top') {
    if (topFails) throw new Error('offline');
    return { ok: true, json: async () => topPayload(), headers: { get: (): null => null } };
  }
  return {
    ok: true,
    json: async () => ({ session: { percent: 40, resets_at: new Date(t0 + 5 * H).toISOString() }, fetched_at: new Date().toISOString() }),
    headers: { get: (): null => null },
  };
}));

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
const staleNote = () => document.querySelector('[role="alert"]')?.textContent ?? '';

test('the usage tracker keeps the last numbers but says 更新失敗 with their time once a refresh fails', async () => {
  stubFetch();
  render(<UsageTracker isMobile={false} onClose={() => {}} profileName="測試" profileId="p" onStartWork={null} />);
  await settle();
  assert.equal(staleNote(), '');
  topFails = true;
  fireEvent.click(screen.getByRole('button', { name: '重新整理' }));
  await settle();
  assert.match(staleNote(), /^更新失敗，顯示的是 [0-9]{2}:[0-9]{2} 的資料$/);
  assert.ok(document.body.textContent?.includes('小明'), 'the old numbers stay on screen');
  topFails = false;
  fireEvent.click(screen.getByRole('button', { name: '重新整理' }));
  await settle();
  assert.equal(staleNote(), '');
});

test('the sidebar split marks itself old after a failed refresh and clears when it works again', async () => {
  stubFetch();
  render(<UsageMeters />);
  await waitFor(() => screen.getByTestId('offload-split'));
  assert.ok(!screen.getByTestId('offload-split').textContent?.includes('更新失敗'));
  topFails = true;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => assert.match(screen.getByTestId('offload-split').textContent ?? '', /更新失敗，顯示的是 \d\d:\d\d 的資料/));
  topFails = false;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => assert.ok(!screen.getByTestId('offload-split').textContent?.includes('更新失敗')));
});
