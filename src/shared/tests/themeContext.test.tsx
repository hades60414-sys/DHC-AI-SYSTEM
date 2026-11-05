import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import { ThemeProvider, useTheme } from '@/shared/context/ThemeContext';
import {
  readUserPreference,
  resetUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';

/**
 * The theme is stored server-side, so the provider has to distinguish a theme
 * the user picked from one this device merely started on. Persisting the
 * latter — which an effect keyed on the state does, on mount, before the stored
 * theme has been fetched — writes a device's system default over the user's
 * real choice on every other device.
 */

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(ThemeProvider, null, children);

beforeEach(() => {
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
  document.documentElement.classList.remove('dark');
});

test('mounting stores no theme for a user who has never chosen one', () => {
  renderHook(() => useTheme(), { wrapper });

  assert.equal(
    readUserPreference<unknown>('theme', null),
    null,
    'a device must not record the theme it happened to start on',
  );
});

test('mounting does not overwrite the stored theme', () => {
  writeUserPreference('theme', 'dark');

  renderHook(() => useTheme(), { wrapper });

  assert.equal(readUserPreference('theme', null), 'dark');
});

test('a stored theme is applied on the first render', () => {
  writeUserPreference('theme', 'dark');

  const { result } = renderHook(() => useTheme(), { wrapper });

  assert.equal(result.current.isDarkMode, true);
  assert.ok(document.documentElement.classList.contains('dark'));
});

test('toggling stores the theme the user picked', () => {
  const { result } = renderHook(() => useTheme(), { wrapper });
  assert.equal(result.current.isDarkMode, false);

  act(() => {
    result.current.toggleDarkMode();
  });

  assert.equal(result.current.isDarkMode, true);
  assert.equal(readUserPreference('theme', null), 'dark');
  assert.ok(document.documentElement.classList.contains('dark'));
});

test('a theme arriving from the store is applied without being written back', () => {
  const { result } = renderHook(() => useTheme(), { wrapper });

  act(() => {
    // Stands in for a hydrate delivering the theme chosen on another device.
    writeUserPreference('theme', 'dark');
  });

  assert.equal(result.current.isDarkMode, true);
  assert.equal(readUserPreference('theme', null), 'dark');
});

test('a dark-based theme gets both its own class and .dark, and switching away removes them', () => {
  const { result } = renderHook(() => useTheme(), { wrapper });
  const root = document.documentElement;

  act(() => {
    result.current.setTheme('synthwave');
  });
  assert.equal(result.current.isDarkMode, true);
  assert.ok(root.classList.contains('theme-synthwave'));
  assert.ok(root.classList.contains('dark'));

  act(() => {
    result.current.setTheme('washi');
  });
  assert.equal(result.current.isDarkMode, false);
  assert.ok(root.classList.contains('theme-washi'));
  assert.ok(!root.classList.contains('theme-synthwave'));
  assert.ok(!root.classList.contains('dark'));
});

test('the dark toggle goes from any dark-based theme back to light', () => {
  writeUserPreference('theme', 'aurora');
  const { result } = renderHook(() => useTheme(), { wrapper });

  act(() => {
    result.current.toggleDarkMode();
  });

  assert.equal(result.current.theme, 'light');
  assert.equal(readUserPreference('theme', null), 'light');
});

test('極簡模式 is stored, puts .minimal on <html>, and comes off again', () => {
  const { result } = renderHook(() => useTheme(), { wrapper });
  assert.equal(result.current.isMinimal, false);

  act(() => result.current.setMinimal(true));
  assert.equal(result.current.isMinimal, true);
  assert.equal(readUserPreference('minimalMode', false), true);
  assert.ok(document.documentElement.classList.contains('minimal'));

  act(() => result.current.setMinimal(false));
  assert.ok(!document.documentElement.classList.contains('minimal'));
});

test('the PRESENTER look is always minimal but keeps its own hiding, not .minimal', () => {
  writeUserPreference('theme', 'presenter');
  const { result } = renderHook(() => useTheme(), { wrapper });

  assert.equal(result.current.isMinimal, true);
  assert.ok(document.documentElement.classList.contains('presenter'));
  assert.ok(!document.documentElement.classList.contains('minimal'));
});

test('in 極簡模式 the composer stays revealed while one of its portalled menus has focus', () => {
  const { result } = renderHook(() => useTheme(), { wrapper });
  act(() => result.current.setMinimal(true));
  const root = document.documentElement;
  const form = document.createElement('form'); form.setAttribute('data-slot', 'prompt-input');
  const input = document.createElement('textarea'); form.appendChild(input);
  const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.tabIndex = -1;
  const other = document.createElement('button');
  document.body.append(form, menu, other);

  input.focus();
  assert.ok(root.hasAttribute('data-composer-engaged'));
  menu.focus();
  assert.ok(root.hasAttribute('data-composer-engaged'), 'focus in a body-level menu keeps the tools up');
  other.focus();
  assert.ok(!root.hasAttribute('data-composer-engaged'));
  form.remove(); menu.remove(); other.remove();
});

test('holding Alt steps out of 極簡模式 and letting go brings it back; Alt+key combos are not swallowed', () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setMinimal(true));
    const root = document.documentElement;
    const fire = (type: string, init: KeyboardEventInit) => {
      const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      act(() => { window.dispatchEvent(event); });
      return event;
    };

    assert.equal(fire('keydown', { key: 'Alt', altKey: true }).defaultPrevented, true, 'bare Alt keeps the browser menu bar from taking focus');
    act(() => { vi.advanceTimersByTime(100); });
    assert.ok(root.classList.contains('minimal'), 'a quick Alt tap does not flash the full UI');
    act(() => { vi.advanceTimersByTime(150); });
    assert.ok(root.classList.contains('minimal'), 'a slowish tap (250ms) still does not flash the full UI');
    act(() => { vi.advanceTimersByTime(100); });
    assert.ok(!root.classList.contains('minimal'), 'held Alt shows everything');
    fire('keyup', { key: 'Alt' });
    assert.ok(root.classList.contains('minimal'), 'released Alt hides it again');

    fire('keydown', { key: 'Alt', altKey: true });
    const combo = fire('keydown', { key: 'ArrowLeft', altKey: true });
    assert.equal(combo.defaultPrevented, false, 'Alt+Left still reaches the browser');
    act(() => { vi.advanceTimersByTime(300); });
    assert.ok(root.classList.contains('minimal'), 'Alt used for a shortcut never reveals');
    fire('keyup', { key: 'Alt' });
  } finally {
    vi.useRealTimers();
  }
});

