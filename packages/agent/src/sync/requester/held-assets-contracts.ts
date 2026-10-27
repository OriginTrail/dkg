// SPDX-License-Identifier: Apache-2.0
import type { GraphScopedDescriptor } from '../durable-integrity.js';
import type { GraphScopedChainEvidence } from './graph-scoped-chain-views.js';
import type { HeldGraphScopedAssetsRequest } from './stored-graph-assets.js';

/** Acquired content ownership remains live until the requester settles or abandons its graph. */
export interface HeldAssetsProof {
  readonly held: ReadonlySet<string>;
  assertCurrent(): void;
  close(): void;
}

export type ProveHeldAssets = (
  request: HeldGraphScopedAssetsRequest,
) => Promise<HeldAssetsProof | undefined>;

/** An authenticated mismatch is a value; unavailable evidence and cancellation reject. */
export type AuthenticateHeldAsset = (
  copy: GraphScopedDescriptor,
  requiredBinding: string | undefined,
  deadline: number,
  signal?: AbortSignal,
) => Promise<GraphScopedChainEvidence>;
