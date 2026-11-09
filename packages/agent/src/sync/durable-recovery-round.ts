// SPDX-License-Identifier: Apache-2.0
import type { DurableSyncResult } from '../dkg-agent-types.js';
import type { MissingDurableAsset } from './requester/durable-data-holdings.js';
import type { DurableSyncAdmissionOutcome } from './requester/admission-boundary.js';

/** Decisions from one graph round; retained META and confirmation caches are inputs. */
export type DurableRecoveryRoundDecision = {
  readonly rejectedResumeOffset?: number;
} & (
  | { readonly strategy: 'not-started' | 'held' | 'legacy' }
  | { readonly strategy: 'full'; readonly continuation: 'full-graph' | 'reconsider-holdings' }
  | { readonly strategy: 'exact-missing'; readonly batches: readonly (readonly MissingDurableAsset[])[] }
);

export interface DurableRecoveryRoundOutcome {
  readonly result: DurableSyncResult;
  readonly decision: DurableRecoveryRoundDecision;
}

/** One slice as its graph owner receives it: the round's outcome, and whether local admission let it start. */
export interface DurableRecoverySlice extends DurableRecoveryRoundOutcome {
  readonly admission: DurableSyncAdmissionOutcome;
}
