/**
 * Choosing a tab from the shell's own controls: the tab bar and the sidebar.
 *
 * Going to another tab changes the address, and the shell routing
 * (useShellRouting) shows the page on every address change. Choosing the tab
 * that's already open leaves the address as it is, so that one case shows the
 * page here. Nothing else in the shell reveals the centre.
 */
import { useLayoutStore } from '../stores/layout.js';
import { useTabsStore, type CenterTab } from '../stores/tabs.js';

/** Open a tab, or show it again when it's the one already open. */
export function chooseTab(tab: CenterTab): void {
  const tabs = useTabsStore.getState();
  if (tabs.activeTabId === tab.id) useLayoutStore.getState().revealCentre();
  tabs.openTab(tab);
}

/** Switch to an open tab, or show it again when it's the active one. */
export function chooseOpenTab(id: string): void {
  const tabs = useTabsStore.getState();
  if (tabs.activeTabId === id) useLayoutStore.getState().revealCentre();
  tabs.setActiveTab(id);
}
