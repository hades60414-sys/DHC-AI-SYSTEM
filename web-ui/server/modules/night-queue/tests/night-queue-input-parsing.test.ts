import assert from 'node:assert/strict';
import test from 'node:test';

import { readRunFailure } from '@/modules/night-queue/services/night-queue-dispatcher.service.js';
import { readStartAt } from '@/modules/night-queue/services/night-queue.service.js';
import { AppError } from '@/shared/utils.js';

type RunRecord = Parameters<typeof readRunFailure>[0];

/** Only `events` is read, so the rest of the run record is left out. */
const runWith = (events: Array<Record<string, unknown>>): RunRecord => ({ events } as unknown as RunRecord);

// ---------------------------------------------------------------------------
// readRunFailure
// ---------------------------------------------------------------------------

test('readRunFailure treats a missing run or an unfinished run as no failure', () => {
  assert.equal(readRunFailure(undefined), null);
  assert.equal(readRunFailure(runWith([{ kind: 'text', role: 'assistant', content: 'working' }])), null);
});

test('readRunFailure treats a clean exit as no failure', () => {
  assert.equal(readRunFailure(runWith([{ kind: 'complete', exitCode: 0 }])), null);
});

test('readRunFailure reports an aborted run as stopped', () => {
  assert.deepEqual(readRunFailure(runWith([{ kind: 'complete', exitCode: 1, aborted: true }])), {
    reason: '執行中被停止（有人按了停止，或在這個對話送出了新訊息）。',
    stopped: true,
  });
});

test('readRunFailure prefers the error event, then the last assistant text, then a generic reason', () => {
  assert.deepEqual(
    readRunFailure(runWith([
      { kind: 'text', role: 'assistant', content: 'earlier text' },
      { kind: 'error', content: '  usage limit reached  ' },
      { kind: 'complete', exitCode: 1 },
    ])),
    { reason: 'usage limit reached', stopped: false },
  );

  assert.deepEqual(
    readRunFailure(runWith([
      { kind: 'text', role: 'user', content: 'not the assistant' },
      { kind: 'text', role: 'assistant', content: 'first' },
      { kind: 'text', role: 'assistant', content: 'last words' },
      { kind: 'complete', exitCode: 2 },
    ])),
    { reason: 'last words', stopped: false },
  );

  assert.deepEqual(readRunFailure(runWith([{ kind: 'complete', exitCode: 1 }])), {
    reason: '執行沒有正常結束（可能是用量上限或 API 錯誤），詳見對話。',
    stopped: false,
  });
});

test('readRunFailure uses the first complete event and caps the reason at 300 characters', () => {
  const result = readRunFailure(runWith([
    { kind: 'error', content: 'z'.repeat(500) },
    { kind: 'complete', exitCode: 1 },
    { kind: 'complete', exitCode: 0 },
  ]));
  assert.deepEqual(result, { reason: 'z'.repeat(300), stopped: false });
});

// ---------------------------------------------------------------------------
// readStartAt
// ---------------------------------------------------------------------------

const NOW = new Date('2026-01-10T12:00:00.000Z');

test('readStartAt returns null when no start time is given', () => {
  for (const raw of [undefined, null, '']) {
    assert.equal(readStartAt(raw, NOW), null);
  }
});

test('readStartAt normalizes a future instant to ISO', () => {
  assert.equal(readStartAt('2026-01-10T20:00:00+08:00', NOW), '2026-01-10T12:00:00.000Z');
  assert.equal(readStartAt('2026-01-11T00:00:00Z', NOW), '2026-01-11T00:00:00.000Z');
});

test('readStartAt allows one minute of clock skew into the past', () => {
  assert.equal(readStartAt('2026-01-10T11:59:00.000Z', NOW), '2026-01-10T11:59:00.000Z');
});

test('readStartAt rejects unreadable values', () => {
  for (const raw of ['not a time', 12345, { at: 'x' }]) {
    assert.throws(
      () => readStartAt(raw, NOW),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_START_AT' && error.statusCode === 400,
    );
  }
});

test('readStartAt rejects times already past by more than a minute', () => {
  assert.throws(
    () => readStartAt('2026-01-10T11:58:59.000Z', NOW),
    (error: unknown) => error instanceof AppError && error.code === 'START_AT_PASSED' && error.statusCode === 400,
  );
});

test('readStartAt rejects times more than 14 days ahead', () => {
  assert.equal(readStartAt('2026-01-24T12:00:00.000Z', NOW), '2026-01-24T12:00:00.000Z');
  assert.throws(
    () => readStartAt('2026-01-24T12:00:00.001Z', NOW),
    (error: unknown) => error instanceof AppError && error.code === 'START_AT_TOO_FAR' && error.statusCode === 400,
  );
});
