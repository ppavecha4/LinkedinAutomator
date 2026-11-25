/**
 * useSidebarCollapse — sidebar open/collapsed state, persisted in localStorage.
 *
 * Returns `{collapsed, toggle, setCollapsed}`. The Layout reads this to set
 * its width and which bits to hide; the ⌘B shortcut toggles it.
 */
import * as React from 'react';

const STORAGE_KEY = 'ai-sales-agent-sidebar-collapsed';

export function useSidebarCollapse(): {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
} {
  const [collapsed, setCollapsedState] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const setCollapsed = React.useCallback((v: boolean) => {
    setCollapsedState(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = React.useCallback(
    () => setCollapsed(!collapsed),
    [collapsed, setCollapsed],
  );

  // Keyboard shortcut: ⌘B / Ctrl+B
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'b' && (e.metaKey || e.ctrlKey)) {
        // Ignore when typing inside an input/textarea.
        const target = e.target as HTMLElement;
        if (
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        toggle();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [toggle]);

  return { collapsed, toggle, setCollapsed };
}
