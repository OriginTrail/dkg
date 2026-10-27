// SPDX-License-Identifier: Apache-2.0
import type { DurableMetaContinuation } from './durable-meta-continuation.js';
import type { DurableHoldingsOptions, ConfirmHeldAssetsCurrent } from './durable-data-holdings.js';
import type { VerifiedDurableBoundary } from '../durable-recovery-boundary-seed.js';
import type { HeldGraphScopedAssetsRequest } from './stored-graph-assets.js';
import type { ProveHeldAssets } from './held-assets-contracts.js';

/** Owner state is supplied together; the graph boundary adds the physical capabilities. */
export interface GraphOwnedRecoveryInput {
  readonly meta: DurableMetaContinuation;
  readonly holdings: DurableHoldingsOptions;
  readonly boundary?: VerifiedDurableBoundary;
}

export interface GraphOwnedRecoveryContext extends GraphOwnedRecoveryInput {
  /** A holdings reader is usable only with both lifecycle and store-content ownership. */
  readonly held?: {
    readonly reconcile?: (request: HeldGraphScopedAssetsRequest, held: ReadonlySet<string>) => Promise<void>;
    readonly confirmCurrent: ConfirmHeldAssetsCurrent;
    assertCurrent(): void;
    readonly prove: ProveHeldAssets;
  };
}
