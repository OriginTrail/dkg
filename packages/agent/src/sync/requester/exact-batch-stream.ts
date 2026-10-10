// SPDX-License-Identifier: Apache-2.0
import type { ExactBatchTransportSession } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  EXACT_BATCH_BATCH_INDEX, EXACT_BATCH_FRAME_KIND as K, EXACT_BATCH_STREAM_WINDOW_SIZE,
  ExactBatchReceiveWindow, decodeExactBatchAsset,
  type ExactBatchFrame, type ExactBatchRefusal, type ReceivedExactBatchAsset,
} from '../exact-batch-stream-contract.js';
import { requireExactAssetUals } from '../exact-assets.js';
import { observeExactBatch } from '../exact-batch-observation.js';
import { parseGraphScopedDescriptor } from '../durable-integrity.js';
import { estimateQuadHeapBytes } from '../memory-telemetry.js';
import type { DurableSyncContext } from './durable-sync.js';
import { assertNoLegacyRfc64ControlGraphs, partitionVerifiedGraphScopedAssets } from './verified-asset-preparation.js';

/** Agent consumes the public operations of Core's fixed wire session. */
export type ExactBatchAgentSession = Pick<ExactBatchTransportSession, 'signal' | 'windowSize' | 'assetUals' | 'next' | 'send'>;
export type ExactBatchStage = 'decode' | 'parse' | 'verify' | 'authenticate-and-store';
export interface ExactBatchVerifiedReceiverOptions {
  readonly contextGraphId: string;
  readonly assetUals: readonly string[];
  readonly ctx: Parameters<DurableSyncContext['processDurableBatchInWorker']>[2];
  readonly parseAndFilter: (text: string, graph: string, contextGraphId: string) => Promise<{ quads: Quad[]; totalQuads: number }>;
  readonly processDurableBatchInWorker: DurableSyncContext['processDurableBatchInWorker'];
  /** The normal host callback, including chain/binding fences, atomic write and retirement. */
  readonly storeGraphScopedAsset: NonNullable<DurableSyncContext['storeGraphScopedAsset']>;
  readonly authenticationDeadline: () => number;
  readonly onStage?: (stage: ExactBatchStage, assetIndex: number, durationMs: number) => void;
  /** Observation only, after the normal store callback; progress is returned separately. */
  readonly onCommitted?: (assetUal: string) => void;
}
export interface ExactBatchVerifiedResult {
  readonly complete: true;
  readonly committedAssetUals: readonly string[];
}

export { exactBatchTransportOptions } from '../exact-batch-transport-options.js';
/** Settled local observations only; these never grant recovery or holder credit. */
export interface ExactBatchRefusalObservation {
  readonly code: ExactBatchRefusal;
  readonly startedAssets: number;
  readonly committedAssets: number;
  readonly acknowledgedAssets: number;
  readonly atAssetBoundary: boolean;
  readonly verifiedPrefix: boolean;
}
class ExactBatchRefusalError extends Error {
  constructor(readonly refusal: ExactBatchRefusal, readonly startedCount: number, readonly atAssetBoundary: boolean) {
    super(`Exact batch responder refused: ${refusal}`);
  }
}
export class ExactBatchPartialSyncError extends Error {
  readonly code = 'EXACT_BATCH_PARTIAL';
  constructor(readonly committedAssetUals: readonly string[], cause: unknown,
    readonly refusalObservation?: ExactBatchRefusalObservation,
    /**
     * The stream itself failed or ended before completion, and no local
     * cancellation caused it. False for a refusal, for an asset this node
     * rejected or could not store, and for a frame the receive window refused.
     */
    readonly streamInterrupted = false) {
    super('Exact batch stopped before verified completion', { cause });
  }
}
/**
 * The stream itself failed: a read or a send rejected, or it ended before
 * BATCH_END. Raised only where the session is used, so what the verifier, the
 * store or the receive window reject never carries it. `cause` is the failure
 * as the session reported it, and the only thing callers get to see.
 */
class ExactBatchStreamFailure extends Error {
  constructor(cause: unknown) { super('Exact batch stream failed', { cause }); }
}
function withoutStreamFailureTag(failure: unknown): unknown {
  return failure instanceof ExactBatchStreamFailure ? failure.cause : failure;
}
interface ExactBatchProgress {
  readonly committedAssetUals: string[];
  refusalObservation?: ExactBatchRefusalObservation;
}
function committedPrefix(progress: ExactBatchProgress): readonly string[] {
  return Object.freeze([...progress.committedAssetUals]);
}
/**
 * `failure` is what ended the exchange: the first thing to fail, because a
 * read left pending rejects only later, once the stream is torn down. A
 * cancelled session is never an interrupted stream.
 */