test('two quick Alt taps toggle 極簡模式 and save it; a hold or a combo in between does not', () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => useTheme(), { wrapper });
    const fire = (type: string, init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })); });
    const tap = (holdMs = 50) => {
      fire('keydown', { key: 'Alt', altKey: true });
      act(() => { vi.advanceTimersByTime(holdMs); });
      fire('keyup', { key: 'Alt' });
    };

    tap(); act(() => { vi.advanceTimersByTime(150); }); tap();
    assert.equal(result.current.isMinimal, true);
    assert.equal(readUserPreference('minimalMode', false), true, 'saved like the switch');
    assert.ok(document.documentElement.classList.contains('minimal'));

    act(() => { vi.advanceTimersByTime(1000); });
    tap(); act(() => { vi.advanceTimersByTime(600); }); tap();
    assert.equal(result.current.isMinimal, true, 'taps too far apart are two single taps');

    act(() => { vi.advanceTimersByTime(1000); });
    tap(); act(() => { vi.advanceTimersByTime(100); }); tap(400);
    assert.equal(result.current.isMinimal, true, 'a held second press is the temporary reveal, not a tap');
    assert.ok(document.documentElement.classList.contains('minimal'), 'and it is back after letting go');

    act(() => { vi.advanceTimersByTime(1000); });
    tap(); fire('keydown', { key: 'a' }); tap();
    assert.equal(result.current.isMinimal, true, 'another key between the taps cancels');

    act(() => { vi.advanceTimersByTime(1000); });
    tap(); act(() => { vi.advanceTimersByTime(100); }); tap();
    assert.equal(result.current.isMinimal, false, 'a second double tap turns it off');
    assert.equal(readUserPreference('minimalMode', true), false);
    assert.ok(!document.documentElement.classList.contains('minimal'));
  } finally {
    vi.useRealTimers();
  }
});

test('regression 11/01: from 極簡模式 a slowish double tap on Alt turns it off without flashing the full UI', () => {
  vi.useFakeTimers();
  try {
    writeUserPreference('minimalMode', true);
    const { result } = renderHook(() => useTheme(), { wrapper });
    const root = document.documentElement;
    assert.ok(root.classList.contains('minimal'));
    const fire = (type: string, init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })); });
    const tap = (holdMs: number) => {
      const before = root.classList.contains('minimal');
      fire('keydown', { key: 'Alt', altKey: true });
      act(() => { vi.advanceTimersByTime(holdMs); });
      assert.equal(root.classList.contains('minimal'), before, 'the tap does not flash the other state');
      fire('keyup', { key: 'Alt' });
    };

    tap(220); act(() => { vi.advanceTimersByTime(250); }); tap(220);
    assert.equal(result.current.isMinimal, false, 'double tap closes it from the minimal state');
    assert.ok(!root.classList.contains('minimal'));
    assert.equal(readUserPreference('minimalMode', true), false);

    tap(220); act(() => { vi.advanceTimersByTime(250); }); tap(220);
    assert.equal(result.current.isMinimal, true, 'and opens it again');
    assert.ok(root.classList.contains('minimal'));
  } finally {
    vi.useRealTimers();
  }
});

