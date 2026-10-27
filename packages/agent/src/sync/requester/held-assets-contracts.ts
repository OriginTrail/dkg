// SPDX-License-Identifier: Apache-2.0
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { GraphScopedDescriptor } from '../durable-integrity.js';
import type { GraphScopedChainEvidence } from './graph-scoped-chain-views.js';
import type { HeldGraphScopedAssetsRequest } from './stored-graph-assets.js';

/** Acquired content ownership remains live until the requester settles or abandons its graph. */
export interface HeldAssetsProof {
  readonly held: ReadonlySet<string>;
  /** Retain a subset of already-proven assets without repeating their content reads. */
  retain(uals: ReadonlySet<string>): void;
  /** Reconcile eligible confirmed copies while this content proof remains live. */
  reconcile?(ctx: OperationContext): Promise<void>;
  assertCurrent(): void;
  close(): void;
}

export type ProveHeldAssets = (
  request: HeldGraphScopedAssetsRequest,
) => Promise<HeldAssetsProof | undefined>;

/** Physical content and operation ownership are supplied once to a graph scope. */
export interface HeldAssetContentSource {
  readonly prove: ProveHeldAssets;
  assertOwnership(): void;
}

/** An authenticated mismatch is a value; unavailable evidence and cancellation reject. */
export type AuthenticateHeldAsset = (
  copy: GraphScopedDescriptor,
  requiredBinding: string | undefined,
  deadline: number,
  signal?: AbortSignal,
) => Promise<GraphScopedChainEvidence>;
