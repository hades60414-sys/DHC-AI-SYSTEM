import assert from 'node:assert/strict';

import { render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import UsageTracker, { fillHours, paceNote } from '@/modules/tool-library/tools/UsageTracker';

/** DHC CLI 10/27 用量追蹤: official percent from /_usage, who spent it from /_usage/top, and a pace estimate. */

const H = 3_600_000;
const t0 = Date.parse('2026-10-27T12:00:00Z');
const win = (over: Record<string, unknown> = {}) => ({
  start: new Date(t0).toISOString(), end: new Date(t0 + 5 * H).toISOString(), percent: 40, edge_from: 'oauth',
  total: { w: 1000, n: 12, sessions: 2, cr: 0, cw: 0, out: 0 },
  by_person: [{ person: '小明', w: 800, n: 10, sessions: 1, share: 0.8, 對話: 800, 排程與系統: 0 }, { person: '系統', w: 200, n: 2, sessions: 1, share: 0.2, 對話: 0, 排程與系統: 200 }],
  by_kind: [{ kind: '對話', w: 800, n: 10, sessions: 1, share: 0.8 }, { kind: '排程與系統', w: 200, n: 2, sessions: 1, share: 0.2 }],
  top: [
    { id: 's1', title: '大對話', person: '小明', kind: '對話', where: '小明', w: 800, n: 10, share: 0.8, sub_share: 0.3, maxctx: 600_000, last: new Date(t0 + H).toISOString(), model: 'opus-5-5' },
    { id: 's2', title: '晨檢', person: '系統', kind: '排程與系統', where: 'cc-hosts', w: 200, n: 2, share: 0.2, sub_share: 0, maxctx: 20_000, last: new Date(t0).toISOString(), model: 'haiku-5-5' },
  ],
  last_hour_w: 500,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

test('pace: 40% from 1000 units, last hour 500 units = 20%/h → 100% three hours later, before the reset', () => {
  const now = t0 + H;
  const note = paceNote(win() as never, now)!;
  assert.match(note, /每小時約 20%/);
  assert.match(note, /用完，比重置早 60 分鐘/);
  assert.match(paceNote(win({ last_hour_w: 100 }) as never, now)!, /撐得到/);
  assert.equal(paceNote(win({ percent: null }) as never, now), null);
});

test('shows official percent, people, and the costliest sessions with a large-context flag', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    headers: { get: () => null },
    json: async () => (url === '/_usage/top'
      ? { generated_at: new Date().toISOString(), weights: 'w', windows: { session: win(), week: win({ series: [] }), today: win() } }
      : { session: { percent: 40, resets_at: new Date(t0 + 5 * H).toISOString() } }),
  })));
  render(<UsageTracker isMobile={false} onClose={() => {}} profileName="測試" profileId="p" onStartWork={null} />);
  await waitFor(() => screen.getByText('40%'));
  assert.ok(within(screen.getByRole('region', { name: '每個人' })).getByText('小明'));
  const top = screen.getByRole('region', { name: '最燒的對話' });
  assert.ok(within(top).getByText('大對話'));
  assert.ok(within(top).getByText('600k').className.includes('amber'));
  assert.ok(within(top).getByText(/子代理 30%/));
});

test('hourly series keeps empty hours so the axis is real time', () => {
  const filled = fillHours([{ t: new Date(t0).toISOString(), 對話: 5, 排程與系統: 0 }, { t: new Date(t0 + 3 * H).toISOString(), 對話: 1, 排程與系統: 2 }], new Date(t0 + 60_000).toISOString(), t0 + 3 * H + 1);
  assert.deepEqual(filled.map((e) => e.對話 + e.排程與系統), [5, 0, 0, 3]);
});

test('an old scan on refresh is fetched again once, so a rename shows', async () => {
  let calls = 0;
  const payload = (title: string, at: number) => ({ generated_at: new Date(at).toISOString(), weights: 'w', windows: { session: win({ top: [{ ...win().top[0], title }] }), week: win(), today: win() } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    headers: { get: () => null },
    json: async () => (url === '/_usage/top' ? (calls++ === 0 ? payload('舊名字', Date.now() - 60_000) : payload('新名字', Date.now())) : {}),
  })));
  render(<UsageTracker isMobile={false} onClose={() => {}} profileName="測試" profileId="p" onStartWork={null} />);
  await waitFor(() => screen.getByText('新名字'), { timeout: 5_000 });
  assert.equal(calls, 2);
});
