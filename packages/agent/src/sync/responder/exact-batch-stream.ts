// SPDX-License-Identifier: Apache-2.0
import { createOperationContext, ExactBatchResponderRefusal, type ExactBatchResponderAuthorization, type ExactBatchTransportOptions, type OperationContext } from '@origintrail-official/dkg-core';
import { isStoreOperationTimeoutError, isStoreSchedulerBusyError, type TripleStore } from '@origintrail-official/dkg-storage';
import type { SyncRequestEnvelope } from '../auth/request-build.js';
import { requireExactAssetUals } from '../exact-assets.js';
import { observeExactBatch } from '../exact-batch-observation.js';
import { exactBatchTransportOptions } from '../exact-batch-transport-options.js';
import {
  EXACT_BATCH_BATCH_INDEX, EXACT_BATCH_FRAME_KIND as K, EXACT_BATCH_MAX_FRAME_BYTES,
  EXACT_BATCH_STREAM_WINDOW_SIZE, ExactBatchSendWindow, type ExactBatchFrame,
} from '../exact-batch-stream-contract.js';
import type { ExactBatchAgentSession } from '../requester/exact-batch-stream.js';
import { ExactBatchAssetMissingError, type ExactAssetExportCache, type ExactAssetExportFallbackReason,
  type ExactAssetExportStage } from './exact-asset-export-cache.js';
import type { SyncRowSnapshotBudgetError } from './snapshot-budget.js';
import type { ExperimentalExactBatchResponderResources } from './sync-handler.js';

const EMPTY = new Uint8Array(0);
export interface ExactBatchResponderBindingOptions {
  readonly localPeerId: string;
  readonly store: TripleStore;
  /** Shared existing responder budget/cache, not a second unaccounted cache. */
  readonly exportCache: ExactAssetExportCache;
  readonly admission: Pick<ExperimentalExactBatchResponderResources, 'withPreAuthorizationAdmission' | 'withAuthorizedResponseAdmission'>;
  readonly parseSyncRequest: (bytes: Uint8Array) => SyncRequestEnvelope;
  readonly authorizeSyncRequest: (request: SyncRequestEnvelope, peerId: string, options: { signal?: AbortSignal }) => Promise<boolean>;
  /** Positive normal CG policy read: the experimental pilot serves public CGs only. */
  readonly isPublicContextGraph: (contextGraphId: string, signal: AbortSignal) => Promise<boolean>;
  readonly servingWithheld?: (contextGraphId: string) => boolean;
  /** Closed, request-free reason for a pre-export refusal. */
  readonly onRefusal?: (stage: 'authorization' | 'public-authority' | 'serving' | 'export', code: 'BUSY' | 'DENIED' | 'ASSET_MISSING') => void;
  readonly onStage?: (stage: 'metadata' | 'export' | 'encode' | 'send' | 'source-fence' | 'ack-wait' | ExactAssetExportStage, assetIndex: number, durationMs: number, context: OperationContext) => void;
  /** Successful cache lease export count, never a peer/body authority claim. */
  readonly onExport?: (assetIndex: number, wholePayloadExports: 0 | 1, context: OperationContext) => void;
  readonly onPayload?: (assetIndex: number, plainBytes: number, encodedBytes: number, context: OperationContext) => void;
  /** Local closed reason bound to the request's operation and canonical asset index. */
  readonly onFallback?: (reason: ExactAssetExportFallbackReason, assetIndex: number, context: OperationContext, budgetReason?: SyncRowSnapshotBudgetError['reason']) => unknown;
}
type Authorized = { readonly request: SyncRequestEnvelope; readonly assetUals: readonly string[]; readonly context: OperationContext };
class AuthorizedExactBatchContext {
  private consumed = false;
  constructor(private readonly owner: object, private readonly peerId: string, private readonly scope: Authorized) {}

  claim(owner: object, peerId: string, session: ExactBatchAgentSession): Authorized {
    if (owner !== this.owner || this.consumed) throw new Error('Exact batch response scope was not authorized');
    this.consumed = true;
    if (peerId !== this.peerId || session.windowSize !== EXACT_BATCH_STREAM_WINDOW_SIZE
      || JSON.stringify(session.assetUals) !== JSON.stringify(this.scope.assetUals)) {
      throw new Error('Exact batch response scope was not authorized');
    }
    session.signal.throwIfAborted();
    return this.scope;
  }
}
class ProfileRefusal extends Error {}

