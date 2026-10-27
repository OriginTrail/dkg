// SPDX-License-Identifier: Apache-2.0
import type { PublicSnapshotObservation } from './public-snapshot-evidence.js';
import type { PublicSnapshotRecoveryResult } from './public-snapshot-recovery.js';

/** One owned job follows validated inventories; no round renews its lifetime. */
export async function recoverPublicSnapshotToCurrent(options: {
  initial: PublicSnapshotObservation;
  deadline: number;
  signal: AbortSignal;
  assertCurrent(): void;
  readFresh(): Promise<PublicSnapshotObservation>;
  recover(observation: PublicSnapshotObservation): Promise<PublicSnapshotRecoveryResult>;
}) {
  const active = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
    if (Date.now() >= options.deadline) throw new Error('Snapshot catch-up exceeded the original job deadline');
  };
  let observation = options.initial, rounds = 0;
  const bulkChunks: NonNullable<PublicSnapshotRecoveryResult['bulkChunks']> = [];
  while (true) {
    active();
    const recovered = await options.recover(observation);
    active();
    rounds++;
    if (recovered.bulkChunks) bulkChunks.push(...recovered.bulkChunks);
    const fresh = await options.readFresh();
    active();
    const previous = observation.snapshot, next = fresh.snapshot;
    // A changed contract/name binding is not an incremental inventory. Never
    // transfer under the old subscription's authority into another namespace.
    if (observation.mode !== fresh.mode || previous.chainId !== next.chainId
      || previous.deploymentId !== next.deploymentId || previous.contextGraphId !== next.contextGraphId
      || previous.onChainId !== next.onChainId || previous.nameHash !== next.nameHash
      || previous.assetStorage !== next.assetStorage || previous.contextGraphStorage !== next.contextGraphStorage)
      throw new Error('Snapshot catch-up scope changed');
    if (BigInt(next.blockNumber) < BigInt(previous.blockNumber)
      || (next.blockNumber === previous.blockNumber && next.blockHash !== previous.blockHash))
      throw new Error('Snapshot catch-up finalized anchor regressed or changed');
    if (next.inventoryDigest === previous.inventoryDigest) {
      return { observation, fresh, recovered, rounds,
        bulkChunks: recovered.bulkChunks === undefined ? undefined : bulkChunks };
    }
    // Each round authenticates with its new pins and rechecks held assets.
    // Merely having committed a UAL in an earlier round never grants coverage.
    observation = fresh;
  }
}
