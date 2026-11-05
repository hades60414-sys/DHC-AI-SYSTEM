import {
  Brain,
  Eye,
  GraduationCap,
  Languages,
  Mic,
  Minimize2,
  Moon,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { DarkModeToggle, ThemePicker } from '@/shared/ui';
import { useTheme } from '@/shared/context/ThemeContext';
import { LanguageSelector } from '@/modules/i18n';
import { SETTING_ROW_CLASS } from '@/shared/constants';
import { cn } from '@/shared/utils';
import type { PreferenceToggleKey, QuickSettingsPreferences } from '@/shared/types';
import QuickSettingsSection from '@/modules/quick-settings-panel/QuickSettingsSection';
import QuickSettingsToggleRow from '@/modules/quick-settings-panel/QuickSettingsToggleRow';

/** Declarative description of one quick settings toggle row - its preference key, translation key and icon - so the rows can be rendered from a list instead of hand-written. */
type PreferenceToggleItem = {
  key: PreferenceToggleKey;
  labelKey: string;
  icon: LucideIcon;
};

const TOOL_DISPLAY_TOGGLES: PreferenceToggleItem[] = [
  {
    key: 'showRawParameters',
    labelKey: 'quickSettings.showRawParameters',
    icon: Eye,
  },
  {
    key: 'showThinking',
    labelKey: 'quickSettings.showThinking',
    icon: Brain,
  },
];

const INPUT_SETTING_TOGGLES: PreferenceToggleItem[] = [
  {
    key: 'sendByCtrlEnter',
    labelKey: 'quickSettings.sendByCtrlEnter',
    icon: Languages,
  },
  {
    key: 'voiceEnabled',
    labelKey: 'quickSettings.voiceEnabled',
    icon: Mic,
  },
];

type QuickSettingsContentProps = {
  isDarkMode: boolean;
  preferences: QuickSettingsPreferences;
  onPreferenceChange: (key: PreferenceToggleKey, value: boolean) => void;
};

/** Rendered by QuickSettingsPanelView to show the drawer's appearance, tool display and input preference rows. */
export default function QuickSettingsContent({
  isDarkMode,
  preferences,
  onPreferenceChange,
}: QuickSettingsContentProps) {
  const { t } = useTranslation('settings');
  const { isPresenter, isMinimal, setMinimal, isTutorial, setTutorial } = useTheme();
  const inputSettingToggles = preferences.voiceEnabled
    ? INPUT_SETTING_TOGGLES
    : INPUT_SETTING_TOGGLES.filter(({ key }) => key !== 'voiceEnabled');

  const renderToggleRows = (items: PreferenceToggleItem[]) => (
    items.map(({ key, labelKey, icon }) => (
      <QuickSettingsToggleRow
        key={key}
        label={t(labelKey)}
        icon={icon}
        checked={preferences[key]}
        onCheckedChange={(value) => onPreferenceChange(key, value)}
      />
    ))
  );

  return (
    <div className="flex-1 space-y-6 overflow-y-auto overflow-x-hidden bg-background p-4">
      <QuickSettingsSection title={t('quickSettings.sections.appearance')}>
        <div className={cn(SETTING_ROW_CLASS, 'flex-col items-stretch gap-2')}>
          <span className="flex items-center gap-2 text-sm text-foreground">
            {isDarkMode ? (
              <Moon className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Sun className="h-4 w-4 text-muted-foreground" />
            )}
            主題
          </span>
          <ThemePicker />
        </div>
        <div className={cn(SETTING_ROW_CLASS, 'justify-between')}>
          <span className="flex items-center gap-2 text-sm text-foreground">
            <Minimize2 className="h-4 w-4 text-muted-foreground" />
            {isPresenter ? '極簡模式（投影 固定開）' : '極簡模式'}
          </span>
          <DarkModeToggle checked={isMinimal} onToggle={setMinimal} ariaLabel="極簡模式" disabled={isPresenter} icon={Minimize2} />
        </div>
        <div className={cn(SETTING_ROW_CLASS, 'justify-between')}>
          <span className="flex items-center gap-2 text-sm text-foreground">
            <GraduationCap className="h-4 w-4 text-muted-foreground" />
            教學模式
          </span>
          <DarkModeToggle checked={isTutorial} onToggle={setTutorial} ariaLabel="教學模式" icon={GraduationCap} />
        </div>
        <LanguageSelector compact />
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.toolDisplay')}>
        {renderToggleRows(TOOL_DISPLAY_TOGGLES)}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.inputSettings')}>
        {renderToggleRows(inputSettingToggles)}
        <p className="ml-3 text-xs text-muted-foreground">
          {t('quickSettings.sendByCtrlEnterDescription')}
        </p>
      </QuickSettingsSection>
    </div>
  );
}
