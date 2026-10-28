import assert from 'node:assert/strict';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/**
 * The store that replaced a dozen hand-rolled localStorage readers with one
 * server-backed copy. What matters here is the two behaviours the move must not
 * get wrong: an existing install's settings survive the migration, and a read
 * stays synchronous so the first paint is not a flash of defaults.
 *
 * Each test loads a fresh module copy because the store reads its localStorage
 * mirror once at module scope.
 */

type SavedPayload = Record<string, unknown>;

const saved: SavedPayload[] = [];
let serverPreferences: Record<string, unknown> = {};
let preferencesRequestFailed = false;

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () => {
        if (preferencesRequestFailed) {
          throw new Error('offline');
        }
        return new Response(JSON.stringify({ success: true, preferences: serverPreferences }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      savePreferences: async (updates: SavedPayload) => {
        saved.push(updates);
        return new Response('{}', { status: 200 });
      },
    },
  },
}));

const loadStore = async () => {
  vi.resetModules();
  return import('@/shared/userSettings');
};

beforeEach(() => {
  localStorage.clear();
  saved.length = 0;
  serverPreferences = {};
  preferencesRequestFailed = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a write is readable synchronously and reaches the server after the debounce', async () => {
  const store = await loadStore();

  store.writeUserPreference('theme', 'dark');

  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
  assert.deepEqual(saved, [], 'the request must not fire on every keystroke');

  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(saved, [{ theme: 'dark' }]);
});

test('a burst of writes collapses into one request carrying every change', async () => {
  const store = await loadStore();

  store.writeUserPreference('theme', 'dark');
  store.writeUserPreference('userLanguage', 'de');
  store.writeUserPreference('tasksEnabled', true);

  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(saved, [{ theme: 'dark', userLanguage: 'de', tasksEnabled: true }]);
});

test('writing the value a preference already has sends nothing and notifies nobody', async () => {
  const store = await loadStore();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(500);
  saved.length = 0;

  const listener = vi.fn();
  store.subscribeToUserPreferences(listener);
  store.writeUserPreference('theme', 'dark');

  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(saved, []);
  expect(listener).not.toHaveBeenCalled();
});

test('a value written in one page load is readable synchronously in the next', async () => {
  const first = await loadStore();
  first.writeUserPreference('theme', 'dark');

  // No hydrate: this is the very first paint of the next load, before any
  // network request could have resolved.
  const second = await loadStore();
  assert.equal(second.readUserPreference('theme', 'light'), 'dark');
});

test('hydrate adopts the server copy over the local mirror', async () => {
  const store = await loadStore();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(500);

  serverPreferences = { theme: 'light' };
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'light');
  assert.equal(store.hasHydratedUserPreferences(), true);
});

test('hydrate seeds a preference the server has never seen from its legacy key', async () => {
  localStorage.setItem('theme', 'dark');
  localStorage.setItem('tasks-enabled', 'true');
  localStorage.setItem('selected-provider', 'codex');
  localStorage.setItem('uiPreferences', JSON.stringify({ showThinking: false }));

  const store = await loadStore();
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
  assert.equal(store.readUserPreference('tasksEnabled', false), true);
  assert.equal(store.readUserPreference('selectedProvider', 'claude'), 'codex');
  assert.deepEqual(store.readUserPreference('uiPreferences', {}), { showThinking: false });

  await vi.advanceTimersByTimeAsync(500);
  assert.equal(saved.length, 1, 'the migrated values are pushed up in one request');
  assert.equal((saved[0] as Record<string, unknown>).theme, 'dark');
});

test('hydrate splits the legacy claude-settings blob into permissions and sort order', async () => {
  localStorage.setItem('claude-settings', JSON.stringify({
    allowedTools: ['Read'],
    disallowedTools: ['Bash'],
    skipPermissions: true,
    projectSortOrder: 'date',
    lastUpdated: '2026-01-01T00:00:00.000Z',
  }));

  const store = await loadStore();
  await store.hydrateUserPreferences();

  assert.deepEqual(store.readUserPreference('claudePermissions', null), {
    allowedTools: ['Read'],
    disallowedTools: ['Bash'],
    skipPermissions: true,
  });
  assert.equal(store.readUserPreference('projectSortOrder', 'name'), 'date');
});

test('hydrate reassembles the four separate code-editor keys into one preference', async () => {
  localStorage.setItem('codeEditorWordWrap', 'true');
  localStorage.setItem('codeEditorShowMinimap', 'false');
  localStorage.setItem('codeEditorFontSize', '16');

  const store = await loadStore();
  await store.hydrateUserPreferences();

  assert.deepEqual(store.readUserPreference('codeEditorSettings', null), {
    wordWrap: true,
    showMinimap: false,
    fontSize: '16',
  });
});

test('a legacy value is never allowed to overwrite what the server already holds', async () => {
  localStorage.setItem('theme', 'dark');
  serverPreferences = { theme: 'light' };

  const store = await loadStore();
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'light');
  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(saved, [], 'nothing was migrated, so nothing is pushed up');
});

