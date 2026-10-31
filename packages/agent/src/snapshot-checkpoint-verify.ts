// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipBounded, buildKnowledgeAssetUalFromOnChainIdV1 } from '@origintrail-official/dkg-core';
import { quadToBlazegraphNQuad } from '@origintrail-official/dkg-storage';
import { PublicSnapshotEvidence, coreTrustedGraphQuads } from './public-snapshot-evidence.js';
import { withSnapshotVerificationPool } from './snapshot-verification-pool.js';
import { decodeNegotiatedExactSyncResponse } from './sync/wire-compression.js';
import { checkpointAssetPath, checkpointSha256, readPinnedCheckpointFile, syncCheckpointDirectory, writeCheckpointFile,
  type SnapshotCheckpointEntry } from './snapshot-checkpoint-files.js';

export interface VerifiedSnapshotCheckpointAsset {
  index: number; ual: string; graph: string; metaGraph: string; root: string; version: string;
  publicQuads: number; dataSha256: string; metadataSha256: string;
}

/** The result is an isolated import candidate; it confers no live Edge coverage. */
export async function verifySnapshotCheckpoint(options: {
  directory: string; entries: readonly SnapshotCheckpointEntry[]; evidence: PublicSnapshotEvidence;
  signal: AbortSignal; assertCurrent(): void; maxWorkers?: number;
  /** Pipeline entries are available only after their body and metadata are durable. */
  nextEntry?(signal: AbortSignal): Promise<SnapshotCheckpointEntry | undefined>;
  consumed?(entry: SnapshotCheckpointEntry): void;
}): Promise<VerifiedSnapshotCheckpointAsset[]> {
  const { directory, entries, evidence, signal } = options;
  signal.throwIfAborted(); options.assertCurrent();
  const expected = evidence.snapshot.assets.map(a => buildKnowledgeAssetUalFromOnChainIdV1(
    evidence.snapshot.chainId, evidence.snapshot.assetStorage, BigInt(a.id)));
  if (!options.nextEntry && (entries.length !== expected.length || entries.some((e, i) => e.ual !== expected[i])))
    throw new Error('Incomplete checkpoint inventory');
  const unique = new Set(entries.map(e => e.ual));
  if (unique.size !== entries.length || entries.some((e, i) => e.index !== i)) throw new Error('Invalid checkpoint selection');
  const loadDirectory = join(directory, 'load');
  await mkdir(loadDirectory, { mode: 0o700 });
  let next = 0;
  const verified: VerifiedSnapshotCheckpointAsset[] = [];
  await withSnapshotVerificationPool({ contextGraphId: evidence.snapshot.contextGraphId, signal,
    maxWorkers: options.maxWorkers,
    run: async lane => {
      for (;;) {
        lane.signal.throwIfAborted(); options.assertCurrent();
        const entry = options.nextEntry ? await options.nextEntry(lane.signal) : entries[next];
        if (!entry) return;
        const index = next++;
        if (entry.index !== index || entry.ual !== expected[index]) throw new Error('Invalid checkpoint selection');
        try {
          const body = await readPinnedCheckpointFile(checkpointAssetPath(directory, index, 'body'), entry.bodySha256, 4 * 1024 * 1024);
          const metadata = await readPinnedCheckpointFile(checkpointAssetPath(directory, index, 'meta'), entry.metadataSha256, 66_000);
          const decoded = await decodeNegotiatedExactSyncResponse(body, { allowCompression: true, signal: lane.signal });
          if (decoded.bytes.length !== entry.plainBytes) throw new Error('Checkpoint expanded size mismatch');
          const asset = await lane.verify({ assetIndex: index, assetUal: entry.ual,
            metadataBytes: metadata, dataBytes: decoded.bytes });
          const authenticated = evidence.authenticate(asset, undefined, lane.signal).asset;
          // Only the verified quad collection may cross into the native parser.
          // Never reuse supplier bytes: its syntax can include rows our parser ignored.
          const safeData = Buffer.from(authenticated.dataQuads.map(q => `${quadToBlazegraphNQuad(q)}\n`).join(''));
          const compressed = await gzipBounded(safeData, {
            maxInputBytes: 16 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024,
            timeoutMs: 5_000, signal: lane.signal,
          });
          // This journal is empty. No current version or local control sidecar
          // exists to merge; authentication already supplied receiver-owned metadata.
          const safeMeta = Buffer.from(authenticated.metadataQuads.map(q => `${quadToBlazegraphNQuad(q)}\n`).join(''));
          lane.signal.throwIfAborted(); options.assertCurrent();
          await writeCheckpointFile(checkpointAssetPath(loadDirectory, index, 'verified.nq.gz'), compressed);
          await writeCheckpointFile(checkpointAssetPath(loadDirectory, index, 'verified.meta.nq'), safeMeta);
          verified[index] = { index, ual: asset.ual, graph: asset.assertionGraph, metaGraph: asset.metaGraph,
            root: asset.merkleRootHex, version: asset.assertionVersion.toString(), publicQuads: asset.dataQuads.length,
            dataSha256: checkpointSha256(compressed), metadataSha256: checkpointSha256(safeMeta) };
        } finally { options.consumed?.(entry); }
      }
    },
  });
  signal.throwIfAborted(); options.assertCurrent();
  if (verified.length !== expected.length || expected.some((_, i) => !verified[i])) throw new Error('Incomplete checkpoint verification');
  const trust = evidence.mode === 'core-cache' ? coreTrustedGraphQuads(evidence.snapshot.contextGraphId) : [];
  const trustBytes = trust.map(q => `${quadToBlazegraphNQuad(q)}\n`).join('');
  await writeCheckpointFile(join(loadDirectory, 'trust.nq'), trustBytes);
  await syncCheckpointDirectory(loadDirectory);
  return verified;
}
