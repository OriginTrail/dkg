// SPDX-License-Identifier: Apache-2.0
import {
  exchangeExperimentalExactBatch, ExperimentalExactBatchUnsupportedError,
  type ExactBatchTransportEvent, type ProtocolRouter,
} from '@origintrail-official/dkg-core';
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
  readonly requesterPeerId: string;
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
    'computeSyncDigest' | 'getIdentityId' | 'signMessage'>;
  readonly verification: Omit<ExactBatchVerifiedReceiverOptions,
    'contextGraphId' | 'assetUals' | 'onStage' | 'onCommitted'>;
  readonly logInfo: (message: string) => void;
}

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

/**
 * Own one optional exact stream attempt inside the caller's existing admission.
 * The typed ordinary outcomes are possible only before START; a settled stream
 * always retains its applied prefix and never replays the enlarged selection.
 */
export async function runExactBatchStreamDriver(
  options: ExactBatchStreamDriverOptions,
  ports: ExactBatchStreamDriverPorts,
): Promise<ExactBatchStreamDriverOutcome> {
  const { contextGraphId, remotePeerId, signal, transportMode } = options;
  if (transportMode === 'legacy') return { kind: 'not-selected' };
  const resourceRefusalScope = options.streamEnabled ? ports.captureRefusalScope() : null;
  const connectionKey = options.streamEnabled ? ports.captureConnectionKey() : null;
  if (!options.streamEnabled || !ports.isChainEnabled()
    || exactBatchStreamUnsupported(ports.capabilityOwner, remotePeerId, connectionKey, Date.now(), resourceRefusalScope)
    || !(await ports.getPeerProtocols()).includes(EXACT_BATCH_STREAM_PROTOCOL)
    || !await ports.isRegisteredPublic()) {
    // Required stream sizing must never widen an ordinary paging request.
    return transportMode === 'stream-required' ? unavailableStream() : { kind: 'not-selected' };
  }

  const accumulator = createDurableSyncAccumulator();
  const committedExactAssetUals: string[] = [];
  const selected = exactAssetUalsForSelection(options.selection);
  // Registered public authority permits the unchanged public START without
  // requiring an identity/signature from a requester that has not joined yet.
  const start = await buildSyncRequestEnvelope({
    contextGraphId, offset: 0, limit: SYNC_PAGE_SIZE, includeSharedMemory: false,
    targetPeerId: remotePeerId, requesterPeerId: options.requesterPeerId, phase: 'data',
    assetUals: selected, needsAuth: false, ...ports.requestIdentity(),
  });
  const remainingMs = Math.floor(options.fetchDeadline - Date.now());
  const exchangeStartedAtMs = Date.now();
  let streamComplete = false, streamReadyMs = -1, startSent = 0, nativeAcceptedSentBytes = 0, receivedPayloadBytes = 0;
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
          `Exact batch requester start assetCount=${selected.length} requestEncodedBytes=${start.byteLength} sentAtMs=${Date.now()}`));
      }
    }
  };
  try {
    if (remainingMs < 1) throw new Error('Exact batch recovery fetch deadline expired');
    await exchangeExactBatchVerified(consume => exchangeExperimentalExactBatch(ports.router, remotePeerId,
      exactBatchStartFrame(start),
      { ...exactBatchTransportOptions(Math.min(120_000, remainingMs), signal), assetUals: selected, onTransportEvent }, consume), {
      ...ports.verification, contextGraphId, assetUals: selected,
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
      onStage: (stage, assetIndex, durationMs) => ports.logInfo(
        `Exact batch requester stage=${stage} asset=${assetIndex} durationMs=${durationMs.toFixed(3)}`),
      onCommitted: ual => {
        committedExactAssetUals.push(ual);
        observeExactBatch(() => ports.logInfo(
          `Exact batch committed asset=${committedExactAssetUals.length - 1} committedAssets=${committedExactAssetUals.length}`));
      },
    });
    streamComplete = true;
    markDurableTerminalBoundary(accumulator, true, { countCompletedPhase: true });
    return { kind: 'settled', detailed: {
      result: finalizeDurableSyncCompletion(accumulator), exactFetchDisposition: 'found',
      committedExactAssetUals: Object.freeze([...committedExactAssetUals]),
    } };
  } catch (error) {
    // Core settles physical stream/decoder cleanup before rejection. Progress
    // reflects the guarded atomic callback, including a failed final close.
    if (error instanceof ExactBatchPartialSyncError && error.refusalObservation !== undefined) {
      const observed = error.refusalObservation;
      if (observed.code === 'RESOURCE_LIMIT' && !signal?.aborted && options.isCurrent?.() !== false) {
        rememberExactBatchStreamResourceRefusal(ports.capabilityOwner, remotePeerId, connectionKey,
          ports.captureConnectionKey(), resourceRefusalScope, ports.captureRefusalScope(), Date.now());
      }
      observeExactBatch(() => ports.logInfo(
        `Exact batch requester refusal code=${observed.code} startedAssets=${observed.startedAssets} committedAssets=${observed.committedAssets} acknowledgedAssets=${observed.acknowledgedAssets} atAssetBoundary=${observed.atAssetBoundary ? 1 : 0} verifiedPrefix=${observed.verifiedPrefix ? 1 : 0}`));
    }
    const outerCause = error instanceof Error ? error.cause : undefined;
    if (error instanceof ExperimentalExactBatchUnsupportedError || outerCause instanceof ExperimentalExactBatchUnsupportedError) {
      rememberExactBatchStreamUnsupported(ports.capabilityOwner, remotePeerId, connectionKey, ports.captureConnectionKey(), Date.now());
      if (transportMode !== 'stream-required') return { kind: 'unsupported-before-start' };
    }
    recordDurableSyncDiagnostics(accumulator, { failedPhases: 1 });
    markDurableTerminalBoundary(accumulator, false);
    return { kind: 'settled', detailed: {
      result: finalizeDurableSyncCompletion(accumulator), exactFetchDisposition: 'incomplete',
      committedExactAssetUals: Object.freeze([...committedExactAssetUals]),
    } };
  } finally {
    // Encoded native payload totals exclude Noise/TCP overhead. Success also
    // requires Core's final close to settle; observations grant no authority.
    observeExactBatch(() => ports.logInfo(
      `Exact batch requester transport assetCount=${selected.length} streamComplete=${streamComplete ? 1 : 0} committedAssets=${committedExactAssetUals.length} startSent=${startSent} nativeAcceptedSentBytes=${nativeAcceptedSentBytes} receivedPayloadBytes=${receivedPayloadBytes} sentAckFrames=${sentFrames[5]} receivedMetaFrames=${receivedFrames[2]} receivedDataFrames=${receivedFrames[3]} receivedAssetEndFrames=${receivedFrames[4]} receivedBatchEndFrames=${receivedFrames[6]} streamReadyMs=${streamReadyMs.toFixed(3)} exchangeElapsedMs=${Date.now() - exchangeStartedAtMs}`));
  }
}
