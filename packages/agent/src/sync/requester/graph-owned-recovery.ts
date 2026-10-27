// SPDX-License-Identifier: Apache-2.0
import type { DurableMetaContinuation } from './durable-meta-continuation.js';
import type { DurableHoldingsOptions, ConfirmHeldAssetsCurrent, HeldAssetsConfirmationRun } from './durable-data-holdings.js';
import type { VerifiedDurableBoundary } from '../durable-recovery-boundary-seed.js';

/** Owner state is supplied together; the graph boundary adds the physical capabilities. */
export interface GraphOwnedRecoveryInput {
  readonly meta: DurableMetaContinuation;
  readonly holdings: DurableHoldingsOptions;
  readonly boundary?: VerifiedDurableBoundary;
  readonly confirmation?: HeldAssetsConfirmationRun;
}

export interface GraphOwnedRecoveryContext extends GraphOwnedRecoveryInput {
  /** Chain authentication for content borrowed from the graph settlement scope. */
  readonly held?: {
    readonly confirmCurrent: ConfirmHeldAssetsCurrent;
  };
}
