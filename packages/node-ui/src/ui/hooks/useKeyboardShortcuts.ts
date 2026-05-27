import { useEffect } from 'react';
import { useLayoutStore } from '../stores/layout.js';

/**
 * Global keyboard shortcuts for the shell:
 *
 *   Cmd/Ctrl+B          — toggle the left sidebar
 *   Cmd/Ctrl+Shift+B    — toggle the right agent panel
 *   Cmd/Ctrl+J          — toggle the bottom panel
 *
 * BUG-005 reproducer notes:
 *
 *   Chrome reports `e.key` as the *uppercase* letter when Shift is
 *   held (or Caps Lock is on), so the original lowercase comparison
 *   silently missed `Cmd+Shift+B` and `Cmd+B`-with-Caps-Lock. We
 *   normalise to lowercase before dispatching, and `return` after
 *   each branch so the shift-modified path can't double-fire the
 *   non-shift branches on the same event.
 *
 *   Form fields are skipped entirely so users can still type the
 *   letter `B` / `J` into inputs without the sidebar flapping.
 */
export function useKeyboardShortcuts(): void {
  const { toggleLeft, toggleRight, toggleBottom } = useLayoutStore();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === 'b') { e.preventDefault(); toggleRight(); return; }
      if (e.shiftKey) return;
      if (k === 'b') { e.preventDefault(); toggleLeft(); return; }
      if (k === 'j') { e.preventDefault(); toggleBottom(); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleLeft, toggleRight, toggleBottom]);
}
