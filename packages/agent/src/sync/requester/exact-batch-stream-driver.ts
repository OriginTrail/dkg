// SPDX-License-Identifier: Apache-2.0
import {
  exchangeExperimentalExactBatch, ExperimentalExactBatchUnsupportedError,
  type ExactBatchTransportEvent, type ProtocolRouter,
} from '@origintrail-official/dkg-core';
import { runBoundedOperation } from '../../bounded-operation.js';
import { SYNC_PAGE_SIZE } from '../../dkg-agent-constants.js';
import {
  createDurableSyncAccumulator, finalizeDurableSyncCompletion,
  markDurableTerminalBoundary, recordDurableSyncDiagnostics,
} from '../durable-progress.js';
import { buildSyncRequestEnvelope } from '../auth/request-build.js';
import { exactAssetUalsForSelection, type UalOnlyExactAssetSelection } from '../exact-assets.js';
import {
  exactBatchStreamUnsupported, rememberExactBatchStreamResourceRefusal,
  rememberExactBatchStreamUnsupported, type ExactBatchStreamRefusalScope,
} from '../exact-batch-stream-capability.js';
import { observeExactBatch } from '../exact-batch-observation.js';
import { EXACT_BATCH_STREAM_PROTOCOL } from '../exact-batch-stream-contract.js';
import {
  exactBatchTransportOptions, exactBatchStartFrame, exchangeExactBatchVerified,
  ExactBatchPartialSyncError, type ExactBatchVerifiedReceiverOptions,
} from './exact-batch-stream.js';
import type { ExactRecoveryTransportMode } from './exact-recovery-transport.js';
import type { DetailedDurableSyncResult } from './durable-sync.js';

export interface ExactBatchStreamDriverOptions {
  readonly contextGraphId: string;
  readonly remotePeerId: string;
  readonly selection: UalOnlyExactAssetSelection;
  readonly transportMode: ExactRecoveryTransportMode;
  readonly streamEnabled: boolean;
  readonly fetchDeadline: number;
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
}

/** Authority and materialization stay with the lifecycle's guarded operations. */
export interface ExactBatchStreamDriverPorts {
  readonly router: ProtocolRouter;
  readonly capabilityOwner: object;
  readonly captureConnectionKey: () => string | null;
  readonly captureRefusalScope: () => ExactBatchStreamRefusalScope | null;
  readonly isChainEnabled: () => boolean;
  readonly getPeerProtocols: () => Promise<readonly string[]>;
  readonly isRegisteredPublic: () => Promise<boolean>;
  readonly requestIdentity: () => Pick<Parameters<typeof buildSyncRequestEnvelope>[0],
    'requesterPeerId' | 'computeSyncDigest' | 'getIdentityId' | 'signMessage'>;
  readonly verification: Omit<ExactBatchVerifiedReceiverOptions,
    'contextGraphId' | 'assetUals' | 'onStage' | 'onCommitted'>;
  /**
   * Make sure the peer is connected and admitted again after its stream broke.
   * Resolves false while it is not. The driver bounds and cancels the call.
   */
  readonly reconnect: (signal: AbortSignal) => Promise<boolean>;
  readonly logInfo: (message: string) => void;
}

/** How a stream that broke is given a second exchange with the same peer. */
export const EXACT_BATCH_STREAM_RETRY = Object.freeze({
  /** Exchanges opened after a break, per driver call. */
  maxRetries: 1,
  /** How long the peer may take to be connected again. */
  reconnectWindowMs: 15_000,
  /** Pause between reconnection attempts inside that window. */
  reconnectPollMs: 1_000,
  /** Fetch time that must remain for a second exchange to be opened. */
  minRemainingMs: 5_000,
});

export type ExactBatchStreamDriverOutcome =
  | Readonly<{ kind: 'not-selected' }>
  | Readonly<{ kind: 'unsupported-before-start' }>
  | Readonly<{ kind: 'settled'; detailed: DetailedDurableSyncResult & {
      readonly committedExactAssetUals?: readonly string[];
    } }>;

function unavailableStream(): ExactBatchStreamDriverOutcome {
  const accumulator = createDurableSyncAccumulator();
  recordDurableSyncDiagnostics(accumulator, { failedPhases: 1 });
  markDurableTerminalBoundary(accumulator, false);
  return { kind: 'settled', detailed: {
    result: finalizeDurableSyncCompletion(accumulator), exactFetchDisposition: 'incomplete',
  } };
}

