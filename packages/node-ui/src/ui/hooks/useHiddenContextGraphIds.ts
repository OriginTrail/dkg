import { useCallback, useEffect, useState } from 'react';

// Shared "hidden from sidebar" preference. Extracted so PanelLeft, the
// Memory Stack and the Dashboard all read the SAME set — the dashboard's
// "My Context Graphs" count must equal the sidebar's, and that only holds
// if the hidden-ids filter is identical (not three separate copies).
// localStorage key is unchanged for back-compat with existing users.
const HIDDEN_KEY = 'v10:hiddenProjectIds';
const HIDDEN_CHANGE_EVENT = 'v10:hidden-projects-change';

export function loadHiddenContextGraphIds(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveHiddenIds(ids: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]));
    window.dispatchEvent(new Event(HIDDEN_CHANGE_EVENT));
  } catch {
    /* non-critical (private mode / quota) */
  }
}

export function useHiddenContextGraphIds(): {
  hidden: Set<string>;
  hide: (id: string) => void;
  unhideAll: () => void;
} {
  const [hidden, setHidden] = useState<Set<string>>(() => loadHiddenContextGraphIds());
  useEffect(() => {
    const sync = () => setHidden(loadHiddenContextGraphIds());
    window.addEventListener(HIDDEN_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HIDDEN_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const hide = useCallback((id: string) => {
    const next = new Set(loadHiddenContextGraphIds());
    next.add(id);
    saveHiddenIds(next);
  }, []);
  const unhideAll = useCallback(() => {
    saveHiddenIds(new Set());
  }, []);
  return { hidden, hide, unhideAll };
}
