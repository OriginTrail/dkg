// SPDX-License-Identifier: Apache-2.0
import type { PublicSnapshotObservation } from './public-snapshot-evidence.js';

/** Scope and finalized authority are shared; inventory policies remain caller-owned. */
export function assertPublicSnapshotScopeAndAnchor(previous: PublicSnapshotObservation,
  next: PublicSnapshotObservation, errors = {
    scope: 'Snapshot catch-up scope changed', anchor: 'Snapshot catch-up finalized anchor regressed or changed',
  }): void {
  const a = previous.snapshot, b = next.snapshot;
  if (previous.mode !== next.mode || a.chainId !== b.chainId || a.deploymentId !== b.deploymentId
    || a.contextGraphId !== b.contextGraphId || a.onChainId !== b.onChainId || a.nameHash !== b.nameHash
    || a.assetStorage !== b.assetStorage || a.contextGraphStorage !== b.contextGraphStorage)
    throw new Error(errors.scope);
  if (BigInt(b.blockNumber) < BigInt(a.blockNumber)
    || (b.blockNumber === a.blockNumber && b.blockHash !== a.blockHash)) throw new Error(errors.anchor);
}