type DurableSyncAccumulator = ReturnType<typeof createDurableSyncAccumulator>;

/** One exchange: the assets it applied, and why it stopped if it did not complete. */
type ExactBatchExchange =
  | Readonly<{ complete: true; committedAssetUals: readonly string[] }>
  | Readonly<{ complete: false; committedAssetUals: readonly string[]; error: unknown }>;

function isUnsupportedBeforeStart(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return error instanceof ExperimentalExactBatchUnsupportedError
    || cause instanceof ExperimentalExactBatchUnsupportedError;
}

/**
 * Why an exchange stopped, as one log line. `origin` says where the failure
 * came from: the stream itself, a responder refusal, a local cancellation, or
 * anything else (verification, the store, a frame the window refused, or the
 * stream never opening). `lastStage` is the last stage that completed.
 */
function exactBatchFailureLine(error: unknown, fields: {
  readonly assetCount: number;
  readonly committedAssets: number;
  readonly lastStage: string;
  readonly cancelled: boolean;
}): string {
  const partial = error instanceof ExactBatchPartialSyncError ? error : undefined;
  const cause: unknown = partial === undefined ? error : partial.cause;
  const origin = fields.cancelled ? 'cancelled'
    : partial?.refusalObservation !== undefined ? 'refusal'
      : partial?.streamInterrupted === true ? 'stream'
        : 'other';
  const name = cause instanceof Error ? cause.name : typeof cause;
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  const detail = (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, ' ').slice(0, 200);
  return `Exact batch requester failure assetCount=${fields.assetCount} committedAssets=${fields.committedAssets} `
    + `origin=${origin} lastStage=${fields.lastStage} error=${name} `
    + `code=${typeof code === 'string' || typeof code === 'number' ? code : 'none'} detail=${JSON.stringify(detail)}`;
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(true); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Wait, inside the retry window and the fetch deadline, for the peer to be connected again. */
async function reconnectForRetry(
  options: ExactBatchStreamDriverOptions,
  ports: ExactBatchStreamDriverPorts,
): Promise<boolean> {
  const { signal } = options;
  const windowEndsAt = Math.min(
    Date.now() + EXACT_BATCH_STREAM_RETRY.reconnectWindowMs,
    options.fetchDeadline - EXACT_BATCH_STREAM_RETRY.minRemainingMs,
  );
  // The attempt count bounds the loop on its own, whatever the clock does.
  const maxAttempts = Math.ceil(
    EXACT_BATCH_STREAM_RETRY.reconnectWindowMs / EXACT_BATCH_STREAM_RETRY.reconnectPollMs,
  );
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const remainingMs = windowEndsAt - Date.now();
    if (remainingMs < 1 || signal?.aborted || options.isCurrent?.() === false) return false;
    try {
      if (await runBoundedOperation(attemptSignal => ports.reconnect(attemptSignal), {
        timeoutMs: remainingMs, label: 'Exact batch stream reconnect', signal,
      })) return true;
    } catch {
      // Cancelled, out of time, or the peer is still unreachable: the loop decides.
    }
    const pauseMs = Math.min(EXACT_BATCH_STREAM_RETRY.reconnectPollMs, windowEndsAt - Date.now());
    if (pauseMs < 1 || !await pause(pauseMs, signal)) return false;
  }
  return false;
}