function partialSyncError(progress: ExactBatchProgress, failure: unknown, signal?: AbortSignal): ExactBatchPartialSyncError {
  const cause = withoutStreamFailureTag(failure);
  return new ExactBatchPartialSyncError(committedPrefix(progress), cause,
    cause instanceof ExactBatchRefusalError && !signal?.aborted ? progress.refusalObservation : undefined,
    failure instanceof ExactBatchStreamFailure && !signal?.aborted);
}
const META_GRAPH_SUFFIX = '/_meta';
const MAX_PARSED_HEAP = 32 * 1024 * 1024;
const MAX_ROWS = 100_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Normal worker and graph-scoped callback; no direct INSERT or authority bypass. */
export function createExactBatchVerifiedCommitter(options: ExactBatchVerifiedReceiverOptions) {
  return async (received: ReceivedExactBatchAsset, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    let started = performance.now();
    const decoded = await decodeExactBatchAsset(received, { signal });
    observeExactBatch(() => options.onStage?.('decode', received.assetIndex, performance.now() - started));
    const metaGraph = `did:dkg:context-graph:${options.contextGraphId}${META_GRAPH_SUFFIX}`;
    started = performance.now();
    const metadata = await options.parseAndFilter(UTF8.decode(received.metadataBytes), metaGraph, options.contextGraphId);
    signal?.throwIfAborted();
    // Filter loss is not permission to commit a truncated or cross-graph header.
    if (metadata.totalQuads !== metadata.quads.length || metadata.quads.some(q => q.subject !== received.assetUal || q.graph !== metaGraph)) throw new Error('Exact batch metadata scope mismatch');
    const descriptor = parseGraphScopedDescriptor(received.assetUal, metadata.quads);
    if (descriptor.contextGraphId !== options.contextGraphId || descriptor.privateTripleCount !== 0 || descriptor.publicTripleCount < 1) throw new Error('Exact batch requires a nonempty public assertion');
    const data = await options.parseAndFilter(UTF8.decode(decoded.bytes), descriptor.assertionGraph, options.contextGraphId);
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
    const deadline = options.authenticationDeadline();
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('Exact batch authentication deadline expired');
    started = performance.now();
    const outcome = await options.storeGraphScopedAsset({ asset, authenticationDeadline: deadline, signal });
    observeExactBatch(() => options.onStage?.('authenticate-and-store', received.assetIndex, performance.now() - started));
    // The prototype ACK certifies a completed normal atomic application, not an
    // inferred stale/quarantined result or mere receipt of peer bytes.
    if (outcome !== 'applied') throw new Error('Exact batch asset did not complete atomic materialization');
    observeExactBatch(() => options.onCommitted?.(asset.ual));
  };
}

/**
 * One reader overlaps the next compressed asset with one normal verifier/write.
 * On failure the Core exchange must abort the physical stream and settle its
 * decoder before returning. Pending reads remain owned by that exchange; this
 * module never releases a live atomic callback by racing it against cancellation.
 */
export async function consumeExactBatchVerifiedSession(session: ExactBatchAgentSession, options: ExactBatchVerifiedReceiverOptions): Promise<ExactBatchVerifiedResult> {
  const selected = validateExactBatchSelection(session, options);
  const progress: ExactBatchProgress = { committedAssetUals: [] };
  try {
    return await consumeExactBatchWithProgress(session, options, selected, progress);
  } catch (cause) {
    throw partialSyncError(progress, cause, session.signal);
  }
}

function validateExactBatchSelection(session: ExactBatchAgentSession, options: ExactBatchVerifiedReceiverOptions): string[] {
  if (session.windowSize !== EXACT_BATCH_STREAM_WINDOW_SIZE) throw new Error('Experimental exact batch requires fixed window2');
  const selected = requireExactAssetUals(options.assetUals);
  if (selected.length !== options.assetUals.length || JSON.stringify(selected) !== JSON.stringify(session.assetUals)) throw new Error('Exact batch authorized selection mismatch');
  return selected;
}

