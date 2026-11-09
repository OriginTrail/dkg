// SPDX-License-Identifier: Apache-2.0
import type { DurableSyncResult } from '../dkg-agent-types.js';

export interface MutableDurableRecoveryPeerHealth {
  attempts: number;
  successfulSlices: number;
  recentTimeouts: number;
  recentTransportResets: number;
  lastSuccessfulTransportAtMs?: number;
}

/** A completed action's accounting, independent of its transport and continuation. */
export type DurableRecoveryAccounting = 'terminal' | 'success' | 'partial-progress' | 'failure' | 'unchanged';

export function accountDurableRecoveryAction(
  health: MutableDurableRecoveryPeerHealth,
  accounting: DurableRecoveryAccounting,
  result: Pick<DurableSyncResult, 'timedOutPhases' | 'failedPeers'>,
  now = Date.now(),
): void {
  if (accounting === 'terminal' || accounting === 'success' || accounting === 'partial-progress') {
    health.successfulSlices += 1;
    health.lastSuccessfulTransportAtMs = now;
  }
  if (accounting === 'terminal') {
    health.recentTimeouts = Math.floor(health.recentTimeouts * 0.75);
    health.recentTransportResets = Math.floor(health.recentTransportResets * 0.75);
  } else if (accounting === 'partial-progress' || accounting === 'failure') {
    if ((result.timedOutPhases ?? 0) > 0) health.recentTimeouts += 1;
    if ((result.failedPeers ?? 0) > 0) health.recentTransportResets += 1;
  }
}
