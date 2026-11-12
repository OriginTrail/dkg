import { useMemo } from 'react';
import { usePcaOverview } from './usePcaOverview.js';
import { usePcaScopeBootstrap } from './usePcaScopeBootstrap.js';
import { PCA_CAP_NEAR_THRESHOLD, PCA_EXPIRING_SOON_SECONDS } from '../pca/health.js';
import { isPcaDead } from '../pca/pca-primitives.js';

export type PcaAlertKind = 'expired' | 'expiring' | 'cap-near' | 'fallthrough';

export interface PcaAlert {
  id: string;
  accountId: string;
  kind: PcaAlertKind;
  severity: 'warn' | 'danger';
  title: string;
  message: string;
}

/**
 * E2 — predictive PCA bell alerts, derived CLIENT-SIDE from the polled overview
 * snapshots (no server change). M6/F8: each alert is computed from the SNAPSHOT
 * FIELDS independently (not the single precedence-collapsed HealthChip state), so
 * co-occurring concerns each surface — e.g. an account that is BOTH expiring-soon
 * AND cap-near raises both. The HealthChip stays single-state for the cards.
 *
 * The fall-through alert is gated on `!probesInconclusive` (H2 — never assert
 * "covers 0 wallets" when the probes couldn't be read) and on not-expired (an
 * expired account's actionable alert is "renew", not "approve more wallets").
 * Fall-through is pre-spend status: do not claim a post-publish CostCovered event
 * or exact TRAC delta (#9).
 */
export function usePcaAlerts(): PcaAlert[] {
  usePcaScopeBootstrap();
  const { accounts } = usePcaOverview(30_000);
  return useMemo(() => {
    const out: PcaAlert[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    for (const a of accounts) {
      const s = a.snapshot;
      if (!s) continue;
      const id = a.accountId;
      const hasExpiry = typeof s.expiresAtTimestamp === 'number' && s.expiresAtTimestamp > 0;
      const expired = isPcaDead(s, nowSec);

      if (expired) {
        out.push({ id: `pca-${id}-expired`, accountId: id, kind: 'expired', severity: 'danger', title: `PCA #${id} has expired`, message: 'Publishes no longer get its discount. Create a new PCA to keep it.' });
      } else if (hasExpiry && s.expiresAtTimestamp - nowSec <= PCA_EXPIRING_SOON_SECONDS) {
        out.push({ id: `pca-${id}-expiring`, accountId: id, kind: 'expiring', severity: 'warn', title: `PCA #${id} is expiring soon`, message: 'Topping up doesn’t extend it. Create a new PCA before it expires.' });
      }
      if (typeof s.agentCount === 'number' && s.agentCount >= PCA_CAP_NEAR_THRESHOLD) {
        out.push({ id: `pca-${id}-cap`, accountId: id, kind: 'cap-near', severity: 'warn', title: `PCA #${id} is close to the 100-wallet limit`, message: 'Remove unused wallets before you approve more.' });
      }
      // Pre-B8 fall-through: an owned PCA covering none of its own wallets — only
      // when we could actually verify the probes (H2) and it isn't expired.
      if (a.classification === 'owned' && a.approvedCount === 0 && !a.probesInconclusive && !expired) {
        out.push({ id: `pca-${id}-fallthrough`, accountId: id, kind: 'fallthrough', severity: 'warn', title: `PCA #${id} gives no discount yet`, message: 'This node’s publishes pay the full fee until you approve its publishing wallets.' });
      }
    }
    return out;
  }, [accounts]);
}
