import { useState } from 'react';
import { Bell, BellOff, BellRing, Loader2, MonitorCheck, Play, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { playChatCompletionSound } from '@/shared/utils';
import {
  getBrowserNotifyPermission,
  isBrowserNotifyEnabled,
  isBrowserNotifyOnlyBackground,
  notifyBrowser,
  requestBrowserNotifyPermission,
  setBrowserNotifyEnabled,
  setBrowserNotifyOnlyBackground,
} from '@/shared/browserNotify';
import type { NotificationPreferencesState } from '@/shared/types';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
  pushPermission: NotificationPermission | 'unsupported';
  isPushSubscribed: boolean;
  isPushLoading: boolean;
  onEnablePush: () => void;
  onDisablePush: () => void;
  isDesktop?: boolean;
  desktopNotifications?: {
    enabled: boolean;
    supported: boolean;
    connectedCount?: number;
    targetCount?: number;
    lastError?: string | null;
  } | null;
  onEnableDesktopNotifications?: () => void;
  onDisableDesktopNotifications?: () => void;
};

/** Rendered by Settings for the "notifications" tab, covering notification channels and events. */
export default function NotificationsSettingsTab({
  notificationPreferences,
  onNotificationPreferencesChange,
  pushPermission,
  isPushSubscribed,
  isPushLoading,
  onEnablePush,
  onDisablePush,
  isDesktop = false,
  desktopNotifications = null,
  onEnableDesktopNotifications,
  onDisableDesktopNotifications,
}: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');

  const pushSupported = pushPermission !== 'unsupported';
  const pushDenied = pushPermission === 'denied';

  // DHC CLI: in-page browser notifications (no push service needed; works while a tab is open).
  const [browserPermission, setBrowserPermission] = useState(() => getBrowserNotifyPermission());
  const [browserEnabled, setBrowserEnabled] = useState(() => isBrowserNotifyEnabled());
  const [onlyBackground, setOnlyBackground] = useState(() => isBrowserNotifyOnlyBackground());
  const browserSupported = browserPermission !== 'unsupported';
  const browserOn = browserEnabled && browserPermission === 'granted';
  const toggleBrowser = async () => {
    if (browserOn) {
      setBrowserNotifyEnabled(false);
      setBrowserEnabled(false);
      return;
    }
    const permission = await requestBrowserNotifyPermission();
    setBrowserPermission(permission);
    if (permission === 'granted') {
      setBrowserNotifyEnabled(true);
      setBrowserEnabled(true);
    }
  };

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-blue-600" />
          <h3 className="text-lg font-medium text-foreground">{t('notifications.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('notifications.description')}</p>
      </div>

      {isDesktop ? (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <h4 className="font-medium text-foreground">
            {t('notifications.desktop.title', { defaultValue: 'Notify this desktop app' })}
          </h4>
          {desktopNotifications?.supported === false ? (
            <p className="text-sm text-muted-foreground">
              {t('notifications.desktop.unsupported', { defaultValue: 'Desktop notifications are not supported on this system.' })}
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (desktopNotifications?.enabled) {
                      onDisableDesktopNotifications?.();
                    } else {
                      onEnableDesktopNotifications?.();
                    }
                  }}
                  className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                    desktopNotifications?.enabled
                      ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                      : 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'
                  }`}
                >
                  {desktopNotifications?.enabled ? (
                    <BellOff className="h-4 w-4" />
                  ) : (
                    <BellRing className="h-4 w-4" />
                  )}
                  {desktopNotifications?.enabled
                    ? t('notifications.desktop.disable', { defaultValue: 'Disable desktop notifications' })
                    : t('notifications.desktop.enable', { defaultValue: 'Enable desktop notifications' })}
                </button>
                {desktopNotifications?.enabled && (
                  <span className="text-sm text-green-600 dark:text-green-400">
                    {t('notifications.desktop.enabled', { defaultValue: 'Desktop notifications are enabled' })}
                  </span>
                )}
              </div>
              {desktopNotifications?.lastError && (
                <p className="text-sm text-red-600 dark:text-red-400">{desktopNotifications.lastError}</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <h4 className="font-medium text-foreground">{t('notifications.webPush.title')}</h4>
          {!pushSupported ? (
            <p className="text-sm text-muted-foreground">{t('notifications.webPush.unsupported')}</p>
          ) : pushDenied ? (
            <p className="text-sm text-muted-foreground">{t('notifications.webPush.denied')}</p>
          ) : (
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={isPushLoading}
                onClick={() => {
                  if (isPushSubscribed) {
                    onDisablePush();
                  } else {
                    onEnablePush();
                  }
                }}
                className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  isPushSubscribed
                    ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                    : 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'
                }`}
              >
                {isPushLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isPushSubscribed ? (
                  <BellOff className="h-4 w-4" />
                ) : (
                  <BellRing className="h-4 w-4" />
                )}
                {isPushLoading
                  ? t('notifications.webPush.loading')
                  : isPushSubscribed
                    ? t('notifications.webPush.disable')
                    : t('notifications.webPush.enable')}
              </button>
              {isPushSubscribed && (
                <span className="text-sm text-green-600 dark:text-green-400">
                  {t('notifications.webPush.enabled')}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <MonitorCheck className="h-4 w-4 text-blue-600" />
            <h4 className="font-medium text-foreground">{t('notifications.browser.title', { defaultValue: '瀏覽器通知（分頁開著時）' })}</h4>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('notifications.browser.description', { defaultValue: '不經推播服務，只要這個分頁還開著就會跳系統通知。適合分頁被切到後面或縮小的時候。' })}
          </p>
        </div>
        {!browserSupported ? (
          <p className="text-sm text-muted-foreground">{t('notifications.browser.unsupported', { defaultValue: '此瀏覽器不支援通知。' })}</p>
        ) : browserPermission === 'denied' ? (
          <p className="text-sm text-muted-foreground">{t('notifications.browser.denied', { defaultValue: '通知已被瀏覽器封鎖，請在網址列左邊的網站設定裡允許。' })}</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => { void toggleBrowser(); }}
                className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                  browserOn
                    ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                    : 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'
                }`}
              >
                {browserOn ? <BellOff className="h-4 w-4" /> : <BellRing className="h-4 w-4" />}
                {browserOn
                  ? t('notifications.browser.disable', { defaultValue: '關閉瀏覽器通知' })
                  : t('notifications.browser.enable', { defaultValue: '啟用瀏覽器通知' })}
              </button>
              {browserOn && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    notifyBrowser({ kind: 'stop', title: 'DHC CLI 測試通知', body: t('notifications.browser.testBody', { defaultValue: '通知會長這樣。點一下會回到對應的 session。' }), force: true });
                  }}
                >
                  <Play className="h-4 w-4" />
                  {t('notifications.browser.test', { defaultValue: '測試通知' })}
                </Button>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={onlyBackground}
                onChange={(event) => {
                  setBrowserNotifyOnlyBackground(event.target.checked);
                  setOnlyBackground(event.target.checked);
                }}
                className="h-4 w-4"
              />
              {t('notifications.browser.onlyBackground', { defaultValue: '只在分頁不在前景時通知（正在看的時候不吵）' })}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('notifications.browser.eventsHint', { defaultValue: '通知哪些事件，用下面「事件類型」的勾選。' })}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-blue-600" />
              <h4 className="font-medium text-foreground">
                {t('notifications.sound.title', { defaultValue: 'Sound' })}
              </h4>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('notifications.sound.description', {
                defaultValue: 'Play a short tone when a chat run finishes.',
              })}
            </p>
          </div>

          <label className="flex shrink-0 items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.channels.sound}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  channels: {
                    ...notificationPreferences.channels,
                    sound: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.sound.enabled', { defaultValue: 'Enabled' })}
          </label>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void playChatCompletionSound({ force: true });
          }}
        >
          <Play className="h-4 w-4" />
          {t('notifications.sound.test', { defaultValue: 'Test sound' })}
        </Button>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <h4 className="font-medium text-foreground">{t('notifications.events.title')}</h4>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.actionRequired}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    actionRequired: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.events.actionRequired')}
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.stop}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    stop: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.events.stop')}
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.error}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    error: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.events.error')}
          </label>
        </div>
      </div>
    </div>
  );
}
