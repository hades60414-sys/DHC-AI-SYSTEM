import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import MobileRailToggle from '@/modules/project-workspace/MobileRailToggle';
import { QuickSettingsPanel } from '@/modules/quick-settings-panel';
import ToolLibrary from '@/modules/tool-library/ToolLibrary';
import VoiceInputButton from '@/modules/chat/composer/VoiceInputButton';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { emptyPicks } from '@/shared/customTools';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k, i18n: { language: 'zh-TW', changeLanguage: () => {} } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });

test('漢堡 → 設定：快速設定面板打開', () => {
  setWidth(390);
  render(
    <ThemeProvider>
      <UiPreferencesProvider>
        <MobileRailToggle />
        <QuickSettingsPanel />
      </UiPreferencesProvider>
    </ThemeProvider>,
  );
  const panel = screen.getByTestId('quick-settings-panel');
  assert.equal(panel.getAttribute('data-open'), 'false');
  fireEvent.click(screen.getByRole('button', { name: /選單/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: '快速設定' }));
  assert.equal(screen.getByTestId('quick-settings-panel').getAttribute('data-open'), 'true');
});

test('工具庫手機版：全空時只有一行提示，沒有空位框與桌面說明', () => {
  render(<ToolLibrary isMobile picks={emptyPicks()} onPicksChange={() => {}} onOpenTool={() => {}} onOpenWishes={() => {}} onClose={() => {}} />);
  assert.ok(screen.getByText('還沒有自選，按下方「加入自選」'));
  assert.equal(screen.queryByText(/空位/), null);
  assert.equal(screen.queryByText(/滑過就會展開/), null);
});

test('工具庫桌面版維持五個空位與說明', () => {
  render(<ToolLibrary isMobile={false} picks={emptyPicks()} onPicksChange={() => {}} onOpenTool={() => {}} onOpenWishes={() => {}} onClose={() => {}} />);
  assert.equal(screen.getAllByText(/空位/).length, 5);
  assert.ok(screen.getByText(/滑過就會展開/));
});

test('手機的麥克風鈕不掛浮動提示（避免蓋住錯誤泡泡）', () => {
  setWidth(390);
  render(<VoiceInputButton state="idle" mode="local" onToggle={() => {}} errorMsg="麥克風權限被拒絕" />);
  assert.ok(screen.getByText('麥克風權限被拒絕'));
  assert.equal(screen.getByRole('button', { name: 'voice.input' }).getAttribute('data-state'), null);
});

test('快速設定抽屜：Esc 關閉；有「全部設定」鈕，按了關抽屜並開完整設定', () => {
  setWidth(390);
  const openAll = vi.fn();
  render(
    <ThemeProvider>
      <UiPreferencesProvider>
        <MobileRailToggle />
        <QuickSettingsPanel onOpenAllSettings={openAll} />
      </UiPreferencesProvider>
    </ThemeProvider>,
  );
  const open = () => {
    fireEvent.click(screen.getByRole('button', { name: /選單/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '快速設定' }));
  };
  open();
  assert.equal(screen.getByTestId('quick-settings-panel').getAttribute('data-open'), 'true');
  fireEvent.keyDown(window, { key: 'Escape' });
  assert.equal(screen.getByTestId('quick-settings-panel').getAttribute('data-open'), 'false');
  open();
  fireEvent.click(screen.getByRole('button', { name: '全部設定' }));
  assert.equal(openAll.mock.calls.length, 1);
  assert.equal(screen.getByTestId('quick-settings-panel').getAttribute('data-open'), 'false');
});
