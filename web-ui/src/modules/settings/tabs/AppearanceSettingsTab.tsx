import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AvatarPickerDialog, UserAvatarFace } from '@/modules/user-avatar';
import { readActiveSettingsProfile } from '@/shared/userSettings';
import { DarkModeToggle, ThemePicker } from '@/shared/ui';
import { GraduationCap, Minimize2 } from 'lucide-react';
import { useTheme } from '@/shared/context/ThemeContext';
import type { CodeEditorSettingsState, ProjectSortOrder } from '@/shared/types';
import { LanguageSelector } from '@/modules/i18n';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';

type AppearanceSettingsTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  codeEditorSettings: CodeEditorSettingsState;
  onCodeEditorWordWrapChange: (value: boolean) => void;
  onCodeEditorShowMinimapChange: (value: boolean) => void;
  onCodeEditorLineNumbersChange: (value: boolean) => void;
  onCodeEditorFontSizeChange: (value: string) => void;
};

/** DHC CLI 頭像: part of this device's profile (專案設定), like the theme; also changed by clicking the avatar in chat. */
export function MyAvatarSection() {
  const [open, setOpen] = useState(false);
  const profileName = readActiveSettingsProfile()?.name;

  return (
    <SettingsSection title="頭像">
      <SettingsCard>
        <SettingsRow
          label="我的頭像"
          description={`跟著這台裝置的專案設定（${profileName ?? '共用設定'}）走；你送出的訊息旁會顯示這張，也可以直接點對話裡的頭像來換。`}
        >
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm hover:bg-accent"
          >
            <UserAvatarFace className="h-7 w-7" />
            更換
          </button>
        </SettingsRow>
      </SettingsCard>
      {open && <AvatarPickerDialog open={open} onOpenChange={setOpen} profileName={profileName} />}
    </SettingsSection>
  );
}

/** Rendered by Settings for the "appearance" tab, covering theme, project sorting and code editor preferences. */
export default function AppearanceSettingsTab({
  projectSortOrder,
  onProjectSortOrderChange,
  codeEditorSettings,
  onCodeEditorWordWrapChange,
  onCodeEditorShowMinimapChange,
  onCodeEditorLineNumbersChange,
  onCodeEditorFontSizeChange,
}: AppearanceSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { isPresenter, isMinimal, setMinimal, isTutorial, setTutorial } = useTheme();

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearanceSettings.darkMode.label')}>
        <SettingsCard>
          <SettingsRow
            label="主題"
            description="蒸氣夕陽、極光、抹茶和紙是新加的三套。投影：仿 PRESENTER（DHC CLI），開會投影用。DHC 自己加的按鈕平常藏起來，按住 Alt 浮出，連按兩下 Alt 固定。"
          >
            <ThemePicker className="w-72" />
          </SettingsRow>
          <SettingsRow
            label="極簡模式"
            description={isPresenter
              ? '投影 主題固定是極簡（用它自己的 Alt 方式）。'
              : 'DHC 加的工具平常收起來：輸入框的小工具在點進輸入框或滑過時出現，頁首分頁、側欄底的用量和右緣把手在滑鼠靠近時出現。每個主題都能用。'}
          >
            <DarkModeToggle checked={isMinimal} onToggle={setMinimal} ariaLabel="極簡模式" disabled={isPresenter} icon={Minimize2} />
          </SettingsRow>
          <SettingsRow
            label="教學模式"
            description="給新手的說明文字平常收起來，開了才顯示。連按兩下 Ctrl 開關，按住 Ctrl 暫時看。"
          >
            <DarkModeToggle checked={isTutorial} onToggle={setTutorial} ariaLabel="教學模式" icon={GraduationCap} />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mainTabs.appearance')}>
        <SettingsCard>
          <LanguageSelector />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.projectSorting.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.projectSorting.label')}
            description={t('appearanceSettings.projectSorting.description')}
          >
            <select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="name">{t('appearanceSettings.projectSorting.alphabetical')}</option>
              <option value="date">{t('appearanceSettings.projectSorting.recentActivity')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.wordWrap}
              onChange={onCodeEditorWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.showMinimap}
              onChange={onCodeEditorShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.lineNumbers}
              onChange={onCodeEditorLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <select
              value={codeEditorSettings.fontSize}
              onChange={(event) => onCodeEditorFontSizeChange(event.target.value)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-28"
            >
              <option value="10">10px</option>
              <option value="11">11px</option>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
              <option value="20">20px</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
