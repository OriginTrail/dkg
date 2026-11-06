import { create } from 'zustand';

const TABS = ['operations', 'replication', 'hardware', 'logs', 'errors', 'network'] as const;
export type ObservabilityTab = (typeof TABS)[number];
const DEFAULT_TAB: ObservabilityTab = 'operations';

/** The tab a query string names, or the default for anything else. */
export function tabFromSearch(search: string): ObservabilityTab {
  const tab = new URLSearchParams(search).get('tab');
  return TABS.find((t) => t === tab) ?? DEFAULT_TAB;
}

/** Shows the tab in the address, so a refresh or bookmark lands on it. Replaces, so Back leaves the page. */
export function writeTabToAddress(tab: ObservabilityTab): void {
  const url = new URL(window.location.href);
  if (tab === DEFAULT_TAB) url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
}

interface ObservabilityState {
  tab: ObservabilityTab;
  setTab: (tab: ObservabilityTab) => void;
}

/** The open Observability tab. Shared so the right panel and /network can open a tab directly. */
export const useObservabilityStore = create<ObservabilityState>((set) => ({
  tab: tabFromSearch(globalThis.location?.search ?? ''),
  setTab: (tab) => set({ tab }),
}));
