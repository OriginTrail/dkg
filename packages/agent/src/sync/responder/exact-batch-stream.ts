// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, compareCodePoint, createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import { readConfirmedGraphKnowledgeAssetMetadataEnvelope } from '@origintrail-official/dkg-publisher';
import { StoreResponseTooLargeError, type TripleStore } from '@origintrail-official/dkg-storage';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SyncRequestEnvelope } from '../auth/request-build.js';
import { requireExactAssetUals } from '../exact-assets.js';
import { observeExactBatch } from '../exact-batch-observation.js';
import {
  EXACT_BATCH_BATCH_INDEX, EXACT_BATCH_FRAME_KIND as K, EXACT_BATCH_MAX_FRAME_BYTES,
  EXACT_BATCH_STREAM_WINDOW_SIZE, ExactBatchSendWindow, type ExactBatchFrame,
} from '../exact-batch-stream-contract.js';
import type { ExactBatchAgentSession } from '../requester/exact-batch-stream.js';
import type { ExactAssetExportCache, ExactAssetExportStage } from './exact-asset-export-cache.js';
import type { ExperimentalExactBatchResponderResources } from './sync-handler.js';
import { serializeResponderRows } from './graph-plan.js';

const ENCODER = new TextEncoder();
const MAX_META_ROWS = 128;
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
  readonly onStage?: (stage: 'metadata' | 'export' | 'encode' | 'send' | 'source-fence' | 'ack-wait' | ExactAssetExportStage, assetIndex: number, durationMs: number, context: OperationContext) => void;
  /** Successful cache lease export count, never a peer/body authority claim. */
  readonly onExport?: (assetIndex: number, wholePayloadExports: 0 | 1, context: OperationContext) => void;
  readonly onPayload?: (assetIndex: number, plainBytes: number, encodedBytes: number, context: OperationContext) => void;
}
type Authorized = { readonly request: SyncRequestEnvelope; readonly assetUals: readonly string[]; readonly context: OperationContext };
class ProfileRefusal extends Error {}

/** Bind directly to Core's explicit registerExperimentalExactBatchResponder. */
export function createExactBatchResponderBinding(options: ExactBatchResponderBindingOptions) {
  // The bytes object passed to authorize and respond is owned by one Core
  // session. Preserve the parsed authorized scope; never authorize twice or
  // replay a single-use private nonce during response generation.
  const requests = new WeakMap<Uint8Array, Authorized>();
  const authorizeRequest = async (bytes: Uint8Array, peerId: string, signal: AbortSignal): Promise<readonly string[]> => {
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
    if (options.servingWithheld?.(request.contextGraphId)) throw new Error('Exact batch graph serving withheld');
    return options.admission.withPreAuthorizationAdmission(peerId, signal, async () => {
    if (!(await options.authorizeSyncRequest(request, peerId, { signal }))) throw new Error('Exact batch START authorization denied');
    signal.throwIfAborted();
    if (!(await options.isPublicContextGraph(request.contextGraphId, signal))) throw new Error('Exact batch requires public context graph authority');
    signal.throwIfAborted();
    const assetUals = Object.freeze(selected);
    requests.set(bytes, { request: Object.freeze({ ...request, assetUals: [...assetUals] }), assetUals, context: createOperationContext('sync') });
    return assetUals;
    });
  };

  const respond = async (bytes: Uint8Array, session: ExactBatchAgentSession, _peerId: string): Promise<void> => {
    const authorized = requests.get(bytes); requests.delete(bytes);
    if (!authorized || session.windowSize !== EXACT_BATCH_STREAM_WINDOW_SIZE
      || JSON.stringify(session.assetUals) !== JSON.stringify(authorized.assetUals)) throw new Error('Exact batch response scope was not authorized');
    const { request, assetUals, context } = authorized;
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
        if (options.servingWithheld?.(request.contextGraphId)) throw new Error('Exact batch graph serving withheld');
        while (!window.canStartAsset) await readAck();
        // A long batch must stop before the next KA if normal CG authority
        // becomes private. This never enters the private/member join lane.
        if (!(await options.isPublicContextGraph(request.contextGraphId, session.signal))) throw new Error('Exact batch public context graph authority changed');
        let started = performance.now();
        const metadata = await readMetadata(options.store, request.contextGraphId, assetUal, session.signal);
        observeExactBatch(() => options.onStage?.('metadata', assetIndex, performance.now() - started, context));
        started = performance.now();
        const lease = await options.exportCache.acquireEncoded({ contextGraphId: request.contextGraphId, assetUal,
          graph: metadata.graph, expectedRows: metadata.rows, expectedIdentity: metadata.identity, signal: session.signal,
          onStage: (stage, durationMs) => options.onStage?.(stage, assetIndex, durationMs, context) });
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
          await send({ kind: K.META, assetIndex, sequence: 0, payload: metadata.bytes });
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
      // Only explicit bounded/capability refusal gets the closed resource
      // response. Integrity, authorization and source-change errors abort.
      if (error instanceof ProfileRefusal && !session.signal.aborted) {
        await send({ kind: K.REFUSE, assetIndex: EXACT_BATCH_BATCH_INDEX, sequence: 0, payload: ENCODER.encode('RESOURCE_LIMIT') });
        return;
      }
      throw error;
    } finally { window.close(); }
    });
  };
  return { authorizeRequest, respond };
}

async function readMetadata(store: TripleStore, contextGraphId: string, assetUal: string, signal: AbortSignal) {
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  let result;
  try {
    result = await store.query(`SELECT ?predicate ?object WHERE { GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(assetUal)}> ?predicate ?object } } LIMIT ${MAX_META_ROWS + 1}`,
      { source: 'sync.responder.exactBatch.metadata', priority: 'background', signal, maxResponseBytes: EXACT_BATCH_MAX_FRAME_BYTES });
  } catch (error) { if (error instanceof StoreResponseTooLargeError) throw new ProfileRefusal('Exact batch metadata profile refused'); throw error; }
  signal.throwIfAborted();
  if (result.type !== 'bindings' || result.bindings.length === 0) throw new Error('Exact batch asset metadata missing');
  if (result.bindings.length > MAX_META_ROWS) throw new ProfileRefusal('Exact batch metadata rows refused');
  if (result.bindings.some(row => typeof row.predicate !== 'string' || typeof row.object !== 'string')) throw new Error('Exact batch metadata malformed');
  const reader = new Proxy(store, { get(target, key, receiver) { return key === 'query' ? async () => result : Reflect.get(target, key, receiver); } });
  const parsed = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(reader, { contextGraphId, ual: assetUal });
  if (parsed.state !== 'confirmed' || parsed.envelope.privateTripleCount !== 0 || parsed.envelope.publicTripleCount < 1) throw new Error('Exact batch metadata is not a public confirmed body');
  // Same immutable metadata identity used by the existing export cache. Passing
  // it into acquire binds this header to the body before any bytes are served.
  const identity = bytesToHex(sha256(ENCODER.encode(JSON.stringify(result.bindings.map(row => [row.predicate!, row.object!])
    .sort((a, b) => compareCodePoint(a[0]!, b[0]!) || compareCodePoint(a[1]!, b[1]!))))));
  const bytes = ENCODER.encode(serializeResponderRows(result.bindings.map(row => ({ s: assetUal, p: row.predicate!, o: row.object!, g: metaGraph }))));
  if (bytes.byteLength > EXACT_BATCH_MAX_FRAME_BYTES) throw new ProfileRefusal('Exact batch metadata frame refused');
  return { graph: parsed.envelope.assertionGraph, rows: parsed.envelope.publicTripleCount, identity, bytes };
}
