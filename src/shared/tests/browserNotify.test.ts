import assert from 'node:assert/strict';

import { afterEach, beforeEach, test } from 'vitest';

import {
  getBrowserNotifyEvents,
  notifyBrowser,
  setBrowserNotifyEnabled,
  setBrowserNotifyEvents,
  setBrowserNotifyOnlyBackground,
} from '@/shared/browserNotify';

/** DHC CLI 9/26: in-page browser notifications — gating by opt-in, event toggle and "only in background". */

const shown: Array<{ title: string; options: NotificationOptions | undefined }> = [];
const instances: FakeNotification[] = [];
let permission: NotificationPermission = 'granted';
let visibility: DocumentVisibilityState = 'visible';
let focused = true;

class FakeNotification {
  static get permission() { return permission; }
  onclick: (() => void) | null = null;
  constructor(title: string, options?: NotificationOptions) {
    shown.push({ title, options });
    instances.push(this);
  }
  close() {}
}

beforeEach(() => {
  localStorage.clear();
  shown.length = 0;
  instances.length = 0;
  permission = 'granted';
  visibility = 'visible';
  focused = true;
  (globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  document.hasFocus = () => focused;
});

afterEach(() => {
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
});

test('nothing fires until the user opted in', () => {
  assert.equal(notifyBrowser({ kind: 'stop', sessionId: 's1', title: 'done' }), false);
  assert.equal(shown.length, 0);
});

test('opted in + tab in background: fires, tagged per session and kind', () => {
  setBrowserNotifyEnabled(true);
  visibility = 'hidden';
  assert.equal(notifyBrowser({ kind: 'stop', sessionId: 's1', title: 'done', body: 'my session' }), true);
  assert.equal(shown[0].title, 'done');
  assert.equal(shown[0].options?.tag, 's1:stop');
});

test('tab in front stays quiet by default, but notifies when "only background" is off', () => {
  setBrowserNotifyEnabled(true);
  assert.equal(notifyBrowser({ kind: 'actionRequired', sessionId: 's1', title: 'q' }), false);
  setBrowserNotifyOnlyBackground(false);
  assert.equal(notifyBrowser({ kind: 'actionRequired', sessionId: 's1', title: 'q' }), true);
});

test('event toggles from the settings tab are honoured; defaults are all on', () => {
  setBrowserNotifyEnabled(true);
  visibility = 'hidden';
  assert.deepEqual(getBrowserNotifyEvents(), { actionRequired: true, stop: true, error: true });
  setBrowserNotifyEvents({ actionRequired: true, stop: false, error: true });
  assert.equal(notifyBrowser({ kind: 'stop', sessionId: 's1', title: 'done' }), false);
  assert.equal(notifyBrowser({ kind: 'error', sessionId: 's1', title: 'err' }), true);
});

test('denied permission never fires, even when forced', () => {
  setBrowserNotifyEnabled(true);
  permission = 'denied';
  assert.equal(notifyBrowser({ kind: 'stop', sessionId: 's1', title: 'done', force: true }), false);
});

test('a click routes to the session through the navigate event', () => {
  setBrowserNotifyEnabled(true);
  visibility = 'hidden';
  let routed: string | null = null;
  window.addEventListener('dhc:navigate-session', (event) => {
    routed = (event as CustomEvent<{ sessionId: string }>).detail.sessionId;
  });
  notifyBrowser({ kind: 'stop', sessionId: 's9', title: 'done' });
  const instance = instances[instances.length - 1];
  assert.ok(instance?.onclick);
  instance.onclick?.();
  assert.equal(routed, 's9');
});
