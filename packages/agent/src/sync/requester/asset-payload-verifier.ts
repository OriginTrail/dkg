// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';
import { observeExactBatch } from '../exact-batch-observation.js';
import { parseGraphScopedDescriptor } from '../durable-integrity.js';
import { estimateQuadHeapBytes } from '../memory-telemetry.js';
import type { DurableSyncContext } from './durable-sync.js';
import { assertNoLegacyRfc64ControlGraphs, partitionVerifiedGraphScopedAssets } from './verified-asset-preparation.js';

/** Already decoded by the transport adapter, within the shared codec bounds. */
export interface DecodedAssetPayload {
  readonly assetIndex: number;
  readonly assetUal: string;
  readonly metadataBytes: Uint8Array;
  readonly dataBytes: Uint8Array;
}
export type AssetVerificationStage = 'decode' | 'parse' | 'verify' | 'authenticate-and-store';
export interface AssetVerificationOptions {
  readonly contextGraphId: string;
  readonly assetUals: readonly string[];
  readonly ctx: Parameters<DurableSyncContext['processDurableBatchInWorker']>[2];
  readonly parseAndFilter: (text: string, graph: string, contextGraphId: string) => Promise<{ quads: Quad[]; totalQuads: number }>;
  readonly processDurableBatchInWorker: DurableSyncContext['processDurableBatchInWorker'];
  readonly onStage?: (stage: AssetVerificationStage, assetIndex: number, durationMs: number) => void;
}

const META_GRAPH_SUFFIX = '/_meta';
const MAX_PARSED_HEAP = 32 * 1024 * 1024;
const MAX_ROWS = 100_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Parse and verify decoded content; callers own authentication and materialization. */
export function createAssetPayloadVerifier(options: AssetVerificationOptions) {
  return async (received: DecodedAssetPayload, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    let started: number;
    const metaGraph = `did:dkg:context-graph:${options.contextGraphId}${META_GRAPH_SUFFIX}`;
    started = performance.now();
    const metadata = await options.parseAndFilter(UTF8.decode(received.metadataBytes), metaGraph, options.contextGraphId);
    signal?.throwIfAborted();
    // Filter loss is not permission to commit a truncated or cross-graph header.
    if (metadata.totalQuads !== metadata.quads.length || metadata.quads.some(q => q.subject !== received.assetUal || q.graph !== metaGraph)) throw new Error('Exact batch metadata scope mismatch');
    const descriptor = parseGraphScopedDescriptor(received.assetUal, metadata.quads);
    if (descriptor.contextGraphId !== options.contextGraphId || descriptor.privateTripleCount !== 0 || descriptor.publicTripleCount < 1) throw new Error('Exact batch requires a nonempty public assertion');
    const data = await options.parseAndFilter(UTF8.decode(received.dataBytes), descriptor.assertionGraph, options.contextGraphId);
    signal?.throwIfAborted();
    if (data.totalQuads !== data.quads.length || data.quads.length !== descriptor.publicTripleCount || data.quads.some(q => q.graph !== descriptor.assertionGraph)) throw new Error('Exact batch body scope or count mismatch');
    if (data.quads.length > MAX_ROWS || metadata.quads.length > 128) throw new RangeError('Exact batch parsed row allowance exceeded');
    let heap = 0;
    for (const q of data.quads) heap += estimateQuadHeapBytes(q);
    for (const q of metadata.quads) heap += estimateQuadHeapBytes(q);
    if (heap > MAX_PARSED_HEAP) throw new RangeError('Exact batch parsed heap allowance exceeded');
    observeExactBatch(() => options.onStage?.('parse', received.assetIndex, performance.now() - started));
    started = performance.now();
    const processed = await options.processDurableBatchInWorker(data.quads, metadata.quads, options.ctx, false,
      { kind: 'changelogPage', changedDataGraphs: [descriptor.assertionGraph] });
    signal?.throwIfAborted();
    observeExactBatch(() => options.onStage?.('verify', received.assetIndex, performance.now() - started));
    if (processed.rejectedKcs !== 0 || processed.dataRejectedMissingMeta !== 0 || processed.verifiedData.length !== data.quads.length) throw new Error('Exact batch canonical integrity verification rejected');
    const verifiedGraphs = processed.verifiedGraphScopedDataGraphs ?? [];
    assertNoLegacyRfc64ControlGraphs(options.contextGraphId, processed.verifiedData, processed.verifiedMeta, verifiedGraphs);
    const partition = partitionVerifiedGraphScopedAssets(options.contextGraphId, processed.verifiedData, processed.verifiedMeta, verifiedGraphs);
    if (partition.assets.length !== 1 || partition.remainingData.length !== 0 || partition.remainingMeta.length !== 0) throw new Error('Exact batch requires one complete verified graph-scoped asset');
    const asset = partition.assets[0]!;
    if (asset.ual !== received.assetUal || asset.assertionGraph !== descriptor.assertionGraph || asset.assertionVersion.toString() !== descriptor.assertionVersion) throw new Error('Exact batch verified identity mismatch');
    return asset;
  };
}
