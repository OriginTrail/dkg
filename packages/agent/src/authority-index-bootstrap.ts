// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphAuthorityIndexBootstrap } from '@origintrail-official/dkg-chain';
import { authorityIndexTrustDomain, type AuthorityIndexSnapshotPlan } from './authority-index-config.js';

const SCAN_PROGRESS_LOG_INTERVAL_MS = 30_000;

export interface AuthorityIndexBootstrapLog {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
}

/**
 * The chain index bootstrap for a snapshot plan. Operator trust fails closed
 * exactly as configured; only the network-relay default degrades to the
 * local-history scan, and it reports that and the scan's progress.
 */
export function createAuthorityIndexBootstrap(
  plan: AuthorityIndexSnapshotPlan,
  fetchSnapshot: ContextGraphAuthorityIndexBootstrap['fetchSnapshot'],
  log: AuthorityIndexBootstrapLog,
): ContextGraphAuthorityIndexBootstrap {
  const bootstrap = {
    maxTailBlocks: plan.config.maxTailBlocks,
    trustDomain: authorityIndexTrustDomain(plan.config),
    fetchSnapshot,
  };
  if (plan.source === 'operator') return bootstrap;
  return {
    ...bootstrap,
    // No relay may answer; the edge must still bind graphs.
    localHistoryFallback: true,
    onLocalHistoryFallback: ({ scope, reason }) => log.warn(
      `[authority-index] no network relay supplied a snapshot for ${scope}; falling back to local history: ${reason}`,
    ),
    onScanProgress: createScanProgressLogger(log.info),
  };
}

/** One line per scope per 30 s: a mainnet history scan pages for many minutes. */
function createScanProgressLogger(
  info: (message: string) => void,
): NonNullable<ContextGraphAuthorityIndexBootstrap['onScanProgress']> {
  const lastLoggedAt = new Map<string, number>();
  return (progress) => {
    const at = Date.now();
    const last = lastLoggedAt.get(progress.scope);
    if (last !== undefined && at - last < SCAN_PROGRESS_LOG_INTERVAL_MS) return;
    lastLoggedAt.set(progress.scope, at);
    info(`[authority-index] scope=${progress.scope} scanned=${progress.scannedBlocks} `
      + `through=${progress.throughBlockNumber} behind=${progress.finalizedNumber - progress.throughBlockNumber}`);
  };
}
