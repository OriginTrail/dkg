import { reserveBulkStagingDirectory } from './bulk-staging-directory.js';
// SPDX-License-Identifier: Apache-2.0
import { receiveBulkChunk } from './bulk-chunk-receiver.js';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BULK_GRAPH_KIND as K, exchangeBulkGraph,
  type BulkGraphSession, type ProtocolRouter, type DuplexStreamOptions } from '@origintrail-official/dkg-core';
import { type BulkGraphRequest } from '../bulk-graph-contract.js';
import { BulkStagingQueue } from './bulk-staging-queue.js';
import { BulkCommitGroup } from './bulk-commit-group.js';
import { createAssetPayloadVerifier, type AssetVerificationOptions } from './asset-payload-verifier.js';
import { decodeNegotiatedExactSyncResponse } from '../wire-compression.js';
import { observeExactBatch } from '../exact-batch-observation.js';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';

export interface BulkGraphMetrics { encodedBytes: number; receivedAssets: number; verifiedAssets: number;
  committedAssets: number; commitGroups: number; largestGroup: number; peakStagedBytes: number; commitMs: number }
export class BulkGraphPartialError extends Error {
  constructor(readonly committedAssetUals: readonly string[], readonly metrics: BulkGraphMetrics, cause: unknown) {
    super(`Bulk graph stopped before complete verified coverage: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
/** Preserve durable progress if closing an otherwise completed physical stream fails. */
export async function exchangeBulkGraphVerified(router: Pick<ProtocolRouter, 'withDuplexStream'>, peer: string, request: BulkGraphRequest,
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
  stagingRoot: string; verification: AssetVerificationOptions;
  commit: (assets: readonly VerifiedGraphScopedAsset[], signal: AbortSignal) => Promise<readonly VerifiedGraphScopedAsset[]>;
  reconcile?: (assets: readonly VerifiedGraphScopedAsset[], signal: AbortSignal) => Promise<void>;
  onMetrics?: (metrics: BulkGraphMetrics) => void;
}) {
  const directory = await reserveBulkStagingDirectory(options.stagingRoot);
  const queue = new BulkStagingQueue(session.signal);
  const signal = queue.signal;
  const metrics: BulkGraphMetrics = { encodedBytes: 0, receivedAssets: 0, verifiedAssets: 0, committedAssets: 0,
    commitGroups: 0, largestGroup: 0, peakStagedBytes: 0, commitMs: 0 };
  const committed: string[] = [];
  const observe = () => observeExactBatch(() => options.onMetrics?.({ ...metrics }));
  const reader = receiveBulkChunk(session, request, {
    signal,
    open: async (index, header) => {
      queue.reserve(header.encodedBytes);
      metrics.peakStagedBytes = queue.peakBytes;
      const file = await open(join(directory, `${index}.part`), 'wx', 0o600);
      return { write: bytes => file.writeFile(bytes), close: () => file.close() };
    },
    complete: async (index, header, chunks) => {
      metrics.encodedBytes += header.encodedBytes; metrics.receivedAssets++;
      queue.deliver({ index, path: join(directory, `${index}.part`), header, chunks }); observe();
    },
  }).then(() => queue.complete()).catch(error => queue.fail(error));
  const verify = createAssetPayloadVerifier(options.verification);
  const group = new BulkCommitGroup(async members => {
    signal.throwIfAborted();
    const started = performance.now();
    const authenticated = await options.commit(members.map(x => x.asset), signal);
    // Publication has completed. Preserve this prefix even if housekeeping or
    // acknowledgement fails, or cancellation arrives while the write drains.
    for (const { asset } of members) committed.push(asset.ual);
    metrics.committedAssets += members.length; metrics.commitGroups++;
    metrics.largestGroup = Math.max(metrics.largestGroup, members.length);
    metrics.commitMs += performance.now() - started;
    observe();
    await options.reconcile?.(authenticated, signal);
    signal.throwIfAborted();
    for (const { index, encodedBytes } of members) await session.send({ kind: K.COMMIT, index, sequence: encodedBytes, payload: new Uint8Array() });
    observe();
  });
  try {
    for (;;) {
      const delivery = await queue.next(group.flushAt);
      if (delivery.kind === 'done') break;
      if (delivery.kind === 'flush') { await group.flush(); continue; }
      const staged = delivery.value;
      const dataBytes = await readFile(staged.path);
      const started = performance.now();
      const decoded = await decodeNegotiatedExactSyncResponse(dataBytes, { allowCompression: true, signal });
      if (decoded.bytes.length !== staged.header.plainBytes) throw new Error('Bulk expanded size mismatch');
      observeExactBatch(() => options.verification.onStage?.('decode', staged.index, performance.now() - started));
      const asset = await verify({ assetIndex: staged.index, assetUal: request.assetUals[staged.index]!,
        metadataBytes: Buffer.from(staged.header.metadata, 'base64'), dataBytes: decoded.bytes }, signal);
      metrics.verifiedAssets++;
      // CREDIT returns bounded staging capacity after verification has consumed the file.
      // It is deliberately not durable coverage; only COMMIT has that meaning.
      await rm(staged.path); queue.consumed(staged.header.encodedBytes);
      await session.send({ kind: K.CREDIT, index: staged.index, sequence: staged.header.encodedBytes, payload: new Uint8Array() });
      await group.append({ asset, index: staged.index, encodedBytes: staged.header.encodedBytes, plainBytes: staged.header.plainBytes });
    }
    await group.flush();
    if (committed.length !== metrics.receivedAssets) throw new Error('Bulk chunk contains uncommitted assets');
    await reader;
    // Cleanup is part of the observed result: failures retain durable progress.
    await rm(directory, { recursive: true });
    return { committedAssetUals: committed, metrics };
  } catch (error) {
    queue.fail(error); session.abort(error);
    throw new BulkGraphPartialError([...committed], metrics, queue.error ?? error);
  } finally {
    // No writer/verifier is detached. Retain staging on failure for diagnosis;
    // successful chunks own and remove only their now-empty temporary directory.
    await reader;
  }
}