test('教學模式: a double Ctrl tap toggles and saves it, holding Ctrl peeks, Ctrl shortcuts do neither', () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => useTheme(), { wrapper });
    const root = document.documentElement;
    const fire = (type: string, init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })); });
    const tap = (holdMs = 80) => {
      fire('keydown', { key: 'Control', ctrlKey: true });
      act(() => { vi.advanceTimersByTime(holdMs); });
      fire('keyup', { key: 'Control' });
    };
    assert.ok(!root.classList.contains('tutorial'), 'off by default');

    fire('keydown', { key: 'Control', ctrlKey: true });
    act(() => { vi.advanceTimersByTime(500); });
    assert.ok(root.classList.contains('tutorial'), 'holding Ctrl shows the explanations');
    fire('keyup', { key: 'Control' });
    assert.ok(!root.classList.contains('tutorial'), 'letting go hides them again');
    assert.equal(result.current.isTutorial, false, 'a hold is not saved');

    fire('keydown', { key: 'Control', ctrlKey: true });
    fire('keydown', { key: 'c', ctrlKey: true });
    act(() => { vi.advanceTimersByTime(500); });
    fire('keyup', { key: 'Control' });
    assert.ok(!root.classList.contains('tutorial'), 'Ctrl+C does not peek');
    tap();
    act(() => { vi.advanceTimersByTime(100); });
    fire('keydown', { key: 'v', ctrlKey: true });
    fire('keyup', { key: 'v', ctrlKey: true });
    tap();
    assert.equal(result.current.isTutorial, false, 'a shortcut between the taps cancels');

    act(() => { vi.advanceTimersByTime(1000); });
    tap(220); act(() => { vi.advanceTimersByTime(250); }); tap(220);
    assert.equal(result.current.isTutorial, true, 'a double tap turns it on');
    assert.equal(readUserPreference('tutorialMode', false), true);
    assert.ok(root.classList.contains('tutorial'));

    act(() => { vi.advanceTimersByTime(1000); });
    tap(); act(() => { vi.advanceTimersByTime(100); }); tap();
    assert.equal(result.current.isTutorial, false, 'and off again');
    assert.ok(!root.classList.contains('tutorial'));
  } finally {
    vi.useRealTimers();
  }
});

test('regression 11/01: a bare Alt press is blocked whether or not 極簡模式 is on, so Chrome cannot move focus to its menu', () => {
  renderHook(() => useTheme(), { wrapper });
  const press = (type: string, init: KeyboardEventInit) => {
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    act(() => { window.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  assert.equal(press('keydown', { key: 'Alt', altKey: true }), true, 'keydown with minimal off');
  assert.equal(press('keyup', { key: 'Alt' }), true, 'keyup with minimal off');
  assert.equal(press('keydown', { key: 'Tab', altKey: true }), false, 'Alt+Tab itself is left alone');
});

test('regression (Astra 11/01): Ctrl pressed while Shift is held does not peek 教學模式', () => {
  vi.useFakeTimers();
  try {
    renderHook(() => useTheme(), { wrapper });
    const fire = (type: string, init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })); });
    fire('keydown', { key: 'Shift', shiftKey: true });
    fire('keydown', { key: 'Control', ctrlKey: true, shiftKey: true });
    act(() => { vi.advanceTimersByTime(600); });
    assert.ok(!document.documentElement.classList.contains('tutorial'));
    fire('keyup', { key: 'Control', shiftKey: true });
    fire('keyup', { key: 'Shift' });
  } finally {
    vi.useRealTimers();
  }
});

test('regression 11/01: a Ctrl double tap still toggles 教學模式 inside an input that stops key events from bubbling', () => {
  const input = document.createElement('textarea');
  const stop = (event: Event) => event.stopPropagation();
  input.addEventListener('keydown', stop);
  input.addEventListener('keyup', stop);
  document.body.appendChild(input);
  try {
    const { result } = renderHook(() => useTheme(), { wrapper });
    const fire = (type: string, init: KeyboardEventInit) => act(() => { input.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })); });
    const tap = () => { fire('keydown', { key: 'Control', ctrlKey: true }); fire('keyup', { key: 'Control' }); };
    tap(); tap();
    assert.equal(result.current.isTutorial, true);
  } finally {
    input.remove();
  }
});
