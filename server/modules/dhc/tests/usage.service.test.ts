import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { USAGE_URL, createUsageService, loginInfoOf, parseUsageResponse } from '@/modules/dhc/usage.service.js';

const NOW = Date.parse('2026-10-14T04:00:00.000Z');
const DAY = 86_400_000;

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dhc-usage-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const writeCredentials = (dir: string, oauth: Record<string, unknown>) =>
  writeFile(path.join(dir, 'credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));

test('not logged in: a clear error, and Anthropic is never called', async () => {
  await withDir(async (dir) => {
    let calls = 0;
    const usage = createUsageService({
      credentialsFile: path.join(dir, 'missing.json'),
      cacheFile: path.join(dir, 'cache.json'),
      fetchImpl: async () => { calls += 1; return { status: 200, json: async () => ({}) }; },
      now: () => NOW,
    });
    assert.deepEqual(await usage.read(), { error: 'not_logged_in', login: { state: 'logged_out' } });
    assert.equal(calls, 0);
  });
});

test('the token goes only to the usage endpoint and never back to the browser', async () => {
  await withDir(async (dir) => {
    await writeCredentials(dir, { accessToken: 'secret-token', refreshToken: 'r', expiresAt: NOW + DAY, refreshTokenExpiresAt: NOW + 30 * DAY });
    const seen: { url: string; auth: string }[] = [];
    const usage = createUsageService({
      credentialsFile: path.join(dir, 'credentials.json'),
      cacheFile: path.join(dir, 'cache.json'),
      fetchImpl: async (url, init) => {
        seen.push({ url, auth: init.headers.Authorization });
        return { status: 200, json: async () => ({ five_hour: { utilization: 42, resets_at: '2026-10-14T06:00:00Z' } }) };
      },
      now: () => NOW,
    });
    const payload = await usage.read();
    assert.deepEqual(seen, [{ url: USAGE_URL, auth: 'Bearer secret-token' }]);
    assert.equal(payload.session?.percent, 42);
    assert.equal(payload.login.state, 'ok');
    assert.doesNotMatch(JSON.stringify(payload), /secret-token/);
  });
});

test('after a 429 the last good numbers are served as stale and Anthropic is left alone for 5 minutes', async () => {
  await withDir(async (dir) => {
    await writeCredentials(dir, { accessToken: 't', refreshToken: 'r', expiresAt: NOW + DAY });
    let clock = NOW;
    let status = 200;
    let calls = 0;
    const usage = createUsageService({
      credentialsFile: path.join(dir, 'credentials.json'),
      cacheFile: path.join(dir, 'cache.json'),
      fetchImpl: async () => { calls += 1; return { status, json: async () => ({ seven_day: { utilization: 10, resets_at: null } }) }; },
      now: () => clock,
    });
    await usage.read();
    status = 429;
    clock += 2 * 60_000;
    await usage.refresh();
    const stale = await usage.read();
    assert.equal(stale.stale, true);
    assert.equal(stale.reason, 'upstream_429');
    assert.equal(stale.weekly_all?.percent, 10);

    clock += 4 * 60_000;
    await usage.refresh();
    assert.equal(calls, 2, 'still backing off');
    clock += 2 * 60_000;
    await usage.refresh();
    assert.equal(calls, 3);
  });
});

test('nobody looking for 15 minutes: the timer stops asking Anthropic', async () => {
  await withDir(async (dir) => {
    await writeCredentials(dir, { accessToken: 't', refreshToken: 'r', expiresAt: NOW + DAY });
    let clock = NOW;
    let calls = 0;
    const usage = createUsageService({
      credentialsFile: path.join(dir, 'credentials.json'),
      cacheFile: path.join(dir, 'cache.json'),
      fetchImpl: async () => { calls += 1; return { status: 200, json: async () => ({}) }; },
      now: () => clock,
    });
    await usage.read();
    clock += 16 * 60_000;
    await usage.refresh();
    assert.equal(calls, 1);
  });
});

test('an expired access token is reported instead of being sent', async () => {
  await withDir(async (dir) => {
    await writeCredentials(dir, { accessToken: 't', refreshToken: 'r', expiresAt: NOW - 1 });
    let calls = 0;
    const usage = createUsageService({
      credentialsFile: path.join(dir, 'credentials.json'),
      cacheFile: path.join(dir, 'cache.json'),
      fetchImpl: async () => { calls += 1; return { status: 200, json: async () => ({}) }; },
      now: () => NOW,
    });
    assert.equal((await usage.read()).error, 'token_expired');
    assert.equal(calls, 0);
  });
});

test('the login warning starts a week before the refresh token runs out', () => {
  assert.equal(loginInfoOf({ refreshToken: 'r', refreshTokenExpiresAt: NOW + 10 * DAY }, NOW).state, 'ok');
  assert.deepEqual(loginInfoOf({ refreshToken: 'r', refreshTokenExpiresAt: NOW + 3 * DAY }, NOW).days_left, 3);
  assert.equal(loginInfoOf({ refreshToken: 'r', refreshTokenExpiresAt: NOW + 3 * DAY }, NOW).state, 'expiring');
  assert.equal(loginInfoOf({ refreshToken: 'r', refreshTokenExpiresAt: NOW - DAY }, NOW).state, 'expired');
});

test('the newer limits list is preferred over the older window fields', () => {
  const data = parseUsageResponse({
    limits: [{ kind: 'session', percent: 5, resets_at: 'a' }, { kind: 'weekly_scoped', percent: 9, resets_at: 'b', scope: { model: { display_name: 'Fable 5.1' } } }],
    five_hour: { utilization: 99, resets_at: 'x' },
  }, NOW);
  assert.equal(data.session?.percent, 5);
  assert.equal(data.weekly_fable?.percent, 9);
  assert.equal(data.weekly_all, null);
});
