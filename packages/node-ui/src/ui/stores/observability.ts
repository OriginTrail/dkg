import { create } from 'zustand';

export type ObservabilityTab = 'operations' | 'replication' | 'hardware' | 'logs' | 'errors' | 'network';

interface ObservabilityState {
  tab: ObservabilityTab;
  setTab: (tab: ObservabilityTab) => void;
}

/** The open Observability tab. Shared so the right panel and /network can open a tab directly. */
export const useObservabilityStore = create<ObservabilityState>((set) => ({
  tab: 'operations',
  setTab: (tab) => set({ tab }),
}));
