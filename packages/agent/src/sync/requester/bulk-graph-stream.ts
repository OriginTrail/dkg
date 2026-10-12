// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BULK_GRAPH_CHUNK_BYTES, BULK_GRAPH_KIND as K, exchangeBulkGraph,
  type BulkGraphSession, type ProtocolRouter, type DuplexStreamOptions } from '@origintrail-official/dkg-core';
import { BULK_GROUP_ASSETS, BULK_GROUP_EXPANDED_BYTES, BULK_GROUP_HEAP_BYTES,
  BULK_STAGING_ASSETS, BULK_STAGING_BYTES, bulkChunkHash, readBulkJson, parseBulkAssetHeader,
  type BulkGraphRequest, type BulkAssetHeader } from '../bulk-graph-contract.js';
import { estimateQuadHeapBytes } from '../memory-telemetry.js';
import { createExactBatchAssetVerifier, type ExactBatchVerifiedReceiverOptions } from './exact-batch-stream.js';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';

interface Staged { index: number; path: string; header: BulkAssetHeader; chunks: number }
export interface BulkGraphMetrics { encodedBytes: number; receivedAssets: number; verifiedAssets: number;
  committedAssets: number; commitGroups: number; largestGroup: number; peakStagedBytes: number; commitMs: number }
export class BulkGraphPartialError extends Error {
  constructor(readonly committedAssetUals: readonly string[], readonly metrics: BulkGraphMetrics, cause: unknown) {
    super(`Bulk graph stopped before complete verified coverage: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
/** Preserve durable progress if closing an otherwise completed physical stream fails. */
export async function exchangeBulkGraphVerified(router: ProtocolRouter, peer: string, request: BulkGraphRequest,
  transport: DuplexStreamOptions, options: Parameters<typeof consumeBulkGraph>[2]) {
  let completed: Awaited<ReturnType<typeof consumeBulkGraph>> | undefined;
  try {
    return await exchangeBulkGraph(router, peer, new TextEncoder().encode(JSON.stringify(request)), transport, async session => {
      completed = await consumeBulkGraph(session, request, options);
      return completed;
    });
  } catch (error) {
    if (completed) throw new BulkGraphPartialError(completed.committedAssetUals, completed.metrics, error);
    throw error;
  }
}
/** Disk staging and one bounded verifier/group writer overlap the continuous network reader. */
export async function consumeBulkGraph(session: BulkGraphSession, request: BulkGraphRequest, options: {
  stagingRoot: string; verification: ExactBatchVerifiedReceiverOptions;
  commit: (assets: readonly VerifiedGraphScopedAsset[], signal: AbortSignal) => Promise<void>;
  onMetrics?: (metrics: BulkGraphMetrics) => void;
}) {
  await mkdir(options.stagingRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(options.stagingRoot, 'chunk-'));
  const cancellation = new AbortController();
  const signal = AbortSignal.any([session.signal, cancellation.signal]);
  const metrics: BulkGraphMetrics = { encodedBytes: 0, receivedAssets: 0, verifiedAssets: 0, committedAssets: 0,
    commitGroups: 0, largestGroup: 0, peakStagedBytes: 0, commitMs: 0 };
  const committed: string[] = [], queue: Staged[] = [];
  let ended = false, failure: unknown, stagedBytes = 0, stagedCount = 0;
  let wake: (() => void) | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const wait = () => new Promise<void>(resolve => {
    const timer = setTimeout(() => { wake = undefined; resolve(); }, 250);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const observe = () => { try { options.onMetrics?.({ ...metrics }); } catch { /* diagnostic only */ } };
  const hash = bulkChunkHash(request);
  const reader = (async () => {
    while (!ended) {
      signal.throwIfAborted();
      const frame = await session.next();
      if (frame.kind === K.REFUSE) {
        const refusal = readBulkJson(frame.payload) as { code?: unknown };
        if (refusal?.code !== 'RESOURCE_LIMIT' || frame.index !== metrics.receivedAssets || frame.sequence !== 0)
          throw new Error('Invalid bulk graph refusal');
        throw Object.assign(new Error('Bulk graph source refused RESOURCE_LIMIT'), { code: 'RESOURCE_LIMIT' });
      }
      if (frame.kind === K.CHUNK_END) {
        const end = readBulkJson(frame.payload) as { digest: string; assets: number; encodedBytes: number };
        if (!metrics.receivedAssets || frame.index !== metrics.receivedAssets || frame.sequence !== metrics.encodedBytes
          || end.assets !== frame.index || end.encodedBytes !== frame.sequence || end.digest !== hash.digest('hex'))
          throw new Error('Bulk chunk directory digest or coverage mismatch');
        ended = true; notify(); return;
      }
      if (frame.kind !== K.META || frame.index !== metrics.receivedAssets || frame.index >= request.assetUals.length || frame.sequence !== 0)
        throw new Error('Bulk asset order mismatch');
      const header = parseBulkAssetHeader(frame.payload);
      if (header.offset !== metrics.encodedBytes || header.encodedBytes > BULK_GRAPH_CHUNK_BYTES - metrics.encodedBytes
        || stagedBytes + header.encodedBytes > BULK_STAGING_BYTES || stagedCount >= BULK_STAGING_ASSETS)
        throw new RangeError('Bulk chunk or staging credit exceeded');
      stagedBytes += header.encodedBytes; stagedCount++;
      metrics.peakStagedBytes = Math.max(metrics.peakStagedBytes, stagedBytes);
      hash.update(frame.payload);
      const assetHash = createHash('sha256');
      const path = join(directory, `${frame.index}.part`);
      const file = await open(path, 'wx', 0o600);
      let bytes = 0, chunks = 0;
      try {
        for (;;) {
          const next = await session.next(); signal.throwIfAborted();
          if (next.index !== frame.index || next.sequence !== chunks) throw new Error('Bulk data order mismatch');
          if (next.kind === K.ASSET_END) break;
          if (next.kind !== K.DATA || next.payload.length > header.encodedBytes - bytes) throw new Error('Bulk body size mismatch');
          // FileHandle.write can write a prefix; writeFile completes the bounded frame.
          await file.writeFile(next.payload); bytes += next.payload.length; chunks++;
          hash.update(next.payload); assetHash.update(next.payload);
        }
        if (!chunks || bytes !== header.encodedBytes || assetHash.digest('hex') !== header.digest) throw new Error('Bulk encoded asset digest mismatch');
      } finally { await file.close(); }
      metrics.encodedBytes += bytes; metrics.receivedAssets++;
      queue.push({ index: frame.index, path, header, chunks }); notify(); observe();
    }
  })().catch(error => { failure = error; cancellation.abort(error); notify(); });
  const verify = createExactBatchAssetVerifier(options.verification);
  let group: { asset: VerifiedGraphScopedAsset; staged: Staged }[] = [], heap = 0, expanded = 0, groupAt = 0;
  const flush = async () => {
    if (!group.length) return;
    signal.throwIfAborted();
    const started = performance.now();
    await options.commit(group.map(x => x.asset), signal);
    // Update durable progress before I/O; a lost ACK never erases successful local commits.
    for (const { asset } of group) committed.push(asset.ual);
    metrics.committedAssets += group.length; metrics.commitGroups++;
    metrics.largestGroup = Math.max(metrics.largestGroup, group.length); metrics.commitMs += performance.now() - started;
    for (const { staged } of group) await session.send({ kind: K.COMMIT, index: staged.index, sequence: staged.header.encodedBytes, payload: new Uint8Array() });
    group = []; heap = 0; expanded = 0; observe();
  };
  try {
    while (!ended || queue.length) {
      signal.throwIfAborted();
      const staged = queue.shift();
      if (!staged) {
        if (group.length && Date.now() - groupAt >= 1000) await flush();
        await wait(); continue;
      }
      const dataBytes = await readFile(staged.path);
      const asset = await verify({ assetIndex: staged.index, assetUal: request.assetUals[staged.index]!,
        metadataBytes: Buffer.from(staged.header.metadata, 'base64'), dataBytes, plainBytes: staged.header.plainBytes, chunkCount: staged.chunks }, signal);
      let assetHeap = 0;
      for (const q of [...asset.dataQuads, ...asset.metadataQuads]) assetHeap += estimateQuadHeapBytes(q);
      if (group.length && (heap + assetHeap > BULK_GROUP_HEAP_BYTES || expanded + staged.header.plainBytes > BULK_GROUP_EXPANDED_BYTES)) await flush();
      if (!group.length) groupAt = Date.now();
      group.push({ asset, staged }); heap += assetHeap; expanded += staged.header.plainBytes; metrics.verifiedAssets++;
      // CREDIT returns bounded staging capacity after verification has consumed the file.
      // It is deliberately not durable coverage; only COMMIT has that meaning.
      await rm(staged.path); stagedBytes -= staged.header.encodedBytes; stagedCount--;
      await session.send({ kind: K.CREDIT, index: staged.index, sequence: staged.header.encodedBytes, payload: new Uint8Array() });
      if (group.length >= BULK_GROUP_ASSETS || expanded >= BULK_GROUP_EXPANDED_BYTES || Date.now() - groupAt >= 1000) await flush();
    }
    if (failure) throw failure;
    await flush();
    if (committed.length !== metrics.receivedAssets) throw new Error('Bulk chunk contains uncommitted assets');
    return { committedAssetUals: committed, metrics };
  } catch (error) {
    cancellation.abort(error); session.abort(error);
    throw new BulkGraphPartialError([...committed], metrics, failure ?? error);
  } finally {
    // No writer/verifier is detached. Retain staging on failure for diagnosis;
    // successful chunks own and remove only their now-empty temporary directory.
    await reader;
    if (ended && !signal.aborted && committed.length === metrics.receivedAssets) await rm(directory, { recursive: true });
  }
}
