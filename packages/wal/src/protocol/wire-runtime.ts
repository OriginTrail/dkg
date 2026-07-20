import { protocolTupleId } from './hashes.js';
import type { CborProtocolValue, ProtocolTuple } from './schema.js';
import {
  wireBytesEqual,
  compareWireBytes,
  decodeWalRequestFrame,
  decodeWalResponseFrame,
  encodeWalErrorFrame,
  encodeWalRequestFrame,
  encodeWalResponseFrame,
  validateWalRequestBody,
  validateWalResponseBody,
} from './wire-codec.js';
import { WalWireError, asWalWireError } from './wire-error.js';
import { WalReplayCache } from './wire-replay.js';
import { WalProviderRequestStateMachine } from './wire-state.js';
import {
  WAL_WIRE_DETAIL_CODE,
  WAL_WIRE_ERROR_CODE,
  WAL_WIRE_LIMITS_V1,
  WAL_WIRE_PROTOCOL_IDS,
  walWireMethod,
  type NegotiatedWalCapabilitiesV1,
  type WalAuthorizedRequest,
  type WalRawProtocolRouter,
  type WalWireFamily,
  type WalWireLimitOverrides,
  type WalWireLimits,
  type WalWireMethodSpec,
  type WalWirePeerId,
  type WalWireProtocolService,
} from './wire-types.js';

const ZERO_REQUEST_ID: Uint8Array = new Uint8Array(16);