async function consumeExactBatchWithProgress(session: ExactBatchAgentSession, options: ExactBatchVerifiedReceiverOptions,
  selected: readonly string[], progress: ExactBatchProgress): Promise<ExactBatchVerifiedResult> {
  const window = new ExactBatchReceiveWindow({ assetUals: selected, windowSize: EXACT_BATCH_STREAM_WINDOW_SIZE });
  const cancellation = new AbortController();
  const signal = AbortSignal.any([session.signal, cancellation.signal]);
  const verifyAndCommit = createExactBatchVerifiedCommitter(options);
  const commit = async (asset: ReceivedExactBatchAsset, commitSignal?: AbortSignal) => {
    await verifyAndCommit(asset, commitSignal);
    // Required progress follows settled atomic application, independent of
    // observers and before the receive window checks cancellation for ACK.
    progress.committedAssetUals.push(asset.assetUal);
  };
  let stopped = false, batchEnded = false, acknowledgedAssets = 0;
  let wake: (() => void) | undefined;
  const notify = () => { const waiting = wake; wake = undefined; waiting?.(); };
  const onStream = async <T>(io: () => Promise<T>): Promise<T> => {
    try { return await io(); } catch (cause) { throw new ExactBatchStreamFailure(cause); }
  };
  const reader = (async () => {
    while (!stopped) {
      const incoming = await onStream(() => session.next());
      if (stopped) return;
      if (!incoming) throw new ExactBatchStreamFailure(new Error('Exact batch ended without explicit completion'));
      window.accept(incoming); notify();
      if (incoming.kind === K.REFUSE) throw new ExactBatchRefusalError(window.refusal!, window.startedCount, window.atAssetBoundary);
      if (incoming.kind === K.BATCH_END) { batchEnded = true; notify(); return; }
    }
  })();
  const committer = (async () => {
    while (!stopped && window.committedCount < selected.length) {
      signal.throwIfAborted();
      const asset = window.takeReady();
      if (!asset) { await new Promise<void>(resolve => { wake = resolve; }); continue; }
      const acknowledged = await window.commitAsset(asset, commit, { signal });
      await onStream(() => session.send(acknowledged));
      acknowledgedAssets += 1;
    }
  })();
  try {
    await Promise.all([reader, committer]);
    if (!batchEnded || !window.complete) throw new Error('Exact batch did not reach verified completion');
    return Object.freeze({ complete: true, committedAssetUals: committedPrefix(progress) });
  } catch (failure) {
    const cause = withoutStreamFailureTag(failure);
    stopped = true; cancellation.abort(cause); notify();
    await window.close();
    const prefix = progress.committedAssetUals;
    progress.refusalObservation = cause instanceof ExactBatchRefusalError && !session.signal.aborted
      ? Object.freeze({ code: cause.refusal, startedAssets: cause.startedCount,
          committedAssets: prefix.length, acknowledgedAssets, atAssetBoundary: cause.atAssetBoundary,
          verifiedPrefix: cause.atAssetBoundary && !batchEnded
            && prefix.length > 0 && prefix.length < selected.length
            && cause.startedCount === prefix.length && acknowledgedAssets === prefix.length
            && prefix.every((ual, index) => ual === selected[index]) })
      : undefined;
    // The owning public boundary normalizes the error after its physical
    // settlement, so a later close failure can replace refusal classification.
    // It also reads, and removes, the stream-failure tag.
    throw failure;
  } finally {
    stopped = true; notify();
    await window.close(); // physically await any verifier/write still running
  }
}

/** START contains unchanged bytes from the normal public or signed builder. */
export function exactBatchStartFrame(requestBytes: Uint8Array): ExactBatchFrame {
  if (requestBytes.byteLength < 1 || requestBytes.byteLength > 8192) throw new RangeError('Exact batch START exceeds request allowance');
  return { kind: K.REQUEST, assetIndex: EXACT_BATCH_BATCH_INDEX, sequence: 0, payload: requestBytes.slice() };
}

/**
 * Preserve real per-KA progress even if Core's final physical close rejects
 * after consume reached BATCH_END. No fallback can run inside this boundary.
 */
export async function exchangeExactBatchVerified(
  exchange: (consume: (session: ExactBatchAgentSession) => Promise<ExactBatchVerifiedResult>) => Promise<ExactBatchVerifiedResult>,
  options: ExactBatchVerifiedReceiverOptions,
): Promise<ExactBatchVerifiedResult> {
  const progress: ExactBatchProgress = { committedAssetUals: [] };
  let sessionSignal: AbortSignal | undefined;
  try {
    return await exchange(session => {
      sessionSignal = session.signal;
      return consumeExactBatchWithProgress(session, options, validateExactBatchSelection(session, options), progress);
    });
  } catch (cause) {
    throw partialSyncError(progress, cause, sessionSignal);
  }
}
