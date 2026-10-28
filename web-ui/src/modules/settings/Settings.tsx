import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useIsTeamMode } from '@/shared/dhcConfig';
import { useTranslation } from 'react-i18next';

import { ProviderLoginModal } from '@/modules/provider-auth';
import { Button } from '@/shared/ui';
import SettingsSidebar from '@/modules/settings/SettingsSidebar';
import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';
import AppearanceSettingsTab, { MyAvatarSection } from '@/modules/settings/tabs/AppearanceSettingsTab';
import CredentialsSettingsTab from '@/modules/settings/tabs/api-settings/CredentialsSettingsTab';
import VoiceSettingsTab from '@/modules/settings/tabs/VoiceSettingsTab';
import GitSettingsTab from '@/modules/settings/tabs/git-settings/GitSettingsTab';
import BrowserUseSettingsTab from '@/modules/settings/tabs/browser-use-settings/BrowserUseSettingsTab';
import NotificationsSettingsTab from '@/modules/settings/tabs/NotificationsSettingsTab';
import TasksSettingsTab from '@/modules/settings/tabs/tasks-settings/TasksSettingsTab';
import { PluginSettingsTab } from '@/modules/plugins';
import AboutTab from '@/modules/settings/tabs/AboutTab';
import { QuickSettingsInline } from '@/modules/quick-settings-panel';
import { SettingsProfilePicker } from '@/modules/sidebar';
import { cn } from '@/shared/utils';
import { useSettingsController } from '@/modules/settings/hooks/useSettingsController';
import { useWebPush } from '@/modules/settings/hooks/useWebPush';
import type { AgentSettingsProject } from '@/shared/types';

type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects?: AgentSettingsProject[];
  initialTab?: string;
};

type DesktopNotificationsState = {
  enabled: boolean;
  supported: boolean;
  connectedCount?: number;
  targetCount?: number;
  lastError?: string | null;
};

/** DHC CLI: the three groups in the dialog header; 詳細設定 holds the original tabs. */
type SettingsGroup = 'project' | 'quick' | 'detail';

const SETTINGS_GROUPS: { id: SettingsGroup; label: string }[] = [
  { id: 'project', label: '專案設定' },
  { id: 'quick', label: '快速設定' },
  { id: 'detail', label: '詳細設定' },
];

