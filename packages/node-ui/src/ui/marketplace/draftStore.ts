// What another marketplace surface asks Plans to open when it switches the
// centre tab: the composer, with a service picked, or a top-up of this
// epoch's budget for a service. One-shot and session-only; no amounts.
import { create } from 'zustand';

type PlanAsk = { kind: 'compose'; serviceId?: string } | { kind: 'top-up'; serviceId: string };

interface MarketplaceDraftState {
  /** One-shot, consumed by Plans. */
  ask: PlanAsk | null;
  askPlans: (ask: PlanAsk) => void;
  takeAsk: () => PlanAsk | null;
}

export const useMarketplaceDraftStore = create<MarketplaceDraftState>((set, get) => ({
  ask: null,
  askPlans: (ask) => set({ ask }),
  takeAsk: () => {
    const a = get().ask;
    if (a) set({ ask: null });
    return a;
  },
}));
