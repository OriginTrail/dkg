import { create } from 'zustand';

/**
 * Centre tabs — the things you're working on (DESIGN.md · Navigation).
 *
 * Behaves like browser tabs:
 *  - persisted in this browser (open tabs, order, active, recently closed),
 *    so a refresh restores the workspace;
 *  - every tab has a web address (see hooks/useShellRouting + lib/tab-routes);
 *  - reorderable (drag, Ctrl+Shift+←/→); Dashboard is pinned first;
 *  - close, close others, close to the right, and reopen from "recently closed".
 * New tabs open next to the active one.
 */
export interface CenterTab {
  id: string;
  label: string;
  closable: boolean;
  icon?: string;
}

interface TabsState {
  tabs: CenterTab[];
  activeTabId: string;
  /** Most recent first; capped. */
  recentlyClosed: CenterTab[];

  openTab: (tab: CenterTab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  /** Move tab `id` to index `toIndex` (the pinned dashboard stays first). */
  moveTab: (id: string, toIndex: number) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  reopenTab: (id?: string) => void;
  renameTab: (id: string, label: string) => void;
}

export const DASHBOARD_TAB: CenterTab = { id: 'dashboard', label: 'Dashboard', closable: false };
export const TABS_STORAGE_KEY = 'dkg-tabs-v1';
const RECENT_LIMIT = 10;

interface Persisted { tabs: CenterTab[]; activeTabId: string; recentlyClosed: CenterTab[] }

/** Saved tabs for places that no longer exist. */
const RETIRED_TAB_IDS = new Set(['agent-hub']);

/**
 * The one decoder for a saved tab record (open and recently closed alike).
 * Builds a complete `CenterTab` from what was stored: a non-empty string id
 * and a string label are required; `icon` is kept only when it is a string;
 * every restored tab is closable (the pinned Dashboard is never stored).
 * Anything else, including the Dashboard's id, is rejected.
 */
export function decodePersistedTab(value: unknown): CenterTab | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { id, label, icon } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || id === DASHBOARD_TAB.id || RETIRED_TAB_IDS.has(id) || typeof label !== 'string') return null;
  return { id, label, closable: true, ...(typeof icon === 'string' && icon !== '' ? { icon } : {}) };
}

/** Decode a saved list: valid records in order, each id once, ids in `seen` skipped (and added). */
function decodeTabList(value: unknown, seen: Set<string>, limit = Infinity): CenterTab[] {
  const out: CenterTab[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (out.length >= limit) break;
    const tab = decodePersistedTab(item);
    if (!tab || seen.has(tab.id)) continue;
    seen.add(tab.id);
    out.push(tab);
  }
  return out;
}

/** Read the saved workspace; always returns a valid state with the dashboard first. */
export function loadPersistedTabs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Persisted {
  const fallback: Persisted = { tabs: [DASHBOARD_TAB], activeTabId: 'dashboard', recentlyClosed: [] };
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(TABS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const record = parsed as Record<string, unknown>;
    const seen = new Set<string>([DASHBOARD_TAB.id]);
    const tabs = [DASHBOARD_TAB, ...decodeTabList(record.tabs, seen)];
    const active = record.activeTabId;
    const activeTabId = typeof active === 'string' && tabs.some((t) => t.id === active) ? active : DASHBOARD_TAB.id;
    // A recently closed tab that is open again (or listed twice) is dropped.
    const recentlyClosed = decodeTabList(record.recentlyClosed, seen, RECENT_LIMIT);
    return { tabs, activeTabId, recentlyClosed };
  } catch {
    return fallback;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function persist(state: Persisted): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(TABS_STORAGE_KEY, JSON.stringify({
      tabs: state.tabs.filter((t) => t.id !== 'dashboard'),
      activeTabId: state.activeTabId,
      recentlyClosed: state.recentlyClosed,
    }));
  } catch {
    // Storage full or blocked: the workspace just won't survive a refresh.
  }
}