test('a failed hydrate keeps the mirrored values instead of snapping back to defaults', async () => {
  const store = await loadStore();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(500);

  preferencesRequestFailed = true;
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
  assert.equal(store.hasHydratedUserPreferences(), false);
});

test('hydrate cancels a write queued before it, so a second device cannot clobber the server', async () => {
  // The failure this pins, observed end to end: on a device with an empty
  // mirror, ThemeProvider started on the system default and queued
  // `theme: light`; hydrate then delivered the stored `dark` and the component
  // stopped writing because the in-memory value already matched — so the stale
  // `light` flushed a moment later and reset the user's theme for every device.
  serverPreferences = { theme: 'dark' };
  const store = await loadStore();

  store.writeUserPreference('theme', 'light');
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(500);

  assert.deepEqual(saved, [], 'the pre-hydrate write must not reach the server');
  assert.equal(store.readUserPreference('theme', null), 'dark');
});

test('hydrate leaves a queued write for a key the server has no answer for', async () => {
  serverPreferences = { theme: 'dark' };
  const store = await loadStore();

  store.writeUserPreference('userLanguage', 'de');
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(500);

  assert.deepEqual(saved, [{ userLanguage: 'de' }]);
});

test('reset clears the copy so the next user does not inherit the previous one', async () => {
  const store = await loadStore();
  store.writeUserPreference('theme', 'dark');

  store.resetUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'light');
  assert.equal(localStorage.getItem('user-preferences'), null);
});

// DHC CLI: settings profiles
test('an existing device silently stays on the shared profile; a new device must choose', async () => {
  localStorage.setItem('user-preferences', JSON.stringify({ theme: 'dark' }));
  let store = await loadStore();
  assert.equal(store.needsSettingsProfileChoice(), false);
  assert.equal(store.readActiveSettingsProfileId(), '');
  assert.equal(store.readUserPreference('theme', 'light'), 'dark');

  localStorage.clear();
  store = await loadStore();
  assert.equal(store.needsSettingsProfileChoice(), true);
});

test('a profile reads and writes its own namespaced keys, leaving shared keys alone', async () => {
  localStorage.setItem('dhc.settingsProfile', 'abc');
  serverPreferences = {
    'dhc.profiles': [{ id: 'abc', name: 'Alex' }],
    selectedProvider: 'codex',
    'p:abc:selectedProvider': 'claude',
  };
  const store = await loadStore();
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('selectedProvider', 'x'), 'claude');
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(saved, [{ 'p:abc:theme': 'dark' }]);
  assert.deepEqual(store.listSettingsProfiles(), [{ id: 'abc', name: 'Alex' }]);
});

test('a device whose profile was deleted elsewhere is asked again', async () => {
  localStorage.setItem('dhc.settingsProfile', 'gone');
  serverPreferences = { 'dhc.profiles': [] };
  const store = await loadStore();
  await store.hydrateUserPreferences();
  assert.equal(store.needsSettingsProfileChoice(), true);
  assert.equal(localStorage.getItem('dhc.settingsProfile'), null);
});

test('creating a profile copies the current settings under the new id', async () => {
  localStorage.setItem('dhc.settingsProfile', '');
  serverPreferences = { theme: 'dark', selectedProvider: 'codex' };
  const store = await loadStore();
  await store.hydrateUserPreferences();

  const id = await store.createSettingsProfile('  Alex ', true);
  const payload = saved.at(-1) as unknown as Record<string, unknown>;
  assert.deepEqual(payload['dhc.profiles'], [{ id, name: 'Alex' }]);
  assert.equal(payload[`p:${id}:theme`], 'dark');
  assert.equal(payload[`p:${id}:selectedProvider`], 'codex');
  assert.equal(payload.theme, undefined, 'shared keys must not be touched');

  store.chooseSettingsProfile(id);
  assert.equal(localStorage.getItem('dhc.settingsProfile'), id);
  expect(localStorage.getItem('user-preferences')).toBeNull();
});

test('a project-linked profile exposes its project and is reused rather than duplicated', async () => {
  localStorage.setItem('dhc.settingsProfile', 'p1');
  serverPreferences = { 'dhc.profiles': [{ id: 'p1', name: '同事A', projectId: 'proj-7' }] };
  const store = await loadStore();
  await store.hydrateUserPreferences();
  assert.equal(store.readActiveSettingsProjectId(), 'proj-7');

  const id = await store.createSettingsProfile('同事A', true, 'proj-7');
  assert.equal(id, 'p1');
  assert.deepEqual(saved, [], 'an existing link must not write a second profile');

  const newId = await store.createSettingsProfile('同事B', false, 'proj-9');
  assert.deepEqual((saved.at(-1) as unknown as Record<string, unknown>)['dhc.profiles'], [
    { id: 'p1', name: '同事A', projectId: 'proj-7' },
    { id: newId, name: '同事B', projectId: 'proj-9' },
  ]);
});
