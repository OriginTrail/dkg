import { useMemo } from 'react';
import { usePcaOverview } from './usePcaOverview.js';

export type PcaAlertKind = 'expired' | 'expiring' | 'swept' | 'cap-near' | 'fallthrough';

export interface PcaAlert {
  id: string;
  accountId: string;
  kind: PcaAlertKind;
  severity: 'warn' | 'danger';
  title: string;
  message: string;
}

/**
 * E2 — the predictive PCA bell alerts, derived CLIENT-SIDE from the already-polled
 * overview snapshots (no server change in P0). Surfaces expiry / fully-swept /
 * cap-near health, plus the pre-B8 fall-through (an owned PCA covering 0 of its
 * own wallets → publishes likely pay the direct cost). Fall-through is explicitly
 * PREDICTIVE — labelled "pending confirmation", dropping any exact TRAC delta (#9).
 */
export function usePcaAlerts(): PcaAlert[] {
  const { accounts } = usePcaOverview(30_000);
  return useMemo(() => {
    const out: PcaAlert[] = [];
    for (const a of accounts) {
      if (!a.snapshot) continue;
      const id = a.accountId;
      if (a.health === 'expired') {
        out.push({ id: `pca-${id}-expired`, accountId: id, kind: 'expired', severity: 'danger', title: `PCA #${id} has expired`, message: 'Publishes no longer get its discount. Create a replacement account to keep saving.' });
      } else if (a.health === 'expiring') {
        out.push({ id: `pca-${id}-expiring`, accountId: id, kind: 'expiring', severity: 'warn', title: `PCA #${id} is expiring soon`, message: 'Top-up can’t extend the lock period — plan a replacement before it expires.' });
      }
      if (a.health === 'swept') {
        out.push({ id: `pca-${id}-swept`, accountId: id, kind: 'swept', severity: 'warn', title: `PCA #${id} is fully swept`, message: 'Its epoch budgets have been swept to the staker reward pool.' });
      }
      if (a.health === 'cap-near') {
        out.push({ id: `pca-${id}-cap`, accountId: id, kind: 'cap-near', severity: 'warn', title: `PCA #${id} is near the 100-wallet cap`, message: 'Deregister unused wallets to make room before approving more.' });
      }
      // Pre-B8 fall-through: an owned PCA that covers none of its own wallets.
      if (a.classification === 'owned' && a.approvedCount === 0 && a.health !== 'expired') {
        out.push({ id: `pca-${id}-fallthrough`, accountId: id, kind: 'fallthrough', severity: 'warn', title: `PCA #${id} discounts nothing yet`, message: 'Your publishes likely pay the direct cost — approve this node’s operational wallets. Pending confirmation.' });
      }
    }
    return out;
  }, [accounts]);
}
