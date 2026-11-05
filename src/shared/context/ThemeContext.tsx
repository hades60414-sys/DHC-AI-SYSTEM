import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  readUserPreference,
  subscribeToUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';
import TutorialOverlay from '@/shared/ui/TutorialOverlay';

/** 'presenter' is the light-based PRESENTER (DHC CLI) look-alike, for meetings on a company laptop. */
export type ThemeName = 'light' | 'dark' | 'synthwave' | 'aurora' | 'washi' | 'presenter';

/** Picker order. dark: the theme also gets .dark so dark: utilities apply. meta: the browser theme-color. */
export const THEMES: { value: ThemeName; label: string; dark: boolean; meta: string; swatch: [string, string, string] }[] = [
  { value: 'light', label: '淺色', dark: false, meta: '#f9f7f3', swatch: ['#f9f7f3', '#5d54d9', '#e9e6f8'] },
  { value: 'dark', label: '深色', dark: true, meta: '#121319', swatch: ['#121319', '#a5a2f9', '#272a39'] },
  { value: 'synthwave', label: '蒸氣夕陽', dark: true, meta: '#140b1d', swatch: ['#140b1d', '#ff57c4', '#ff901f'] },
  { value: 'aurora', label: '極光', dark: true, meta: '#0b1219', swatch: ['#0b1219', '#26d99f', '#818cf8'] },
  { value: 'washi', label: '抹茶和紙', dark: false, meta: '#f2ede2', swatch: ['#f2ede2', '#5a7238', '#425f96'] },
  { value: 'presenter', label: '投影', dark: false, meta: '#f7f7f7', swatch: ['#f7f7f7', '#b2242c', '#303030'] },
];

/** Alt gestures in 極簡模式: hold this long to peek, a press shorter than TAP_MAX is a tap, two taps within DOUBLE_TAP toggle. */
const ALT_PEEK_DELAY_MS = 300;
const ALT_TAP_MAX_MS = 250;
const ALT_DOUBLE_TAP_MS = 600;
/** Ctrl gestures for 教學模式, same shape as Alt; the peek waits longer because Ctrl usually leads a shortcut. */
const CTRL_PEEK_DELAY_MS = 400;
const CTRL_TAP_MAX_MS = 250;
const CTRL_DOUBLE_TAP_MS = 600;

const isThemeName = (value: unknown): value is ThemeName => THEMES.some((t) => t.value === value);

type ThemeContextValue = {
  theme: ThemeName;
  isDarkMode: boolean;
  isPresenter: boolean;
  /** Minimal mode as shown: the saved choice, or always on in the PRESENTER look (which hides extras its own way). */
  isMinimal: boolean;
  setMinimal: (on: boolean) => void;
  /** 教學模式: newcomer explanations (data-tutorial) are shown. */
  isTutorial: boolean;
  setTutorial: (on: boolean) => void;
  toggleDarkMode: () => void;
  setTheme: (theme: ThemeName) => void;
};

