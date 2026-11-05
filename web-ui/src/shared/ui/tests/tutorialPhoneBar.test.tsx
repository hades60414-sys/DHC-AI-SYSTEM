import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { ThemeProvider, useTheme } from '@/shared/context/ThemeContext';

/** 教學模式 on a phone: the bottom bar has a × and no Ctrl instruction; on a desktop it keeps the Ctrl hint and no ×. */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k, i18n: { language: 'zh-TW', changeLanguage: () => {} } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
afterEach(() => setWidth(1280));

function TurnOn() {
  const { setTutorial, isTutorial } = useTheme();
  return <button type="button" data-on={isTutorial} onClick={() => setTutorial(true)}>開教學</button>;
}

const open = async () => {
  render(<ThemeProvider><TurnOn /></ThemeProvider>);
  await act(async () => { fireEvent.click(screen.getByText('開教學')); });
};

test('phone: × closes the tutorial and the hint no longer asks for Ctrl', async () => {
  setWidth(390);
  await open();
  const bar = await screen.findByTestId('tutorial-badge');
  assert.ok(!/Ctrl/.test(bar.textContent!));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '關閉教學模式' })); });
  assert.equal(screen.queryByTestId('tutorial-badge'), null);
  assert.equal(document.documentElement.classList.contains('tutorial'), false);
});

test('desktop: keeps the double-Ctrl hint and has no ×', async () => {
  setWidth(1280);
  await open();
  const bar = await screen.findByTestId('tutorial-badge');
  assert.match(bar.textContent!, /Ctrl/);
  assert.equal(screen.queryByRole('button', { name: '關閉教學模式' }), null);
});
