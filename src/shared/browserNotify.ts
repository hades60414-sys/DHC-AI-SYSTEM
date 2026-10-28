/**
 * DHC CLI 2026-09-26: browser notifications while a tab is open (Notification API, no push service).
 *
 * Web Push exists too (service worker + VAPID on the server) but needs the browser's push service,
 * which the company network may not let through, and nobody had subscribed. This path fires from the
 * websocket events the page already receives, so it works wherever the page itself works. It honours
 * the same event toggles as the settings tab (action required / run stopped / run failed), plus one
 * local switch: only notify when the tab is not in front of the user (default on).
 */
export type BrowserNotifyKind = 'actionRequired' | 'stop' | 'error';

type EventToggles = Record<BrowserNotifyKind, boolean>;

const ENABLED_KEY = 'browserNotify.enabled';
const ONLY_BACKGROUND_KEY = 'browserNotify.onlyBackground';
const EVENTS_KEY = 'browserNotify.events';
const NAVIGATE_EVENT = 'dhc:navigate-session';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows or blocked storage: the switch just does not persist.
  }
};

export const isBrowserNotifySupported = (): boolean =>
  typeof window !== 'undefined' && typeof Notification !== 'undefined';

export const getBrowserNotifyPermission = (): NotificationPermission | 'unsupported' =>
  (isBrowserNotifySupported() ? Notification.permission : 'unsupported');

export const isBrowserNotifyEnabled = (): boolean => read(ENABLED_KEY) === 'true';
export const setBrowserNotifyEnabled = (enabled: boolean): void => write(ENABLED_KEY, String(enabled));

/** Default true: while the user is looking at the page, the transcript itself is the notification. */
export const isBrowserNotifyOnlyBackground = (): boolean => read(ONLY_BACKGROUND_KEY) !== 'false';
export const setBrowserNotifyOnlyBackground = (only: boolean): void => write(ONLY_BACKGROUND_KEY, String(only));

/** Mirrors the settings tab's event toggles so the notifier can read them synchronously. */
export const setBrowserNotifyEvents = (events: EventToggles): void => write(EVENTS_KEY, JSON.stringify(events));

export const getBrowserNotifyEvents = (): EventToggles => {
  try {
    const parsed = JSON.parse(read(EVENTS_KEY) || '') as Partial<EventToggles>;
    return {
      actionRequired: parsed.actionRequired !== false,
      stop: parsed.stop !== false,
      error: parsed.error !== false,
    };
  } catch {
    return { actionRequired: true, stop: true, error: true };
  }
};

/** Asks the browser once; resolves to the resulting permission. */
export const requestBrowserNotifyPermission = async (): Promise<NotificationPermission | 'unsupported'> => {
  if (!isBrowserNotifySupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
};

const pageInFront = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();

/**
 * Shows one notification for a session event. Returns true when it was shown.
 * `force` skips the enabled / background / event checks (the settings test button).
 */
export const notifyBrowser = (input: {
  kind: BrowserNotifyKind;
  sessionId?: string | null;
  title: string;
  body?: string;
  force?: boolean;
}): boolean => {
  if (!isBrowserNotifySupported() || Notification.permission !== 'granted') return false;
  if (!input.force) {
    if (!isBrowserNotifyEnabled()) return false;
    if (!getBrowserNotifyEvents()[input.kind]) return false;
    if (isBrowserNotifyOnlyBackground() && pageInFront()) return false;
  }
  try {
    const notification = new Notification(input.title, {
      body: input.body || '',
      icon: '/logo-256.png',
      // One live notification per session and kind: a burst of events replaces, not stacks.
      tag: `${input.sessionId || 'global'}:${input.kind}`,
      silent: true,
    });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // Some browsers refuse programmatic focus; the click still brings the tab up.
      }
      if (input.sessionId) {
        window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { sessionId: input.sessionId } }));
      }
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
};

/** Subscribes to clicks on our notifications; the handler routes to the session. */
export const onBrowserNotifyNavigate = (handler: (sessionId: string) => void): (() => void) => {
  const listener = (event: Event) => {
    const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
    if (sessionId) handler(sessionId);
  };
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => window.removeEventListener(NAVIGATE_EVENT, listener);
};
