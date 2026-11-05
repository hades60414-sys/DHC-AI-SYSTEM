import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';
import { readQuotaReset } from '@/modules/chat/utils/nightQueueTime';

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubUsage = (response: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({
  ...response as object,
  headers: { get: (): null => null },
})));

test('an unreadable quota is not reported as reset', async () => {
  stubUsage({ ok: true, json: async () => { throw new Error('not json'); } });
  assert.equal(await readQuotaReset(), 'unknown');
  stubUsage({ ok: false });
  assert.equal(await readQuotaReset(), 'unknown');
  stubUsage({ ok: true, json: async () => ({ session: { resets_at: new Date(Date.now() - 60_000).toISOString() } }) });
  assert.equal(await readQuotaReset(), 'fresh');
  const later = new Date(Date.now() + 3_600_000);
  stubUsage({ ok: true, json: async () => ({ session: { resets_at: later.toISOString() } }) });
  assert.deepEqual(await readQuotaReset(), later);
});

test('the popover says the quota time could not be read instead of "已是新的"', async () => {
  stubUsage({ ok: false });
  render(<ScheduleMessagePopover disabled={false} onSchedule={() => undefined} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });
  assert.ok(await screen.findByText('讀不到額度時間'));
  assert.equal(screen.queryByText('額度已是新的'), null);
});

test('a blocked clock is disabled and carries the reason as its tooltip', () => {
  render(<ScheduleMessagePopover disabled={false} disabledReason="排程只支援文字" onSchedule={() => undefined} />);
  const button = screen.getByRole('button') as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.equal(button.title, '排程只支援文字');
});