/** Open one stream for `assetUals` and apply what it delivers. */
async function exchangeExactBatchOnce(
  options: ExactBatchStreamDriverOptions,
  ports: ExactBatchStreamDriverPorts,
  assetUals: readonly string[],
  accumulator: DurableSyncAccumulator,
): Promise<ExactBatchExchange> {
  const { contextGraphId, remotePeerId, signal } = options;
  let committedAssetUals: readonly string[] = Object.freeze([]);
  // Registered public authority permits the unchanged public START without
  // requiring an identity/signature from a requester that has not joined yet.
  const start = await buildSyncRequestEnvelope({
    contextGraphId, offset: 0, limit: SYNC_PAGE_SIZE, includeSharedMemory: false,
    targetPeerId: remotePeerId, phase: 'data',
    assetUals: [...assetUals], needsAuth: false, ...ports.requestIdentity(),
  });
  const remainingMs = Math.floor(options.fetchDeadline - Date.now());
  const exchangeStartedAtMs = Date.now();
  let streamComplete = false, streamReadyMs = -1, startSent = 0, nativeAcceptedSentBytes = 0, receivedPayloadBytes = 0;
  let lastStage = 'none';
  const sentFrames = [0, 0, 0, 0, 0, 0, 0, 0], receivedFrames = [0, 0, 0, 0, 0, 0, 0, 0];
  const onTransportEvent = (event: ExactBatchTransportEvent) => {
    if (event.event === 'streamReady') streamReadyMs = event.elapsedMs;
    else if (event.event === 'bytes') {
      if (event.direction === 'sent') nativeAcceptedSentBytes += event.byteLength;
      else receivedPayloadBytes += event.byteLength;
    } else {
      const frames = event.direction === 'sent' ? sentFrames : receivedFrames;
      frames[event.frameKind]! += 1;
      if (event.direction === 'sent' && event.frameKind === 1) {
        startSent += 1;
        observeExactBatch(() => ports.logInfo(
          `Exact batch requester start assetCount=${assetUals.length} requestEncodedBytes=${start.byteLength} sentAtMs=${Date.now()}`));
      }
    }
  };
  try {
    if (remainingMs < 1) throw new Error('Exact batch recovery fetch deadline expired');
    const exchanged = await exchangeExactBatchVerified(consume => exchangeExperimentalExactBatch(ports.router, remotePeerId,
      exactBatchStartFrame(start),
      { ...exactBatchTransportOptions(Math.min(120_000, remainingMs), signal), assetUals, onTransportEvent }, consume), {
      ...ports.verification, contextGraphId, assetUals,
      storeGraphScopedAsset: async request => {
        const outcome = await ports.verification.storeGraphScopedAsset(request);
        if (outcome === 'applied') {
          recordDurableSyncDiagnostics(accumulator, {
            insertedDataTriples: request.asset.dataQuads.length,
            insertedMetaTriples: request.asset.metadataQuads.length,
            insertedTriples: request.asset.dataQuads.length + request.asset.metadataQuads.length,
            fetchedDataTriples: request.asset.dataQuads.length,
            fetchedMetaTriples: request.asset.metadataQuads.length,
          });
        }
        return outcome;
      },
      onStage: (stage, assetIndex, durationMs) => {
        lastStage = `${stage}@${assetIndex}`;
        ports.logInfo(`Exact batch requester stage=${stage} asset=${assetIndex} durationMs=${durationMs.toFixed(3)}`);
      },
      onCommitted: ual => {
        const assetIndex = assetUals.indexOf(ual);
        ports.logInfo(`Exact batch committed asset=${assetIndex} committedAssets=${assetIndex + 1}`);
      },
    });
    committedAssetUals = exchanged.committedAssetUals;
    streamComplete = true;
    return { complete: true, committedAssetUals };
  } catch (error) {
    // Core settles physical stream/decoder cleanup before rejection. Progress
    // reflects the guarded atomic callback, including a failed final close.
    if (error instanceof ExactBatchPartialSyncError) committedAssetUals = error.committedAssetUals;
    const committedAssets = committedAssetUals.length;
    observeExactBatch(() => ports.logInfo(exactBatchFailureLine(error, {
      assetCount: assetUals.length, committedAssets, lastStage,
      cancelled: signal?.aborted === true || options.isCurrent?.() === false,
    })));
    return { complete: false, committedAssetUals, error };
  } finally {
    // Encoded native payload totals exclude Noise/TCP overhead. Success also
    // requires Core's final close to settle; observations grant no authority.
    observeExactBatch(() => ports.logInfo(
      `Exact batch requester transport assetCount=${assetUals.length} streamComplete=${streamComplete ? 1 : 0} committedAssets=${committedAssetUals.length} startSent=${startSent} nativeAcceptedSentBytes=${nativeAcceptedSentBytes} receivedPayloadBytes=${receivedPayloadBytes} sentAckFrames=${sentFrames[5]} receivedMetaFrames=${receivedFrames[2]} receivedDataFrames=${receivedFrames[3]} receivedAssetEndFrames=${receivedFrames[4]} receivedBatchEndFrames=${receivedFrames[6]} streamReadyMs=${streamReadyMs.toFixed(3)} exchangeElapsedMs=${Date.now() - exchangeStartedAtMs}`));
  }
}

/**
 * Own the optional exact stream inside the caller's existing admission. The
 * typed ordinary outcomes are possible only before the first START; a settled
 * stream always retains its applied prefix and never replays the enlarged
 * selection over the ordinary wire.
 *
 * A stream that broke is opened once more with the same peer, for the assets
 * it had not applied yet: a break says nothing about the peer's data, and
 * leaving it sends every one of those assets to the peers that cannot stream.
 * Nothing else is retried. A refusal, a rejected or unstorable asset and a
 * cancellation settle as they did.
 */