function remember(recent: CenterTab[], closed: CenterTab[]): CenterTab[] {
  const ids = new Set(closed.map((t) => t.id));
  return [...closed, ...recent.filter((t) => !ids.has(t.id))].slice(0, RECENT_LIMIT);
}

const initial = loadPersistedTabs();

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: initial.tabs,
  activeTabId: initial.activeTabId,
  recentlyClosed: initial.recentlyClosed,

  openTab: (tab) => {
    const { tabs, activeTabId, recentlyClosed } = get();
    const existing = tabs.find((t) => t.id === tab.id);
    if (existing) {
      // Re-opening refreshes the label (e.g. a graph's name arrives after a deep link).
      const next = tab.label && tab.label !== existing.label
        ? tabs.map((t) => (t.id === tab.id ? { ...t, label: tab.label } : t))
        : tabs;
      set({ tabs: next, activeTabId: tab.id });
      return;
    }
    // New tabs open right after the active one.
    const at = Math.max(1, tabs.findIndex((t) => t.id === activeTabId) + 1);
    const next = [...tabs.slice(0, at), tab, ...tabs.slice(at)];
    set({
      tabs: next,
      activeTabId: tab.id,
      recentlyClosed: recentlyClosed.filter((t) => t.id !== tab.id),
    });
  },

  closeTab: (id) => {
    const { tabs, activeTabId, recentlyClosed } = get();
    const target = tabs.find((t) => t.id === id);
    if (!target || !target.closable) return;
    const index = tabs.findIndex((t) => t.id === id);
    const filtered = tabs.filter((t) => t.id !== id);
    if (filtered.length === 0) return;
    const newActive = activeTabId === id
      ? filtered[Math.max(0, index - 1)]?.id ?? filtered[0].id
      : activeTabId;
    set({ tabs: filtered, activeTabId: newActive, recentlyClosed: remember(recentlyClosed, [target]) });
  },

  setActiveTab: (id) => {
    if (get().tabs.some((t) => t.id === id)) set({ activeTabId: id });
  },

  moveTab: (id, toIndex) => {
    const { tabs } = get();
    const from = tabs.findIndex((t) => t.id === id);
    if (from <= 0 || !tabs[from].closable) return;
    const to = Math.max(1, Math.min(tabs.length - 1, toIndex));
    if (to === from) return;
    const next = [...tabs];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set({ tabs: next });
  },

  closeOtherTabs: (id) => {
    const { tabs, recentlyClosed } = get();
    const closing = tabs.filter((t) => t.id !== id && t.closable);
    if (closing.length === 0) return;
    const keep = tabs.filter((t) => t.id === id || !t.closable);
    set({
      tabs: keep,
      activeTabId: keep.some((t) => t.id === id) ? id : keep[0].id,
      recentlyClosed: remember(recentlyClosed, [...closing].reverse()),
    });
  },

  closeTabsToRight: (id) => {
    const { tabs, activeTabId, recentlyClosed } = get();
    const index = tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const closing = tabs.slice(index + 1).filter((t) => t.closable);
    if (closing.length === 0) return;
    const keep = tabs.filter((t, i) => i <= index || !t.closable);
    set({
      tabs: keep,
      activeTabId: keep.some((t) => t.id === activeTabId) ? activeTabId : id,
      recentlyClosed: remember(recentlyClosed, [...closing].reverse()),
    });
  },

  reopenTab: (id) => {
    const { recentlyClosed } = get();
    const tab = id ? recentlyClosed.find((t) => t.id === id) : recentlyClosed[0];
    if (!tab) return;
    get().openTab(tab);
  },

  renameTab: (id, label) => {
    const { tabs } = get();
    if (!label || !tabs.some((t) => t.id === id && t.label !== label)) return;
    set({ tabs: tabs.map((t) => (t.id === id ? { ...t, label } : t)) });
  },
}));

useTabsStore.subscribe((s) => persist({ tabs: s.tabs, activeTabId: s.activeTabId, recentlyClosed: s.recentlyClosed }));