/** Responder-only diagnostics contain no request bytes, graph identifiers or raw errors. */
export function exactBatchResponderTransportOptions(timeoutMs: number,
  log: (level: 'info' | 'warn', message: string) => void): ExactBatchTransportOptions {
  return { ...exactBatchTransportOptions(timeoutMs),
    onInboundOpen: peer => log('info', `Exact batch inbound opened peer=${peer}`),
    onInboundFailure: ({ peerIdSuffix, stage, errorName, errorCode, signalAborted }) =>
      log('warn', `Exact batch inbound failed peer=${peerIdSuffix} stage=${stage} error=${errorName}${errorCode ? ` code=${errorCode}` : ''} aborted=${signalAborted}`) };
}

/** Bind directly to Core's explicit registerExperimentalExactBatchResponder. */
export function createExactBatchResponderBinding(options: ExactBatchResponderBindingOptions) {
  const authorizationOwner = {};
  const noteRefusal = (stage: 'authorization' | 'public-authority' | 'serving' | 'export', code: 'BUSY' | 'DENIED' | 'ASSET_MISSING'): void => {
    observeExactBatch(() => options.onRefusal?.(stage, code));
  };
  const refuse = (stage: 'authorization' | 'public-authority' | 'serving' | 'export', code: 'BUSY' | 'DENIED' | 'ASSET_MISSING'): never => {
    noteRefusal(stage, code);
    throw new ExactBatchResponderRefusal(code);
  };
  const requirePublicAuthority = async (contextGraphId: string, signal: AbortSignal): Promise<void> => {
    try {
      if (await options.isPublicContextGraph(contextGraphId, signal)) return;
    } catch (error) {
      if (isStoreSchedulerBusyError(error) || isStoreOperationTimeoutError(error)) refuse('public-authority', 'BUSY');
      if (error instanceof ExactBatchResponderRefusal) {
        if (error.refusal === 'BUSY') refuse('public-authority', 'BUSY');
        if (error.refusal === 'DENIED') refuse('public-authority', 'DENIED');
      }
      throw error;
    }
    refuse('public-authority', 'DENIED');
  };
  const authorizeRequest = async (bytes: Uint8Array, peerId: string, signal: AbortSignal): Promise<ExactBatchResponderAuthorization<AuthorizedExactBatchContext>> => {
    signal.throwIfAborted();
    if (bytes.byteLength < 1 || bytes.byteLength > 8192) throw new Error('Exact batch START request allowance exceeded');
    const request = options.parseSyncRequest(bytes);
    const selected = requireExactAssetUals(request.assetUals);
    if (selected.length !== request.assetUals?.length || request.includeSharedMemory || request.phase !== 'data'
      || request.offset !== 0 || request.sinceBatchId !== undefined || request.snapshotRef !== undefined || request.recovery) throw new Error('Exact batch START is outside the public exact profile');
    // Public CG reads use the unchanged unsigned pipe form on ordinary Edges.
    // Optional signed-envelope claims must still match the physical peers;
    // the normal authorizer owns signature/private-ACL semantics below.
    if ((request.targetPeerId !== undefined && request.targetPeerId !== options.localPeerId)
      || (request.requesterPeerId !== undefined && request.requesterPeerId !== peerId)) throw new Error('Exact batch START peer claims do not match the session');
    if (options.servingWithheld?.(request.contextGraphId)) refuse('serving', 'BUSY');
    return options.admission.withPreAuthorizationAdmission(peerId, signal, async () => {
    let authorized: boolean;
    try {
      authorized = await options.authorizeSyncRequest(request, peerId, { signal });
    } catch (error) {
      if (isStoreSchedulerBusyError(error) || isStoreOperationTimeoutError(error)) refuse('authorization', 'BUSY');
      throw error;
    }
    if (!authorized) refuse('authorization', 'DENIED');
    signal.throwIfAborted();
    await requirePublicAuthority(request.contextGraphId, signal);
    signal.throwIfAborted();
    const assetUals = Object.freeze(selected);
    return Object.freeze({ assetUals, context: new AuthorizedExactBatchContext(authorizationOwner, peerId, {
      request: Object.freeze({ ...request, assetUals: [...assetUals] }), assetUals, context: createOperationContext('sync'),
    }) });
    });
  };

  const respond = async (authorized: AuthorizedExactBatchContext, session: ExactBatchAgentSession, _peerId: string): Promise<void> => {
    const { request, assetUals, context } = authorized.claim(authorizationOwner, _peerId, session);
    return options.admission.withAuthorizedResponseAdmission(_peerId, request.contextGraphId, session.signal, async () => {
    const window = new ExactBatchSendWindow({ assetCount: assetUals.length, windowSize: EXACT_BATCH_STREAM_WINDOW_SIZE });
    const send = async (frame: ExactBatchFrame) => { window.acceptSent(frame); await session.send(frame); };
    const readAck = async () => {
      const started = performance.now(); const acknowledged = await session.next();
      if (!acknowledged) throw new Error('Exact batch closed before commit ACK');
      window.acceptAck(acknowledged);
      observeExactBatch(() => options.onStage?.('ack-wait', acknowledged.assetIndex, performance.now() - started, context));
    };
    try {
      for (const [assetIndex, assetUal] of assetUals.entries()) {
        session.signal.throwIfAborted();
        if (options.servingWithheld?.(request.contextGraphId)) refuse('serving', 'BUSY');
        while (!window.canStartAsset) await readAck();
        // A long batch must stop before the next KA if normal CG authority
        // becomes private. This never enters the private/member join lane.
        await requirePublicAuthority(request.contextGraphId, session.signal);
        let started = performance.now();
        const lease = await options.exportCache.acquireEncoded({ contextGraphId: request.contextGraphId, assetUal,
          signal: session.signal,
          authorizeMissingAccessPolicy: () => options.isPublicContextGraph(request.contextGraphId, session.signal),
          onStage: (stage, durationMs) => options.onStage?.(stage, assetIndex, durationMs, context),
          onFallback: (reason, budgetReason) => observeExactBatch(() => options.onFallback?.(reason, assetIndex, context, budgetReason)) });
        observeExactBatch(() => options.onStage?.('export', assetIndex,
          Math.max(0, performance.now() - started - (lease?.encodingDurationMs ?? 0)), context));
        if (!lease) throw new ProfileRefusal('Exact batch exporter profile refused');
        try {
          // Bounded observation cannot affect exporter ownership or response.
          if (lease.wholePayloadExports !== undefined) {
            observeExactBatch(() => options.onExport?.(assetIndex, lease.wholePayloadExports!, context));
          }
          // A lease owns the unchanged bounded gzip/plain representation. A
          // warm lease reuses only verified bytes, never cached read authority.
          const { body, plainBytes } = lease;
          observeExactBatch(() => options.onStage?.('encode', assetIndex, lease.encodingDurationMs, context));
          observeExactBatch(() => options.onPayload?.(assetIndex, plainBytes, body.byteLength, context));
          started = performance.now();
          await send({ kind: K.META, assetIndex, sequence: 0, payload: lease.metadata });
          let sequence = 0;
          for (let offset = 0; offset < body.byteLength; offset += EXACT_BATCH_MAX_FRAME_BYTES) {
            await send({ kind: K.DATA, assetIndex, sequence: sequence++, payload: body.subarray(offset, offset + EXACT_BATCH_MAX_FRAME_BYTES) });
          }
          observeExactBatch(() => options.onStage?.('send', assetIndex, performance.now() - started, context));
          started = performance.now();
          // A warm revisionless lease is an earlier independently verified
          // immutable assertion, not proof that present physical DATA remains
          // unchanged. Fresh metadata/public profile and available revisions
          // fence every serve. Receiver chain authentication remains required.
          await lease.assertCurrent();
          session.signal.throwIfAborted();
          observeExactBatch(() => options.onStage?.('source-fence', assetIndex, performance.now() - started, context));
          await send({ kind: K.ASSET_END, assetIndex, sequence, payload: EMPTY });
        } finally { lease.release(); }
      }
      await send({ kind: K.BATCH_END, assetIndex: EXACT_BATCH_BATCH_INDEX, sequence: assetUals.length, payload: EMPTY });
      while (window.acknowledgedCount < assetUals.length) await readAck();
      if (!window.complete) throw new Error('Exact batch responder did not reach commit completion');
    } catch (error) {
      // Core serializes all closed refusals on the same stream, including a
      // late refusal after DATA. Integrity and source-change errors abort.
      if (error instanceof ProfileRefusal && !session.signal.aborted) {
        throw new ExactBatchResponderRefusal('RESOURCE_LIMIT');
      }
      if (!session.signal.aborted && error instanceof ExactBatchAssetMissingError) {
        refuse('export', 'ASSET_MISSING');
      }
      if (!session.signal.aborted && (isStoreSchedulerBusyError(error) || isStoreOperationTimeoutError(error))) {
        refuse('export', 'BUSY');
      }
      throw error;
    } finally { window.close(); }
    });
  };
  return { authorizeRequest, respond };
}
