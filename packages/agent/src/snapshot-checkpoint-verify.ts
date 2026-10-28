// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipBounded, buildKnowledgeAssetUalFromOnChainIdV1 } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { quadToBlazegraphNQuad } from '@origintrail-official/dkg-storage/dist/adapters/blazegraph-nquads.js';
import { PublicSnapshotEvidence, markCoreTrustedGraph } from './public-snapshot-evidence.js';
import { withSnapshotVerificationPool } from './snapshot-verification-pool.js';
import { decodeNegotiatedExactSyncResponse, EXACT_SYNC_GZIP_HEADER_BYTES } from './sync/wire-compression.js';
import { prepareGraphScopedReplacementUnderLock } from './sync/requester/graph-scoped-replacement.js';
import { checkpointAssetPath, checkpointSha256, syncCheckpointDirectory, writeCheckpointFile,
  type SnapshotCheckpointEntry } from './snapshot-checkpoint-files.js';

export interface VerifiedSnapshotCheckpointAsset {
  index: number; ual: string; graph: string; metaGraph: string; root: string; version: string;
  publicQuads: number; dataSha256: string; metadataSha256: string;
}

async function readPinnedFile(path: string, expected: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Unsafe checkpoint input');
    const bytes = await file.readFile();
    if (checkpointSha256(bytes) !== expected) throw new Error('Checkpoint input changed');
    return bytes;
  } finally { await file.close(); }
}

/** The result is an isolated import candidate; it confers no live Edge coverage. */
export async function verifySnapshotCheckpoint(options: {
  directory: string; entries: readonly SnapshotCheckpointEntry[]; evidence: PublicSnapshotEvidence;
  signal: AbortSignal; assertCurrent(): void; maxWorkers?: number;
}): Promise<VerifiedSnapshotCheckpointAsset[]> {
  const { directory, entries, evidence, signal } = options;
  signal.throwIfAborted(); options.assertCurrent();
  const expected = evidence.snapshot.assets.map(a => buildKnowledgeAssetUalFromOnChainIdV1(
    evidence.snapshot.chainId, evidence.snapshot.assetStorage, BigInt(a.id)));
  if (entries.length !== expected.length || entries.some((e, i) => e.ual !== expected[i]))
    throw new Error('Incomplete checkpoint inventory');
  const unique = new Set(entries.map(e => e.ual));
  if (unique.size !== entries.length || entries.some((e, i) => e.index !== i)) throw new Error('Invalid checkpoint selection');
  const loadDirectory = join(directory, 'load');
  await mkdir(loadDirectory, { mode: 0o700 });
  // The new journal has no existing asset state. Never use this preparation to
  // overwrite a running store; activation must separately prove fresh ownership.
  const empty = new OxigraphStore();
  let next = 0;
  const verified: VerifiedSnapshotCheckpointAsset[] = [];
  try {
    await withSnapshotVerificationPool({ contextGraphId: evidence.snapshot.contextGraphId, signal,
      maxWorkers: options.maxWorkers,
      run: async lane => {
        for (;;) {
          signal.throwIfAborted(); options.assertCurrent();
          const index = next++;
          if (index >= entries.length) return;
          const entry = entries[index]!;
          const body = await readPinnedFile(checkpointAssetPath(directory, index, 'body'), entry.bodySha256, 4 * 1024 * 1024);
          const metadata = await readPinnedFile(checkpointAssetPath(directory, index, 'meta'), entry.metadataSha256, 66_000);
          const decoded = await decodeNegotiatedExactSyncResponse(body, { allowCompression: true, signal });
          if (decoded.bytes.length !== entry.plainBytes) throw new Error('Checkpoint expanded size mismatch');
          const asset = await lane.verify({ assetIndex: index, assetUal: entry.ual,
            metadataBytes: metadata, dataBytes: decoded.bytes });
          const authenticated = evidence.authenticate(asset, undefined, signal).asset;
          const replacement = await prepareGraphScopedReplacementUnderLock({ store: empty, asset: authenticated,
            options: { signal }, assertCurrent: options.assertCurrent, requireCurrentMetadata: true });
          if (!replacement) throw new Error('Checkpoint metadata preparation refused');
          // The current negotiated frame has a fixed 20-byte header. The decoder
          // has already checked it and the complete gzip member; verification
          // above rejected every extra/missing/cross-graph or unauthenticated row.
          const compressed = decoded.compressed ? body.subarray(EXACT_SYNC_GZIP_HEADER_BYTES) : await gzipBounded(decoded.bytes, {
            maxInputBytes: 16 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024,
            timeoutMs: 5_000, signal,
          });
          const safeMeta = Buffer.from(replacement.metadataQuads.map(q => `${quadToBlazegraphNQuad(q)}\n`).join(''));
          signal.throwIfAborted(); options.assertCurrent();
          await writeCheckpointFile(checkpointAssetPath(loadDirectory, index, 'verified.nq.gz'), compressed);
          await writeCheckpointFile(checkpointAssetPath(loadDirectory, index, 'verified.meta.nq'), safeMeta);
          verified[index] = { index, ual: asset.ual, graph: asset.assertionGraph, metaGraph: asset.metaGraph,
            root: asset.merkleRootHex, version: asset.assertionVersion.toString(), publicQuads: asset.dataQuads.length,
            dataSha256: checkpointSha256(compressed), metadataSha256: checkpointSha256(safeMeta) };
        }
      },
    });
    signal.throwIfAborted(); options.assertCurrent();
    if (verified.length !== entries.length || entries.some((_, i) => !verified[i])) throw new Error('Incomplete checkpoint verification');
    if (evidence.mode === 'core-cache') await markCoreTrustedGraph(empty, evidence.snapshot.contextGraphId);
    const trust = await empty.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <urn:dkg:local:public-snapshot-trust> { ?s ?p ?o } }');
    if (trust.type !== 'quads') throw new Error('Checkpoint trust metadata unavailable');
    const trustBytes = trust.quads.map(q => quadToBlazegraphNQuad({ ...q, graph: 'urn:dkg:local:public-snapshot-trust' }) + '\n').join('');
    await writeCheckpointFile(join(loadDirectory, 'trust.nq'), trustBytes);
    await syncCheckpointDirectory(loadDirectory);
    return verified;
  } finally { await empty.close(); }
}