function requestKey(peerId: string, requestId: Uint8Array): string {
  return `${peerId}:${Array.from(requestId, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function positiveSafeInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  if (value <= 0) throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  if (value > maximum) throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  return value;
}

function resolveLimits(overrides: WalWireLimitOverrides = {}): WalWireLimits {
  const limits: WalWireLimits = { ...WAL_WIRE_LIMITS_V1, ...overrides };
  positiveSafeInteger('maximumFrameBytes', limits.maximumFrameBytes, WAL_WIRE_LIMITS_V1.maximumFrameBytes);
  if (limits.maximumFrameBytes < 128) throw new Error('maximumFrameBytes must leave room for a bounded error frame');
  positiveSafeInteger('maximumSymbolsPerResponse', limits.maximumSymbolsPerResponse, WAL_WIRE_LIMITS_V1.maximumSymbolsPerResponse);
  positiveSafeInteger('maximumFallbackIdsPerPage', limits.maximumFallbackIdsPerPage, WAL_WIRE_LIMITS_V1.maximumFallbackIdsPerPage);
  positiveSafeInteger('maximumObjectRangeBytes', limits.maximumObjectRangeBytes, WAL_WIRE_LIMITS_V1.maximumObjectRangeBytes);
  if (limits.maximumWalObjectBytes <= 0n || limits.maximumWalObjectBytes > WAL_WIRE_LIMITS_V1.maximumWalObjectBytes) {
    throw new Error('maximumWalObjectBytes is outside the version-1 range');
  }
  positiveSafeInteger('maximumConcurrentReconciliationStreamsPerPeer', limits.maximumConcurrentReconciliationStreamsPerPeer, WAL_WIRE_LIMITS_V1.maximumConcurrentReconciliationStreamsPerPeer);
  positiveSafeInteger('maximumConcurrentObjectStreamsPerNamespacePeer', limits.maximumConcurrentObjectStreamsPerNamespacePeer, WAL_WIRE_LIMITS_V1.maximumConcurrentObjectStreamsPerNamespacePeer);
  positiveSafeInteger('maximumOutstandingRequestsPerPeer', limits.maximumOutstandingRequestsPerPeer, WAL_WIRE_LIMITS_V1.maximumOutstandingRequestsPerPeer);
  positiveSafeInteger('maximumOutstandingRequestsGlobal', limits.maximumOutstandingRequestsGlobal, WAL_WIRE_LIMITS_V1.maximumOutstandingRequestsGlobal);
  positiveSafeInteger('maximumReplayEntriesPerPeer', limits.maximumReplayEntriesPerPeer, WAL_WIRE_LIMITS_V1.maximumReplayEntriesPerPeer);
  positiveSafeInteger('maximumReplayEntriesGlobal', limits.maximumReplayEntriesGlobal, WAL_WIRE_LIMITS_V1.maximumReplayEntriesGlobal);
  positiveSafeInteger('maximumQueuedRequestsPerKey', limits.maximumQueuedRequestsPerKey, WAL_WIRE_LIMITS_V1.maximumQueuedRequestsPerKey);
  positiveSafeInteger('requestFreshnessMs', limits.requestFreshnessMs, WAL_WIRE_LIMITS_V1.requestFreshnessMs);
  positiveSafeInteger('maximumClockSkewMs', limits.maximumClockSkewMs, WAL_WIRE_LIMITS_V1.maximumClockSkewMs);
  positiveSafeInteger('requestHandlerTimeoutMs', limits.requestHandlerTimeoutMs, WAL_WIRE_LIMITS_V1.requestHandlerTimeoutMs);
  positiveSafeInteger('inboundReadTimeoutMs', limits.inboundReadTimeoutMs, WAL_WIRE_LIMITS_V1.inboundReadTimeoutMs);
  positiveSafeInteger('maximumCborArrayLength', limits.maximumCborArrayLength, WAL_WIRE_LIMITS_V1.maximumCborArrayLength);
  positiveSafeInteger('maximumCborDepth', limits.maximumCborDepth, WAL_WIRE_LIMITS_V1.maximumCborDepth);
  return Object.freeze(limits);
}

interface QueueEntry {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

class KeyedScheduler {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, QueueEntry[]>();

  constructor(
    private readonly activeLimit: (key: string) => number,
    private readonly queueLimit: number,
  ) {}

  async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason;
    const active = this.active.get(key) ?? 0;
    if (active < this.activeLimit(key)) {
      this.active.set(key, active + 1);
      return this.releaseOnce(key);
    }
    const queue = this.queues.get(key) ?? [];
    if (queue.length >= this.queueLimit) {
      throw new WalWireError(WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT, 'request queue is saturated', WAL_WIRE_DETAIL_CODE.QUEUE_SATURATED);
    }
    let entry!: QueueEntry;
    const release = await new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const current = this.queues.get(key)!;
        current.splice(current.indexOf(entry), 1);
        if (current.length === 0) this.queues.delete(key);
        reject(signal.reason);
      };
      entry = { signal, resolve, reject, onAbort };
      queue.push(entry);
      this.queues.set(key, queue);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return release;
  }

  private releaseOnce(key: string): () => void {
    return () => {
      const queue = this.queues.get(key);
      while (queue && queue.length > 0) {
        const next = queue.shift()!;
        next.signal.removeEventListener('abort', next.onAbort);
        if (queue.length === 0) this.queues.delete(key);
        next.resolve(this.releaseOnce(key));
        return;
      }
      const active = this.active.get(key)! - 1;
      if (active === 0) this.active.delete(key);
      else this.active.set(key, active);
    };
  }
}

function uniformUnauthorized(message: string, requestId: Uint8Array): WalWireError {
  return new WalWireError(WAL_WIRE_ERROR_CODE.UNAUTHORIZED, message, null, null, requestId);
}

function numberFromU64(value: bigint, requestId: Uint8Array): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw uniformUnauthorized('request timestamp is outside the supported range', requestId);
  return Number(value);
}

function assertProofWindow(notBefore: bigint, expires: bigint, nowMs: number, skewMs: number, requestId: Uint8Array): void {
  const lower = numberFromU64(notBefore, requestId) - skewMs;
  const upper = numberFromU64(expires, requestId) + skewMs;
  if (expires < notBefore) throw uniformUnauthorized('request proof is not currently valid', requestId);
  if (nowMs < lower) throw uniformUnauthorized('request proof is not currently valid', requestId);
  if (nowMs > upper) throw uniformUnauthorized('request proof is not currently valid', requestId);
}

function validateContextBinding(
  context: ProtocolTuple<'RequestContextV1'>,
  requestId: Uint8Array,
  peerId: WalWirePeerId,
  localPeerId: Uint8Array,
  nowMs: number,
  limits: WalWireLimits,
): void {
  const [issuedAt, requesterPeerId, targetPeerId, , requesterAgent, identityProof, privateProof] = context;
  const issuedAtMs = numberFromU64(issuedAt, requestId);
  if (issuedAtMs < nowMs - limits.requestFreshnessMs) throw uniformUnauthorized('request is outside the freshness window', requestId);
  if (issuedAtMs > nowMs + limits.maximumClockSkewMs) throw uniformUnauthorized('request is outside the freshness window', requestId);
  if (!wireBytesEqual(requesterPeerId, peerId.toBytes())) throw uniformUnauthorized('request transport identity binding failed', requestId);
  if (!wireBytesEqual(targetPeerId, localPeerId)) throw uniformUnauthorized('request transport identity binding failed', requestId);
  if ((requesterAgent === null) !== (identityProof === null)) {
    throw uniformUnauthorized('request agent identity proof is incomplete', requestId);
  }
  if (identityProof !== null) {
    if (!wireBytesEqual(identityProof[0], requesterAgent!)) throw uniformUnauthorized('request identity proof binding failed', requestId);
    if (!wireBytesEqual(identityProof[1], requesterPeerId)) throw uniformUnauthorized('request identity proof binding failed', requestId);
    assertProofWindow(identityProof[2], identityProof[3], nowMs, limits.maximumClockSkewMs, requestId);
  }
  if (privateProof !== null) {
    if (requesterAgent === null) throw uniformUnauthorized('private view proof binding failed', requestId);
    if (!wireBytesEqual(privateProof[1], requesterAgent)) throw uniformUnauthorized('private view proof binding failed', requestId);
    if (!wireBytesEqual(privateProof[2], requesterPeerId)) throw uniformUnauthorized('private view proof binding failed', requestId);
    const delegation = privateProof[3];
    if (delegation !== null) {
      if (!wireBytesEqual(delegation[1], requesterAgent)) throw uniformUnauthorized('private delegation binding failed', requestId);
      if (!wireBytesEqual(delegation[2], requesterPeerId)) throw uniformUnauthorized('private delegation binding failed', requestId);
      assertProofWindow(delegation[3], delegation[4], nowMs, limits.maximumClockSkewMs, requestId);
    }
  }
}

function schedulerKey(family: WalWireFamily, peerId: string, namespaceId: Uint8Array): string {
  if (family !== 'object') return `${family}:${peerId}`;
  return `${family}:${peerId}:${Array.from(namespaceId, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function responseBindingError(requestId: Uint8Array, message: string, code: number = WAL_WIRE_ERROR_CODE.INVALID_PROOF): WalWireError {
  return new WalWireError(code, message, WAL_WIRE_DETAIL_CODE.RESPONSE_BINDING, null, requestId);
}

function validateCapabilities(body: ProtocolTuple<'CapabilitiesV1'>, requestId: Uint8Array, requireV1 = false): void {
  if (body[0].length === 0) throw responseBindingError(requestId, 'capabilities do not support a required protocol or adapter');
  if (body[1].length === 0) throw responseBindingError(requestId, 'capabilities do not support a required protocol or adapter');
  if (requireV1 && !body[0].includes(1n)) throw responseBindingError(requestId, 'capabilities do not support a required protocol or adapter');
  for (const value of body.slice(2) as readonly bigint[]) {
    if (value <= 0n) throw responseBindingError(requestId, 'capability limits must be positive');
  }
}

function validateBoundResponse(
  method: WalWireMethodSpec,
  context: ProtocolTuple<'RequestContextV1'>,
  requestBody: readonly CborProtocolValue[],
  responseBody: readonly CborProtocolValue[],
  limits: WalWireLimits,
  requestId: Uint8Array,
): void {
  validateWalResponseBody(method, responseBody, requestId);
  if (method.name === 'GET_CAPABILITIES') {
    validateCapabilities(responseBody as ProtocolTuple<'CapabilitiesV1'>, requestId, true);
  } else if (method.name === 'GET_HEAD') {
    const request = requestBody as ProtocolTuple<'GetHeadV1'>;
    const response = responseBody as ProtocolTuple<'AuthorCheckpointV1'>;
    if (!wireBytesEqual(response[1], context[3])) throw responseBindingError(requestId, 'head response is not bound to the requested namespace/writer epoch');
    if (!wireBytesEqual(response[2], request[0])) throw responseBindingError(requestId, 'head response is not bound to the requested namespace/writer epoch');
    if (request[1] !== null && response[3] !== request[1]) throw responseBindingError(requestId, 'head response is not bound to the requested namespace/writer epoch');
  } else if (method.name === 'GET_VECTOR') {
    if (!wireBytesEqual((responseBody as ProtocolTuple<'CollectionHeadVectorV1'>)[1], (requestBody as ProtocolTuple<'GetVectorV1'>)[0])) {
      throw responseBindingError(requestId, 'vector response is not bound to the requested collection');
    }
  } else if (method.name === 'GET_CHECKPOINT') {
    const id = protocolTupleId('AuthorCheckpointV1', responseBody as ProtocolTuple<'AuthorCheckpointV1'>);
    if (!wireBytesEqual(id, (requestBody as ProtocolTuple<'GetCheckpointV1'>)[0])) throw responseBindingError(requestId, 'checkpoint response has the wrong signed ID');
  } else if (method.name === 'GET_RECONCILIATION_SYMBOLS') {
    const request = requestBody as ProtocolTuple<'GetReconciliationSymbolsV1'>;
    const response = responseBody as ProtocolTuple<'ReconciliationSymbolsV1'>;
    if (!wireBytesEqual(response[0], request[0])) throw responseBindingError(requestId, 'symbol response is not bound to the requested head/seed/window');
    if (!wireBytesEqual(response[1], request[1])) throw responseBindingError(requestId, 'symbol response is not bound to the requested head/seed/window');
    if (response[2] !== request[2]) throw responseBindingError(requestId, 'symbol response is not bound to the requested head/seed/window');
    if (response[3].length !== Number(request[3])) throw responseBindingError(requestId, 'symbol response is not bound to the requested head/seed/window');
    for (let index = 0; index < response[3].length; index += 1) {
      if (response[3][index][0] !== request[2] + BigInt(index)) throw responseBindingError(requestId, 'symbol response indices are not contiguous');
    }
  } else if (method.name === 'GET_OBJECT_IDS') {
    const request = requestBody as ProtocolTuple<'GetObjectIdsV1'>;
    const response = responseBody as ProtocolTuple<'ObjectIdsPageV1'>;
    if (!wireBytesEqual(response[0], request[0])) throw responseBindingError(requestId, 'ID page is not bound to the requested head/cursor/limit');
    if (!nullableBytesEqual(response[1], request[1])) throw responseBindingError(requestId, 'ID page is not bound to the requested head/cursor/limit');
    if (response[2].length > Number(request[2])) throw responseBindingError(requestId, 'ID page is not bound to the requested head/cursor/limit');
    if (request[1] !== null && response[2].some(id => compareWireBytes(id, request[1]!) <= 0)) throw responseBindingError(requestId, 'ID page did not advance beyond its cursor');
    if (response[4]) {
      if (response[3] !== null) throw responseBindingError(requestId, 'final ID page must have a null next cursor');
    } else if (response[2].length === 0 || !wireBytesEqual(response[3]!, response[2][response[2].length - 1])) {
      throw responseBindingError(requestId, 'nonfinal ID page must advance to its final ID');
    }
  } else if (method.name === 'GET_OBJECT_RANGE') {
    const request = requestBody as ProtocolTuple<'GetWalObjectRangeV1'>;
    const response = responseBody as ProtocolTuple<'WalObjectRangeV1'>;
    const length = BigInt(response[3].length);
    if (!wireBytesEqual(response[0], request[0])) throw responseBindingError(requestId, 'object range response violates its ID/length/offset bounds', WAL_WIRE_ERROR_CODE.INVALID_RANGE);
    if (response[2] !== request[1]) throw responseBindingError(requestId, 'object range response violates its ID/length/offset bounds', WAL_WIRE_ERROR_CODE.INVALID_RANGE);
    if (response[1] > limits.maximumWalObjectBytes) throw responseBindingError(requestId, 'object range response violates its ID/length/offset bounds', WAL_WIRE_ERROR_CODE.INVALID_RANGE);
    if (length > request[2]) throw responseBindingError(requestId, 'object range response violates its ID/length/offset bounds', WAL_WIRE_ERROR_CODE.INVALID_RANGE);
    if (response[2] > response[1]) throw responseBindingError(requestId, 'object range response violates its ID/length/offset bounds', WAL_WIRE_ERROR_CODE.INVALID_RANGE);
    if (response[2] + length > response[1]) throw responseBindingError(requestId, 'object range response violates its ID/length/offset bounds', WAL_WIRE_ERROR_CODE.INVALID_RANGE);
    if ((length === 0n) !== (response[2] === response[1])) throw responseBindingError(requestId, 'empty object range is only valid at EOF', WAL_WIRE_ERROR_CODE.INVALID_RANGE);
  }
}

function nullableBytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null ? right === null : right !== null && wireBytesEqual(left, right);
}

export interface WalWireProtocolServerOptions {
  readonly localPeerId: Uint8Array;
  readonly service: WalWireProtocolService;
  readonly authorize: (request: WalAuthorizedRequest) => boolean | Promise<boolean>;
  readonly limits?: WalWireLimitOverrides;
  readonly now?: () => number;
}

export class WalWireProtocolServer {
  readonly limits: WalWireLimits;
  private readonly replay: WalReplayCache;
  private readonly schedulers: Record<WalWireFamily, KeyedScheduler>;
  private readonly outstandingByPeer = new Map<string, number>();
  private outstandingGlobal = 0;
  private readonly operations = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly options: WalWireProtocolServerOptions) {
    if (!(options.localPeerId instanceof Uint8Array) || options.localPeerId.length === 0) throw new Error('localPeerId must be a non-empty byte string');
    this.limits = resolveLimits(options.limits);
    this.now = options.now ?? Date.now;
    this.replay = new WalReplayCache({
      maximumEntriesPerPeer: this.limits.maximumReplayEntriesPerPeer,
      maximumEntriesGlobal: this.limits.maximumReplayEntriesGlobal,
    });
    this.schedulers = {
      control: new KeyedScheduler(() => this.limits.maximumOutstandingRequestsPerPeer, this.limits.maximumQueuedRequestsPerKey),
      reconcile: new KeyedScheduler(() => this.limits.maximumConcurrentReconciliationStreamsPerPeer, this.limits.maximumQueuedRequestsPerKey),
      object: new KeyedScheduler(() => this.limits.maximumConcurrentObjectStreamsPerNamespacePeer, this.limits.maximumQueuedRequestsPerKey),
    };
  }

  register(router: WalRawProtocolRouter): () => void {
    for (const family of Object.keys(WAL_WIRE_PROTOCOL_IDS) as WalWireFamily[]) {
      router.register(
        WAL_WIRE_PROTOCOL_IDS[family],
        (data, peerId, handlerOptions) => this.handle(family, data, peerId, handlerOptions?.signal),
        { maxReadBytes: this.limits.maximumFrameBytes + 8, readTimeoutMs: this.limits.inboundReadTimeoutMs },
      );
    }
    return () => {
      for (const protocolId of Object.values(WAL_WIRE_PROTOCOL_IDS)) router.unregister(protocolId);
    };
  }

  async handle(family: WalWireFamily, bytes: Uint8Array, peerId: WalWirePeerId, transportSignal?: AbortSignal): Promise<Uint8Array> {
    let responseRequestId: Uint8Array = ZERO_REQUEST_ID;
    let providerState: WalProviderRequestStateMachine | undefined;
    let releaseOutstanding: (() => void) | undefined;
    try {
      const decoded = decodeWalRequestFrame(family, bytes, this.limits);
      responseRequestId = decoded.requestId;
      const peer = peerId.toString();
      const now = this.now();
      validateContextBinding(decoded.context, decoded.requestId, peerId, this.options.localPeerId, now, this.limits);
      this.replay.claim(peer, decoded.requestId, now + this.limits.requestFreshnessMs + this.limits.maximumClockSkewMs, now);
      if (decoded.method.name !== 'CANCEL') {
        releaseOutstanding = this.reserveOutstanding(peer, decoded.requestId);
      }
      const authorizedRequest: WalAuthorizedRequest = {
        family,
        method: decoded.method,
        requestId: decoded.requestId,
        context: decoded.context,
        transportPeerId: peerId,
      };
      let authorized = false;
      try {
        authorized = await this.options.authorize(authorizedRequest);
      } catch {
        authorized = false;
      }
      if (!authorized) throw uniformUnauthorized('request authorization denied', decoded.requestId);
      providerState = new WalProviderRequestStateMachine();
      providerState.transition('AUTHORIZE');
      validateWalRequestBody(decoded.method, decoded.body, this.limits, decoded.requestId);
      if (decoded.method.name === 'CANCEL') {
        const cancelledId = (decoded.body as ProtocolTuple<'CancelV1'>)[0];
        if (wireBytesEqual(cancelledId, decoded.requestId)) throw new WalWireError(WAL_WIRE_ERROR_CODE.NON_CANONICAL, 'CANCEL cannot target its own requestId', WAL_WIRE_DETAIL_CODE.BODY_SCHEMA, null, decoded.requestId);
        this.operations.get(requestKey(peer, cancelledId))?.abort(new WalWireError(WAL_WIRE_ERROR_CODE.CANCELLED, 'request cancelled'));
        providerState.transition('START');
        providerState.transition('RESPOND');
        return encodeWalResponseFrame(decoded.method, decoded.requestId, [], this.limits.maximumFrameBytes);
      }
      const operationController = new AbortController();
      const operationKey = requestKey(peer, decoded.requestId);
      this.operations.set(operationKey, operationController);
      const forwardTransportAbort = () => operationController.abort(new WalWireError(WAL_WIRE_ERROR_CODE.CANCELLED, 'transport request cancelled'));
      if (transportSignal?.aborted) forwardTransportAbort();
      else transportSignal?.addEventListener('abort', forwardTransportAbort, { once: true });
      const timeout = setTimeout(
        () => operationController.abort(new WalWireError(WAL_WIRE_ERROR_CODE.CANCELLED, 'request deadline exceeded', WAL_WIRE_DETAIL_CODE.TIMEOUT)),
        this.limits.requestHandlerTimeoutMs,
      );
      let releaseScheduler: (() => void) | undefined;
      try {
        const key = schedulerKey(family, peer, decoded.context[3]);
        const slotPromise = this.schedulers[family].acquire(key, operationController.signal);
        providerState.transition('QUEUE');
        releaseScheduler = await slotPromise;
        providerState.transition('START');
        let responseBody: readonly CborProtocolValue[];
        switch (decoded.method.name) {
          case 'GET_CAPABILITIES':
            responseBody = await this.options.service.getCapabilities(authorizedRequest, operationController.signal);
            break;
          case 'GET_HEAD':
            responseBody = await this.options.service.getHead(authorizedRequest, decoded.body as ProtocolTuple<'GetHeadV1'>, operationController.signal);
            break;
          case 'GET_VECTOR':
            responseBody = await this.options.service.getVector(authorizedRequest, decoded.body as ProtocolTuple<'GetVectorV1'>, operationController.signal);
            break;
          case 'GET_CHECKPOINT':
            responseBody = await this.options.service.getCheckpoint(authorizedRequest, decoded.body as ProtocolTuple<'GetCheckpointV1'>, operationController.signal);
            break;
          case 'ANNOUNCE_HEAD':
            await this.options.service.announceHead(authorizedRequest, decoded.body as ProtocolTuple<'AnnounceHeadV1'>, operationController.signal);
            responseBody = [];
            break;
          case 'GET_RECONCILIATION_SYMBOLS':
            responseBody = await this.options.service.getReconciliationSymbols(authorizedRequest, decoded.body as ProtocolTuple<'GetReconciliationSymbolsV1'>, operationController.signal);
            break;
          case 'GET_OBJECT_IDS':
            responseBody = await this.options.service.getObjectIds(authorizedRequest, decoded.body as ProtocolTuple<'GetObjectIdsV1'>, operationController.signal);
            break;
          case 'GET_OBJECT_RANGE':
            responseBody = await this.options.service.getObjectRange(authorizedRequest, decoded.body as ProtocolTuple<'GetWalObjectRangeV1'>, operationController.signal);
            break;
        }
        if (operationController.signal.aborted) throw operationController.signal.reason;
        validateBoundResponse(decoded.method, decoded.context, decoded.body, responseBody, this.limits, decoded.requestId);
        providerState.transition('RESPOND');
        return encodeWalResponseFrame(decoded.method, decoded.requestId, responseBody, this.limits.maximumFrameBytes);
      } finally {
        clearTimeout(timeout);
        transportSignal?.removeEventListener('abort', forwardTransportAbort);
        releaseScheduler?.();
        this.operations.delete(operationKey);
        releaseOutstanding?.();
        releaseOutstanding = undefined;
      }
    } catch (error) {
      const wireError = asWalWireError(error);
      responseRequestId = wireError.requestId ?? responseRequestId;
      if (providerState && providerState.state !== 'responded' && providerState.state !== 'cancelled' && providerState.state !== 'failed') {
        providerState.transition(wireError.code === WAL_WIRE_ERROR_CODE.CANCELLED ? 'CANCEL' : 'FAIL');
      }
      return encodeWalErrorFrame(responseRequestId, wireError.toTuple(), this.limits.maximumFrameBytes);
    } finally {
      releaseOutstanding?.();
    }
  }

  private reserveOutstanding(peerId: string, requestId: Uint8Array): () => void {
    const peerCount = this.outstandingByPeer.get(peerId) ?? 0;
    if (peerCount >= this.limits.maximumOutstandingRequestsPerPeer || this.outstandingGlobal >= this.limits.maximumOutstandingRequestsGlobal) {
      throw new WalWireError(WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT, 'outstanding request limit reached', WAL_WIRE_DETAIL_CODE.QUEUE_SATURATED, null, requestId);
    }
    this.outstandingByPeer.set(peerId, peerCount + 1);
    this.outstandingGlobal += 1;
    return () => {
      const count = this.outstandingByPeer.get(peerId)! - 1;
      if (count === 0) this.outstandingByPeer.delete(peerId);
      else this.outstandingByPeer.set(peerId, count);
      this.outstandingGlobal -= 1;
    };
  }

}

export interface WalWireProtocolClientOptions {
  readonly router: WalRawProtocolRouter;
  readonly localPeerId: Uint8Array;
  readonly limits?: WalWireLimitOverrides;
  readonly randomRequestId?: () => Uint8Array;
}

export class WalWireProtocolClient {
  readonly limits: WalWireLimits;
  private readonly randomRequestId: () => Uint8Array;

  constructor(private readonly options: WalWireProtocolClientOptions) {
    if (!(options.localPeerId instanceof Uint8Array) || options.localPeerId.length === 0) throw new Error('localPeerId must be a non-empty byte string');
    this.limits = resolveLimits(options.limits);
    this.randomRequestId = options.randomRequestId ?? (() => crypto.getRandomValues(new Uint8Array(16)));
  }

  async request(
    peerId: string,
    family: WalWireFamily,
    requestType: number,
    context: ProtocolTuple<'RequestContextV1'>,
    body: readonly CborProtocolValue[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<readonly CborProtocolValue[]> {
    if (!wireBytesEqual(context[1], this.options.localPeerId)) throw new WalWireError(WAL_WIRE_ERROR_CODE.UNAUTHORIZED, 'client context requesterPeerId does not match the local peer');
    const requestId = this.randomRequestId();
    if (!(requestId instanceof Uint8Array) || requestId.length !== 16) throw new Error('randomRequestId must return exactly 16 bytes');
    const encoded = encodeWalRequestFrame(family, requestType, requestId, context, body, this.limits);
    const responseBytes = await this.options.router.send(peerId, WAL_WIRE_PROTOCOL_IDS[family], encoded, {
      timeoutMs: options.timeoutMs ?? this.limits.requestHandlerTimeoutMs,
      payloadReuse: 'single-use',
      signal: options.signal,
    });
    const decoded = decodeWalResponseFrame(family, requestType, requestId, responseBytes, this.limits);
    if (!decoded.ok) {
      throw new WalWireError(
        Number(decoded.error[0]),
        `provider returned WAL error ${decoded.error[0]}`,
        decoded.error[2] === null ? null : Number(decoded.error[2]),
        decoded.error[1],
        requestId,
      );
    }
    const method = walWireMethod(family, requestType)!;
    validateWalRequestBody(method, body, this.limits, requestId);
    validateBoundResponse(method, context, body, decoded.body, this.limits, requestId);
    return decoded.body;
  }
}

export function negotiateWalCapabilitiesV1(
  local: ProtocolTuple<'CapabilitiesV1'>,
  remote: ProtocolTuple<'CapabilitiesV1'>,
  privateRequest = false,
): NegotiatedWalCapabilitiesV1 {
  validateCapabilities(local, ZERO_REQUEST_ID);
  validateCapabilities(remote, ZERO_REQUEST_ID);
  if (!local[0].includes(1n) || !remote[0].includes(1n)) {
    throw new WalWireError(WAL_WIRE_ERROR_CODE.UNSUPPORTED_VERSION, privateRequest ? 'private WAL requests cannot downgrade from protocol v1' : 'no common WAL protocol v1');
  }
  const adapterVersions = local[1].filter(version => remote[1].includes(version));
  if (adapterVersions.length === 0) throw new WalWireError(WAL_WIRE_ERROR_CODE.UNSUPPORTED_VERSION, 'no common RDF adapter version');
  const minimum = (index: number): bigint => local[index] < remote[index] ? local[index] as bigint : remote[index] as bigint;
  return Object.freeze({
    protocolVersion: 1n,
    adapterVersion: adapterVersions[adapterVersions.length - 1],
    maximumControlFrameBytes: minimum(2),
    maximumSymbolsPerResponse: minimum(3),
    maximumFallbackIdsPerPage: minimum(4),
    maximumObjectRangeBytes: minimum(5),
    maximumWalObjectBytes: minimum(6),
    maximumConcurrentRanges: minimum(7),
  });
}