export async function runExactBatchStreamDriver(
  options: ExactBatchStreamDriverOptions,
  ports: ExactBatchStreamDriverPorts,
): Promise<ExactBatchStreamDriverOutcome> {
  const { remotePeerId, signal, transportMode } = options;
  if (transportMode === 'legacy') return { kind: 'not-selected' };
  const selected = exactAssetUalsForSelection(options.selection);
  const accumulator = createDurableSyncAccumulator();
  const committed: string[] = [];
  const incomplete = (): ExactBatchStreamDriverOutcome => {
    recordDurableSyncDiagnostics(accumulator, { failedPhases: 1 });
    markDurableTerminalBoundary(accumulator, false);
    return { kind: 'settled', detailed: {
      result: finalizeDurableSyncCompletion(accumulator), exactFetchDisposition: 'incomplete',
      committedExactAssetUals: Object.freeze([...committed]),
    } };
  };

  for (let retries = 0; ; retries += 1) {
    const resourceRefusalScope = options.streamEnabled ? ports.captureRefusalScope() : null;
    const connectionKey = options.streamEnabled ? ports.captureConnectionKey() : null;
    if (!options.streamEnabled || !ports.isChainEnabled()
      || exactBatchStreamUnsupported(ports.capabilityOwner, remotePeerId, connectionKey, Date.now(), resourceRefusalScope)
      || !(await ports.getPeerProtocols()).includes(EXACT_BATCH_STREAM_PROTOCOL)
      || !await ports.isRegisteredPublic()) {
      // After a break the first exchange has run: its applied prefix stands.
      if (retries > 0) return incomplete();
      // Required stream sizing must never widen an ordinary paging request.
      return transportMode === 'stream-required' ? unavailableStream() : { kind: 'not-selected' };
    }

    const exchange = await exchangeExactBatchOnce(options, ports, selected.slice(committed.length), accumulator);
    committed.push(...exchange.committedAssetUals);
    if (exchange.complete) {
      markDurableTerminalBoundary(accumulator, true, { countCompletedPhase: true });
      return { kind: 'settled', detailed: {
        result: finalizeDurableSyncCompletion(accumulator), exactFetchDisposition: 'found',
        committedExactAssetUals: Object.freeze([...committed]),
      } };
    }
    const { error } = exchange;

    if (error instanceof ExactBatchPartialSyncError && error.refusalObservation !== undefined) {
      const observed = error.refusalObservation;
      if (observed.code === 'RESOURCE_LIMIT' && !signal?.aborted && options.isCurrent?.() !== false) {
        rememberExactBatchStreamResourceRefusal(ports.capabilityOwner, remotePeerId, connectionKey,
          ports.captureConnectionKey(), resourceRefusalScope, ports.captureRefusalScope(), Date.now());
      }
      observeExactBatch(() => ports.logInfo(
        `Exact batch requester refusal code=${observed.code} startedAssets=${observed.startedAssets} committedAssets=${observed.committedAssets} acknowledgedAssets=${observed.acknowledgedAssets} atAssetBoundary=${observed.atAssetBoundary ? 1 : 0} verifiedPrefix=${observed.verifiedPrefix ? 1 : 0}`));
    }
    if (isUnsupportedBeforeStart(error)) {
      rememberExactBatchStreamUnsupported(ports.capabilityOwner, remotePeerId, connectionKey, ports.captureConnectionKey(), Date.now());
      // Only while no START of this call has been sent may the ordinary wire take over.
      if (retries === 0 && transportMode !== 'stream-required') return { kind: 'unsupported-before-start' };
    }

    const outstandingAssets = selected.length - committed.length;
    if (retries >= EXACT_BATCH_STREAM_RETRY.maxRetries
      || !(error instanceof ExactBatchPartialSyncError) || !error.streamInterrupted
      || outstandingAssets < 1
      || signal?.aborted || options.isCurrent?.() === false) return incomplete();
    const reconnectStartedAtMs = Date.now();
    if (!await reconnectForRetry(options, ports)) return incomplete();
    observeExactBatch(() => ports.logInfo(
      `Exact batch requester retry reason=stream-interrupted committedAssets=${committed.length} outstandingAssets=${outstandingAssets} reconnectMs=${Date.now() - reconnectStartedAtMs}`));
  }
}
