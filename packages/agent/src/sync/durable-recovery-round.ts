// SPDX-License-Identifier: Apache-2.0
import type { DurableSyncResult } from '../dkg-agent-types.js';
import type { MissingDurableAsset } from './requester/durable-data-holdings.js';

/** Decisions from one graph round; retained META and confirmation caches are inputs. */
export type DurableRecoveryRoundDecision = {
  readonly confirmedCopies: number;
  readonly rejectedResumeOffset?: number;
} & (
  | { readonly strategy: 'not-started' | 'held' }
  | { readonly strategy: 'full'; readonly continuation: 'full-graph' | 'reconsider-holdings' }
  | { readonly strategy: 'exact-missing'; readonly batches: readonly (readonly MissingDurableAsset[])[] }
);

export interface DurableRecoveryRoundOutcome {
  readonly result: DurableSyncResult;
  readonly decision: DurableRecoveryRoundDecision;
}

export function durableRecoveryRoundOutcome(
  result: DurableSyncResult,
  decision: DurableRecoveryRoundDecision = { strategy: 'not-started', confirmedCopies: 0 },
): DurableRecoveryRoundOutcome {
  return { result, decision };
}
