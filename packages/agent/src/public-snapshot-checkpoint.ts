// SPDX-License-Identifier: Apache-2.0
import { CHECKPOINT_PROFILE as PROFILE } from './snapshot-checkpoint-profile.js';
import type { PreparedSnapshotCheckpoint, SnapshotCheckpointManifest } from './snapshot-checkpoint-contract.js';
import { assertPublicSnapshotScopeAndAnchor } from './public-snapshot-scope.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BULK_GRAPH_MAX_ASSETS, PUBLIC_CHECKPOINT_PROTOCOL, bulkGraphTransportOptions,
  exchangePublicCheckpoint, buildKnowledgeAssetUalFromOnChainIdV1, type ProtocolRouter } from '@origintrail-official/dkg-core';
import { bulkJson, type BulkGraphRequest } from './sync/bulk-graph-contract.js';
import { PublicSnapshotEvidence, type PublicSnapshotObservation } from './public-snapshot-evidence.js';
import { receiveSnapshotCheckpointChunk } from './snapshot-checkpoint-receive.js';
import { reserveSnapshotCheckpoint, syncCheckpointDirectory, writeCheckpointFile, checkpointSha256,
  type SnapshotCheckpointEntry } from './snapshot-checkpoint-files.js';
import { verifySnapshotCheckpoint } from './snapshot-checkpoint-verify.js';
import { publicSnapshotSuppliers, type PublicSnapshotSupplierHost } from './public-snapshot-suppliers.js';
import { SnapshotCheckpointQueue } from './snapshot-checkpoint-queue.js';

/** A prepared checkpoint is not installed, current, or permission to replace a store. */
export async function preparePublicSnapshotCheckpoint(host: PublicSnapshotSupplierHost & {
  router: Pick<ProtocolRouter, 'probeProtocol' | 'withDuplexStream'>;
}, options: {
  initial: PublicSnapshotObservation; readFresh(): Promise<PublicSnapshotObservation>;
  peerBatches(): AsyncIterable<readonly string[]>; dataDir: string;
  signal: AbortSignal; deadline: number; assertCurrent(): void;
}): Promise<PreparedSnapshotCheckpoint> {
  const { initial, assertCurrent, deadline } = options;
  const queue = new SnapshotCheckpointQueue(options.signal);
  const signal = queue.signal;
  const assertLive = () => {
    signal.throwIfAborted(); assertCurrent();
    if (Date.now() >= deadline) throw new Error('Checkpoint job deadline exceeded');
  };
  assertLive();
  const directory = await reserveSnapshotCheckpoint(options.dataDir);
  const snapshot = initial.snapshot;
  const uals = snapshot.assets.map(a => buildKnowledgeAssetUalFromOnChainIdV1(snapshot.chainId, snapshot.assetStorage, BigInt(a.id)));
  // A finite first-bootstrap profile. Larger graphs continue to use incremental recovery.
  if (!uals.length || uals.length > PROFILE.maxAssets) throw new Error('Checkpoint inventory outside bootstrap limits');
  const entries: SnapshotCheckpointEntry[] = [];
  const budget = { encodedBytes: 0, plainBytes: 0, maxEncodedBytes: PROFILE.maxEncodedBytes,
    maxPlainBytes: PROFILE.maxPlainBytes, minFreeBytes: PROFILE.diskReserveBytes };
  let selected: string | undefined;
  for await (const peer of publicSnapshotSuppliers(host, { ...options, protocol: PUBLIC_CHECKPOINT_PROTOCOL,
    deadlineMessage: 'Checkpoint job deadline exceeded' })) {
    selected = peer; break;
  }
  if (!selected) throw new Error('No compatible public checkpoint core; use incremental recovery');
  // Once bytes arrive a failure is terminal; partial attempts never become a
  // mixed-supplier checkpoint or quietly restart a deadline.
  const receiving = (async () => {
    while (entries.length < uals.length) {
      assertLive();
      const request: BulkGraphRequest = { version: 1, contextGraphId: snapshot.contextGraphId,
        snapshotDigest: snapshot.snapshotDigest, assetUals: uals.slice(entries.length, entries.length + BULK_GRAPH_MAX_ASSETS) };
      const chunk = await exchangePublicCheckpoint(host.router, selected, bulkJson(request),
        bulkGraphTransportOptions(deadline - Date.now(), signal), session => receiveSnapshotCheckpointChunk(session, request,
          { directory, startIndex: entries.length, budget, assertCurrent: assertLive, staging: queue }));
      if (!chunk.length) throw new Error('Checkpoint made no progress');
      entries.push(...chunk);
    }
    queue.complete();
  })().catch(error => { queue.fail(error); throw error; });
  const evidence = new PublicSnapshotEvidence(initial, () => { try { assertLive(); return true; } catch { return false; } });
  const verifying = verifySnapshotCheckpoint({ directory, source: queue, evidence, signal, assertCurrent: assertLive,
  }).catch(error => { queue.fail(error); throw error; });
  // Drain both sides before returning ownership. Failed chunk integrity can leave
  // isolated verified files, but never a sealed manifest or an installed journal.
  const [, verification] = await Promise.allSettled([receiving, verifying]);
  signal.throwIfAborted();
  if (verification.status === 'rejected') throw verification.reason;
  const assets = verification.value;
  const fresh = await options.readFresh();
  assertLive();
  assertCheckpointInventoryUnchanged(initial, fresh);
  const trustSha256 = checkpointSha256(await readFile(join(directory, 'load', 'trust.nq')));
  const manifest: SnapshotCheckpointManifest = { version: 1, state: 'verified-unpublished', observation: initial, freshObservation: fresh,
    sourcePeer: selected, entries, assets, trustSha256, encodedBytes: budget.encodedBytes,
    plainBytes: budget.plainBytes, preparedAt: Date.now(), deadline };
  await writeCheckpointFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await syncCheckpointDirectory(directory);
  assertLive();
  return { directory, manifest, committed: 0 as const, current: false as const };
}

export function assertCheckpointInventoryUnchanged(initial: PublicSnapshotObservation, fresh: PublicSnapshotObservation): void {
  // Fresh authority may advance its block without changing this exact inventory.
  // Reorg, scope change, removal or update requires a new attempt/incremental sync.
  const error = 'Checkpoint inventory changed; use incremental recovery';
  assertPublicSnapshotScopeAndAnchor(initial, fresh, { scope: error, anchor: error });
  if (initial.snapshot.inventoryDigest !== fresh.snapshot.inventoryDigest) throw new Error(error);
}
