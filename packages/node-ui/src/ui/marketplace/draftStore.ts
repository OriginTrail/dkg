// Pending purchase draft: what a Marketplace control hands to Plans when it
// switches the centre tab. Session-only composition state: which offerings
// (one provider each) were "added to plan", plus a one-shot request to open
// a `new-period`, `topup` or `addon` purchase. Nothing here is an amount.
import { create } from 'zustand';

export interface DraftLine { offeringId: string; seller: string }

export type MarketplaceDraftRequest =
  | { kind: 'subscribe' }
  | { kind: 'new-period' }
  | { kind: 'topup'; offeringId: string; seller: string }
  | { kind: 'addon'; offeringId: string; seller: string };

/** What another surface asks Plans to open: the composer, with a service picked, or a top-up of this epoch's budget. */
export type PlanAsk = { kind: 'compose'; serviceId?: string } | { kind: 'top-up'; serviceId: string };

interface MarketplaceDraftState {
  /** One-shot, consumed by Plans. */
  ask: PlanAsk | null;
  askPlans: (ask: PlanAsk) => void;
  takeAsk: () => PlanAsk | null;
  /** One-shot: consumed by the Plans view on mount / change. */
  request: MarketplaceDraftRequest | null;
  /** Offerings added from the Marketplace, one provider per offering (last add wins). */
  queued: DraftLine[];
  addToPlan: (line: DraftLine) => void;
  requestNewPeriod: () => void;
  requestTopUp: (offeringId: string, seller: string) => void;
  /** Open the add-on form for an offering the active plan lacks (seller = a provider on the plan). */
  requestAddOn: (offeringId: string, seller: string) => void;
  consumeRequest: () => MarketplaceDraftRequest | null;
  removeQueued: (offeringId: string) => void;
  clearQueued: () => void;
}

export const useMarketplaceDraftStore = create<MarketplaceDraftState>((set, get) => ({
  ask: null,
  askPlans: (ask) => set({ ask }),
  takeAsk: () => {
    const a = get().ask;
    if (a) set({ ask: null });
    return a;
  },
  request: null,
  queued: [],
  addToPlan: (line) => set((s) => ({
    request: { kind: 'subscribe' },
    queued: [...s.queued.filter((q) => q.offeringId !== line.offeringId), line],
  })),
  requestNewPeriod: () => set({ request: { kind: 'new-period' } }),
  requestTopUp: (offeringId, seller) => set({ request: { kind: 'topup', offeringId, seller } }),
  requestAddOn: (offeringId, seller) => set({ request: { kind: 'addon', offeringId, seller } }),
  consumeRequest: () => {
    const r = get().request;
    if (r) set({ request: null });
    return r;
  },
  removeQueued: (offeringId) => set((s) => ({ queued: s.queued.filter((q) => q.offeringId !== offeringId) })),
  clearQueued: () => set({ queued: [] }),
}));
