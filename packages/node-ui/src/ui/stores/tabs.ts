import { create } from 'zustand';

export interface CenterTab {
  id: string;
  label: string;
  closable: boolean;
  icon?: string;
}

interface TabsState {
  tabs: CenterTab[];
  activeTabId: string;

  openTab: (tab: CenterTab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
}

const INITIAL_TABS: CenterTab[] = [
  { id: 'dashboard', label: 'Dashboard', closable: false },
];

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: INITIAL_TABS,
  activeTabId: 'dashboard',

  openTab: (tab) => {
    const { tabs } = get();
    if (!tabs.find((t) => t.id === tab.id)) {
      set({ tabs: [...tabs, tab], activeTabId: tab.id });
    } else {
      set({ activeTabId: tab.id });
    }
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const filtered = tabs.filter((t) => t.id !== id);
    if (filtered.length === 0) return;
    const newActive = activeTabId === id
      ? filtered[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)]?.id ?? filtered[0].id
      : activeTabId;
    set({ tabs: filtered, activeTabId: newActive });
  },

  setActiveTab: (id) => set({ activeTabId: id }),
}));