/** Exported as the settings module's public entry point and rendered by the sidebar module as its settings dialog. */
function Settings({ isOpen, onClose, projects = [], initialTab = 'agents' }: SettingsProps) {
  const { t } = useTranslation('settings');
  // The sidebar opens with the default tab; other callers (e.g. Browser) ask for a specific detailed tab.
  const requestsDetailTab = initialTab !== 'agents' && initialTab !== 'tools';
  // SidebarModals mounts the dialog on each open, so this initial value is per open.
  const [group, setGroup] = useState<SettingsGroup>(requestsDetailTab ? 'detail' : 'quick');
  const isTeam = useIsTeamMode();
  const desktopNotificationsBridge = useMemo(() => (
    typeof window === 'undefined'
      ? null
      : ((window as any).cloudcliDesktopNotifications || null)
  ), []);
  const [desktopNotificationsState, setDesktopNotificationsState] = useState<DesktopNotificationsState | null>(null);
  const {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    notificationPreferences,
    setNotificationPreferences,
    cursorPermissions,
    setCursorPermissions,
    codexPermissionMode,
    setCodexPermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  } = useSettingsController({
    isOpen,
    initialTab
  });

  const {
    permission: pushPermission,
    isSubscribed: isPushSubscribed,
    isLoading: isPushLoading,
    subscribe: pushSubscribe,
    unsubscribe: pushUnsubscribe,
  } = useWebPush();

  const handleEnablePush = async () => {
    await pushSubscribe();
    // Server sets webPush: true in preferences on subscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: true },
    });
  };

  const handleDisablePush = async () => {
    await pushUnsubscribe();
    // Server sets webPush: false in preferences on unsubscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: false },
    });
  };

  useEffect(() => {
    if (!desktopNotificationsBridge) return undefined;
    let mounted = true;
    desktopNotificationsBridge.getState().then((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    }).catch(() => {});
    const unsubscribe = desktopNotificationsBridge.onStateUpdated?.((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [desktopNotificationsBridge]);

  const handleEnableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: true });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: true },
    });
  };

  const handleDisableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: false });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: false },
    });
  };

  if (!isOpen) {
    return null;
  }

  const isAuthenticated = Boolean(loginProvider && providerAuthStatus[loginProvider].authenticated);

  return (
    <div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm md:p-4">
      <div className="flex h-full w-full flex-col overflow-hidden border border-border bg-background shadow-2xl md:h-[90vh] md:max-w-4xl md:rounded-xl">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3 md:px-5">
          <nav className="flex items-center gap-1" aria-label={t('title')}>
            {SETTINGS_GROUPS.filter((item) => isTeam || item.id !== 'project').map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setGroup(item.id)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  group === item.id
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {saveStatus === 'success' && (
              <span className="animate-in fade-in text-xs text-muted-foreground">{t('saveStatus.success')}</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-10 w-10 touch-manipulation p-0 text-muted-foreground hover:text-foreground active:bg-accent/50"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {group === 'project' && isTeam && (
          <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
            <div className="mx-auto flex max-w-xl flex-col space-y-6">
              <section>
                <h3 className="mb-1 text-sm font-semibold text-foreground">這台裝置套用的專案設定</h3>
                <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                  選你的專案後，這台裝置的主題、語言、模型提供者、權限與介面設定只跟著這個專案走，不會跟別人互相蓋掉；
                  這個專案也會固定排在側欄最上面。對話內容照舊大家都看得到。
                </p>
                <SettingsProfilePicker />
              </section>
              <MyAvatarSection />
            </div>
          </main>
        )}

        {group === 'quick' && (
          <main className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col overflow-y-auto">
            <QuickSettingsInline />
          </main>
        )}

        {/* Body: sidebar + content */}
        <div className={cn('min-h-0 min-w-0 flex-1 flex-col md:flex-row', group === 'detail' ? 'flex' : 'hidden')}>
          <SettingsSidebar activeTab={activeTab} onChange={setActiveTab} />

          {/* Content */}
          <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
            <div key={activeTab} className="settings-content-enter min-w-0 space-y-6 overflow-x-hidden p-4 pb-safe-area-inset-bottom md:space-y-8 md:p-6">
              {activeTab === 'appearance' && (
                <AppearanceSettingsTab
                  projectSortOrder={projectSortOrder}
                  onProjectSortOrderChange={setProjectSortOrder}
                  codeEditorSettings={codeEditorSettings}
                  onCodeEditorWordWrapChange={(value) => updateCodeEditorSetting('wordWrap', value)}
                  onCodeEditorShowMinimapChange={(value) => updateCodeEditorSetting('showMinimap', value)}
                  onCodeEditorLineNumbersChange={(value) => updateCodeEditorSetting('lineNumbers', value)}
                  onCodeEditorFontSizeChange={(value) => updateCodeEditorSetting('fontSize', value)}
                />
              )}

              {activeTab === 'git' && <GitSettingsTab />}

              {activeTab === 'agents' && (
                <AgentsSettingsTab
                  providerAuthStatus={providerAuthStatus}
                  onProviderLogin={openLoginForProvider}
                  claudePermissions={claudePermissions}
                  onClaudePermissionsChange={setClaudePermissions}
                  cursorPermissions={cursorPermissions}
                  onCursorPermissionsChange={setCursorPermissions}
                  codexPermissionMode={codexPermissionMode}
                  onCodexPermissionModeChange={setCodexPermissionMode}
                  projects={projects}
                />
              )}

              {activeTab === 'tasks' && <TasksSettingsTab />}

              {activeTab === 'browser' && <BrowserUseSettingsTab />}

              {activeTab === 'notifications' && (
                <NotificationsSettingsTab
                  notificationPreferences={notificationPreferences}
                  onNotificationPreferencesChange={setNotificationPreferences}
                  pushPermission={pushPermission}
                  isPushSubscribed={isPushSubscribed}
                  isPushLoading={isPushLoading}
                  onEnablePush={handleEnablePush}
                  onDisablePush={handleDisablePush}
                  isDesktop={Boolean(desktopNotificationsBridge)}
                  desktopNotifications={desktopNotificationsState}
                  onEnableDesktopNotifications={handleEnableDesktopNotifications}
                  onDisableDesktopNotifications={handleDisableDesktopNotifications}
                />
              )}

              {activeTab === 'api' && <CredentialsSettingsTab />}

              {activeTab === 'voice' && <VoiceSettingsTab />}

              {activeTab === 'plugins' && <PluginSettingsTab />}

              {activeTab === 'about' && <AboutTab />}
            </div>
          </main>
        </div>
      </div>

      <ProviderLoginModal
        key={loginProvider || 'claude'}
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        provider={loginProvider || 'claude'}
        onComplete={handleLoginComplete}
        isAuthenticated={isAuthenticated}
      />

    </div>
  );
}

export default Settings;