const readSavedTheme = (): ThemeName | null => {
  const saved = readUserPreference<string | null>('theme', null);
  return isThemeName(saved) ? saved : null;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

/** Read-only PRESENTER flag for leaf components; false when rendered outside the provider (e.g. in tests). */
export const useIsPresenter = () => useContext(ThemeContext)?.isPresenter ?? false;

/** Mounted once by App so every module can read and switch the colour theme through useTheme. */
export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  // Check for saved theme preference or default to system preference. The
  // stored theme is read synchronously from the preference mirror so the very
  // first paint is already the right colour.
  const [theme, setThemeState] = useState<ThemeName>(() => {
    const savedTheme = readSavedTheme();
    if (savedTheme) {
      return savedTheme;
    }

    // Check system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }

    return 'light';
  });
  const themeMeta = THEMES.find((t) => t.value === theme) ?? THEMES[0];
  const isDarkMode = themeMeta.dark;
  const isPresenter = theme === 'presenter';
  const [minimalPref, setMinimalPref] = useState(() => readUserPreference<boolean>('minimalMode', false) === true);
  const isMinimal = isPresenter || minimalPref;
  const [tutorialPref, setTutorialPref] = useState(() => readUserPreference<boolean>('tutorialMode', false) === true);

  // The theme now lives in auth.db, so a change made on another device (or in
  // another tab) arrives through the preference store rather than a re-render.
  useEffect(() => subscribeToUserPreferences(() => {
    const savedTheme = readSavedTheme();
    if (savedTheme) {
      setThemeState(savedTheme);
    }
    setMinimalPref(readUserPreference<boolean>('minimalMode', false) === true);
    setTutorialPref(readUserPreference<boolean>('tutorialMode', false) === true);
  }), []);

  // 極簡模式 (2026-10-31): DHC extras (data-presenter-extra, edge handles) stay out of sight and come back
  // where the user is about to use them: composer tools on focus or hover, header tabs and the sidebar
  // footer on hover, edge handles when the pointer reaches them. All in index.css html.minimal.
  // Not added in the PRESENTER look, which already hides the same extras behind Alt.
  useEffect(() => {
    const root = document.documentElement;
    const on = minimalPref && !isPresenter;
    root.classList.toggle('minimal', on);
    if (!on) return undefined;
    // The composer's menus (更多, 排程, 模型…) are portalled to <body>, so focus inside them is not
    // :focus-within the composer. Stay revealed from the first touch of the composer or a menu until the
    // user focuses or clicks something else; otherwise the trigger vanishes under its own open menu and
    // closing the menu cannot hand focus back to it.
    const engaged = (target: EventTarget | null) => target instanceof Element
      && Boolean(target.closest('[data-slot="prompt-input"], [role="menu"], [role="dialog"], [role="listbox"]'));
    const update = (event: Event) => root.toggleAttribute('data-composer-engaged', engaged(event.target));
    document.addEventListener('focusin', update);
    document.addEventListener('pointerdown', update, true);
    // Holding Alt steps out of minimal mode (everything shows) and letting go restores it. The short delay keeps
    // Alt+Tab and Alt+arrow from flashing the full UI; only the bare Alt key is preventDefault-ed (so the browser
    // menu bar does not grab focus), never the keys pressed together with it.
    let altTimer: number | undefined;
    const restore = () => {
      window.clearTimeout(altTimer);
      altTimer = undefined;
      root.classList.add('minimal');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') {
        window.clearTimeout(altTimer);
        altTimer = undefined;
        if (event.altKey) restore();
        return;
      }
      event.preventDefault();
      if (event.repeat || altTimer !== undefined || !root.classList.contains('minimal')) return;
      altTimer = window.setTimeout(() => {
        altTimer = undefined;
        root.classList.remove('minimal');
      }, ALT_PEEK_DELAY_MS);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Alt') restore();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', restore);
    return () => {
      window.clearTimeout(altTimer);
      root.classList.remove('minimal');
      root.removeAttribute('data-composer-engaged');
      document.removeEventListener('focusin', update);
      document.removeEventListener('pointerdown', update, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', restore);
    };
  }, [minimalPref, isPresenter]);

  // PRESENTER look: DHC-only extras (data-presenter-extra) stay hidden until Alt is held
  // for a moment (the delay keeps Alt+Tab from flashing them). Two quick Alt
  // taps pin them open; two more unpin.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('presenter', isPresenter);
    if (!isPresenter) return undefined;

    let timer: number | undefined;
    let pinned = false;
    let downAt = 0;
    let combo = false;
    let lastTapAt = 0;
    const hide = () => {
      window.clearTimeout(timer);
      timer = undefined;
      if (!pinned) root.classList.remove('presenter-reveal');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') {
        combo = true;
        hide();
        return;
      }
      event.preventDefault();
      if (event.repeat) return;
      downAt = Date.now();
      combo = false;
      if (timer === undefined && !root.classList.contains('presenter-reveal')) {
        timer = window.setTimeout(() => root.classList.add('presenter-reveal'), 300);
      }
    };
    // Alt+click on a link downloads it in Chrome, so the user lets go of Alt
    // before clicking: a revealed panel under the pointer stays until the
    // pointer leaves it.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') return;
      const now = Date.now();
      if (!combo && now - downAt < 250) {
        if (now - lastTapAt < 450) {
          lastTapAt = 0;
          pinned = !pinned;
          root.classList.toggle('presenter-reveal', pinned);
          window.clearTimeout(timer);
          timer = undefined;
          return;
        }
        lastTapAt = now;
      }
      const hovered = root.classList.contains('presenter-reveal') && !pinned
        ? document.querySelector('[data-presenter-extra]:hover, [data-presenter-rail]:hover, [data-presenter-title]:hover')
        : null;
      if (!hovered) {
        hide();
        return;
      }
      window.clearTimeout(timer);
      timer = undefined;
      hovered.addEventListener('mouseleave', hide, { once: true });
    };
    // Holding Alt is how the extras show, so Alt+click on a link must not
    // become Chrome's "download link": re-send it as a plain click.
    const onClick = (event: MouseEvent) => {
      if (!event.altKey || !event.isTrusted) return;
      const link = (event.target as Element | null)?.closest?.('a[href]');
      if (!link) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      link.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
      }));
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', hide);
    window.addEventListener('click', onClick, true);
    return () => {
      window.clearTimeout(timer);
      root.classList.remove('presenter', 'presenter-reveal');
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', hide);
    };
  }, [isPresenter]);

  // Applying the theme to the document and persisting it are deliberately
  // separate. Persisting from here would also fire on mount — before the stored
  // theme had been fetched — writing this device's system default over the
  // theme the user actually chose on another one.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add(`theme-${theme}`);
    return () => root.classList.remove(`theme-${theme}`);
  }, [theme]);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');

      // Update iOS status bar style and theme color for dark mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'black-translucent');
      }

      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', themeMeta.meta);
      }
    } else {
      document.documentElement.classList.remove('dark');

      // Update iOS status bar style and theme color for light mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'default');
      }

      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', themeMeta.meta);
      }
    }
  }, [isDarkMode, themeMeta]);

  // Listen for system theme changes
  useEffect(() => {
    if (!window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      // Only update if user hasn't manually set a preference
      if (!readSavedTheme()) {
        setThemeState(e.matches ? 'dark' : 'light');
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // The only writer: a theme is stored because the user picked it, never
  // because this device happened to start on one.
  const setTheme = useCallback((next: ThemeName) => {
    writeUserPreference('theme', next);
    setThemeState(next);
  }, []);

  const setMinimal = useCallback((on: boolean) => {
    writeUserPreference('minimalMode', on);
    setMinimalPref(on);
  }, []);

  // Two quick Alt taps (each shorter than ALT_TAP_MAX_MS, which stays under the ALT_PEEK_DELAY_MS hold that
  // reveals everything, so a slowish tap toggles instead of flashing the full UI; no other key in between,
  // released within ALT_DOUBLE_TAP_MS of each other) flip 極簡模式 and save it like the switch does. Holding Alt is the separate temporary reveal above.
  const minimalRef = useRef(minimalPref);
  minimalRef.current = minimalPref;
  useEffect(() => {
    if (isPresenter) return undefined; // the PRESENTER look pins its reveal with a double Alt tap instead
    let downAt = 0;
    let combo = false;
    let lastTapAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') {
        combo = true;
        lastTapAt = 0;
        return;
      }
      // 11/01: a bare Alt press in Chrome on Windows moves focus to the browser menu, after which the page hears no
      // more keys, so the second tap (and any Ctrl tap after it) never arrived and 極簡／教學 could not be switched
      // back on. The minimal-mode effect only blocked it while minimal was on; block it in every state.
      event.preventDefault();
      if (event.repeat) return;
      downAt = Date.now();
      combo = false;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') return;
      event.preventDefault();
      const now = Date.now();
      if (combo || now - downAt >= ALT_TAP_MAX_MS) {
        lastTapAt = 0;
        return;
      }
      if (now - lastTapAt < ALT_DOUBLE_TAP_MS) {
        lastTapAt = 0;
        setMinimal(!minimalRef.current);
        return;
      }
      lastTapAt = now;
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [isPresenter, setMinimal]);

  const setTutorial = useCallback((on: boolean) => {
    writeUserPreference('tutorialMode', on);
    setTutorialPref(on);
  }, []);

  // Every key gesture here listens in the capture phase (11/01): inputs that stop key events from bubbling, such as
  // the 規劃白板 AI box keeping Excalidraw shortcuts out, otherwise swallowed the Ctrl / Alt taps.
  // 教學模式 (11/01): explanations that only help newcomers carry data-tutorial and show only under html.tutorial
  // (index.css). Two quick Ctrl taps flip the saved choice; holding Ctrl alone shows them until it is let go.
  // Any other key, a click or a Ctrl+wheel zoom in between makes it a shortcut, not a gesture.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('tutorial', tutorialPref);
    let downAt = 0;
    let combo = false;
    let lastTapAt = 0;
    let peekTimer: number | undefined;
    const endPeek = () => {
      window.clearTimeout(peekTimer);
      peekTimer = undefined;
      root.classList.toggle('tutorial', tutorialPref);
    };
    const breakGesture = () => {
      combo = true;
      lastTapAt = 0;
      endPeek();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Control') {
        breakGesture();
        return;
      }
      if (event.repeat) return;
      downAt = Date.now();
      // Ctrl pressed while Shift/Alt/Meta is already held is the start of a shortcut, not a bare Ctrl (Astra 11/01).
      combo = event.shiftKey || event.altKey || event.metaKey;
      if (combo) {
        lastTapAt = 0;
        return;
      }
      if (!tutorialPref) {
        peekTimer = window.setTimeout(() => {
          peekTimer = undefined;
          root.classList.add('tutorial');
        }, CTRL_PEEK_DELAY_MS);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Control') return;
      endPeek();
      const now = Date.now();
      if (combo || now - downAt >= CTRL_TAP_MAX_MS) {
        lastTapAt = 0;
        return;
      }
      if (now - lastTapAt < CTRL_DOUBLE_TAP_MS) {
        lastTapAt = 0;
        setTutorial(!tutorialPref);
        return;
      }
      lastTapAt = now;
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerdown', breakGesture, true);
    window.addEventListener('wheel', breakGesture, { capture: true, passive: true });
    window.addEventListener('blur', endPeek);
    return () => {
      window.clearTimeout(peekTimer);
      root.classList.remove('tutorial');
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('pointerdown', breakGesture, true);
      window.removeEventListener('wheel', breakGesture, true);
      window.removeEventListener('blur', endPeek);
    };
  }, [tutorialPref, setTutorial]);

  const toggleDarkMode = useCallback(() => {
    setThemeState((previous) => {
      // From any dark-based theme back to light; from any light-based one to dark.
      const next: ThemeName = THEMES.find((t) => t.value === previous)?.dark ? 'light' : 'dark';
      writeUserPreference('theme', next);
      return next;
    });
  }, []);

  // A fresh object here would re-render every consumer in the app on any
  // render of this provider, theme change or not.
  const value = useMemo<ThemeContextValue>(
    () => ({ theme, isDarkMode, isPresenter, isMinimal, setMinimal, isTutorial: tutorialPref, setTutorial, toggleDarkMode, setTheme }),
    [theme, isDarkMode, isPresenter, isMinimal, setMinimal, tutorialPref, setTutorial, toggleDarkMode, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
      <TutorialOverlay />
    </ThemeContext.Provider>
  );
};
