// SPDX-License-Identifier: Apache-2.0
import type { DurableMetaContinuation } from './durable-meta-continuation.js';
import type { DurableHoldingsOptions, DurableHoldingsReader } from './durable-data-holdings.js';
import type { VerifiedDurableBoundary } from '../durable-recovery-boundary-seed.js';
import type { ProveHeldAssets } from '../../durable-recovery-held-store.js';

/** Owner state is supplied together; the graph boundary adds the physical capabilities. */
export interface GraphOwnedRecoveryInput {
  readonly meta: DurableMetaContinuation;
  readonly holdings: DurableHoldingsOptions;
  readonly boundary?: VerifiedDurableBoundary;
}

export interface GraphOwnedRecoveryContext extends GraphOwnedRecoveryInput {
  /** A holdings reader is usable only with both lifecycle and store-content ownership. */
  readonly held?: {
    readonly confirmCurrent: DurableHoldingsReader['confirmCurrent'];
    assertCurrent(): void;
    readonly prove: ProveHeldAssets;
  };
}
