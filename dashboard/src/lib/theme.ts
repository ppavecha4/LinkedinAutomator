/**
 * `useTheme` — tiny light/dark mode hook.
 *
 * State is kept in localStorage under `ai-sales-agent-theme` and mirrored
 * onto `<html class="dark">` so Tailwind's `darkMode: ['class']` strategy
 * picks it up. The inline script in `index.html` reads the same key
 * BEFORE React hydrates, so the first paint is already themed — no flash.
 *
 * Values: 'light' | 'dark' | 'system' (system follows the OS preference
 * and reacts to changes while the tab is open).
 */
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'ai-sales-agent-theme';

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyTheme(theme: Theme): void {
  const resolved = theme === 'system' ? getSystemTheme() : theme;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

export function useTheme(): {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  toggle: () => void;
} {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
    return 'system';
  });

  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(
    getSystemTheme,
  );

  // Re-apply when theme state changes.
  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* quota / private mode — non-fatal */
    }
  }, [theme]);

  // Watch OS preference changes so `system` mode stays accurate.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent): void => {
      setSystemTheme(e.matches ? 'dark' : 'light');
      if (theme === 'system') applyTheme('system');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggle = useCallback(
    () =>
      setThemeState((prev) => {
        const current = prev === 'system' ? getSystemTheme() : prev;
        return current === 'dark' ? 'light' : 'dark';
      }),
    [],
  );

  const resolvedTheme: 'light' | 'dark' =
    theme === 'system' ? systemTheme : theme;

  return { theme, resolvedTheme, setTheme, toggle };
}
