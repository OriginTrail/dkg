import type { ProtocolTuple, ProtocolTupleName } from './schema.js';

export const WAL_WIRE_PROTOCOL_IDS = Object.freeze({
  control: '/dkg/10.1.0/wal-control',
  reconcile: '/dkg/10.1.0/wal-reconcile',
  object: '/dkg/10.1.0/wal-object',
});

export type WalWireFamily = keyof typeof WAL_WIRE_PROTOCOL_IDS;

export const WAL_CONTROL_MESSAGE = Object.freeze({
  GET_CAPABILITIES: 0,
  CAPABILITIES: 1,
  GET_HEAD: 2,
  HEAD: 3,
  GET_VECTOR: 4,
  VECTOR: 5,
  GET_CHECKPOINT: 6,
  CHECKPOINT: 7,
  ANNOUNCE_HEAD: 8,
  ACK: 9,
  CANCEL: 10,
  ERROR: 255,
});

export const WAL_RECONCILE_MESSAGE = Object.freeze({
  GET_RECONCILIATION_SYMBOLS: 0,
  RECONCILIATION_SYMBOLS: 1,
  GET_OBJECT_IDS: 2,
  OBJECT_IDS_PAGE: 3,
  CANCEL: 10,
  ERROR: 255,
});

export const WAL_OBJECT_MESSAGE = Object.freeze({
  GET_OBJECT_RANGE: 0,
  OBJECT_RANGE: 1,
  CANCEL: 10,
  ERROR: 255,
});

export const WAL_WIRE_ERROR_CODE = Object.freeze({
  UNSUPPORTED_VERSION: 0,
  UNAUTHORIZED: 1,
  STALE_HEAD: 2,
  INVALID_RANGE: 3,
  RESOURCE_LIMIT: 4,
  CANCELLED: 5,
  INTERNAL_UNAVAILABLE: 6,
  NON_CANONICAL: 7,
  INVALID_PROOF: 8,
});

export const WAL_WIRE_DETAIL_CODE = Object.freeze({
  MALFORMED_FRAME: 0,
  REPLAY: 1,
  STALE_REQUEST: 2,
  PEER_BINDING: 3,
  UNKNOWN_METHOD: 4,
  BODY_SCHEMA: 5,
  RESPONSE_BINDING: 6,
  TIMEOUT: 7,
  QUEUE_SATURATED: 8,
  LENGTH_MISMATCH: 9,
});

export const WAL_WIRE_LIMITS_V1 = Object.freeze({
  maximumFrameBytes: 1_048_576,
  maximumSymbolsPerResponse: 4_096,
  maximumSymbolsPerAttempt: 4_194_304,
  maximumDecodedIdsPerAttempt: 1_000_000,
  maximumFallbackIdsPerPage: 4_096,
  maximumFallbackPagesPerAttempt: 1_048_576,
  maximumObjectRangeBytes: 1_048_576,
  maximumWalObjectBytes: 8n * 1_024n * 1_024n * 1_024n,
  maximumConcurrentRangesPerPeer: 16,
  maximumConcurrentReconciliationStreamsPerPeer: 4,
  maximumConcurrentObjectStreamsPerNamespacePeer: 2,
  maximumOutstandingRequestsPerPeer: 128,
  maximumOutstandingRequestsGlobal: 1_024,
  maximumReplayEntriesPerPeer: 16_384,
  maximumReplayEntriesGlobal: 131_072,
  maximumQueuedRequestsPerKey: 16,
  requestFreshnessMs: 90_000,
  maximumClockSkewMs: 5_000,
  requestHandlerTimeoutMs: 20_000,
  inboundReadTimeoutMs: 20_000,
  maximumCborArrayLength: 65_536,
  maximumCborDepth: 16,
});

export type WalWireMethodName =
  | 'GET_CAPABILITIES'
  | 'GET_HEAD'
  | 'GET_VECTOR'
  | 'GET_CHECKPOINT'
  | 'ANNOUNCE_HEAD'
  | 'CANCEL'
  | 'GET_RECONCILIATION_SYMBOLS'
  | 'GET_OBJECT_IDS'
  | 'GET_OBJECT_RANGE';

export interface WalWireMethodSpec {
  readonly family: WalWireFamily;
  readonly requestType: number;
  readonly responseType: number;
  readonly requestSchema: ProtocolTupleName;
  readonly responseSchema: ProtocolTupleName;
  readonly name: WalWireMethodName;
}

export const WAL_WIRE_METHODS: readonly WalWireMethodSpec[] = Object.freeze([
  Object.freeze({ family: 'control', requestType: 0, responseType: 1, requestSchema: 'GetCapabilitiesV1', responseSchema: 'CapabilitiesV1', name: 'GET_CAPABILITIES' }),
  Object.freeze({ family: 'control', requestType: 2, responseType: 3, requestSchema: 'GetHeadV1', responseSchema: 'AuthorCheckpointV1', name: 'GET_HEAD' }),
  Object.freeze({ family: 'control', requestType: 4, responseType: 5, requestSchema: 'GetVectorV1', responseSchema: 'CollectionHeadVectorV1', name: 'GET_VECTOR' }),
  Object.freeze({ family: 'control', requestType: 6, responseType: 7, requestSchema: 'GetCheckpointV1', responseSchema: 'AuthorCheckpointV1', name: 'GET_CHECKPOINT' }),
  Object.freeze({ family: 'control', requestType: 8, responseType: 9, requestSchema: 'AnnounceHeadV1', responseSchema: 'AckV1', name: 'ANNOUNCE_HEAD' }),
  Object.freeze({ family: 'control', requestType: 10, responseType: 9, requestSchema: 'CancelV1', responseSchema: 'AckV1', name: 'CANCEL' }),
  Object.freeze({ family: 'reconcile', requestType: 0, responseType: 1, requestSchema: 'GetReconciliationSymbolsV1', responseSchema: 'ReconciliationSymbolsV1', name: 'GET_RECONCILIATION_SYMBOLS' }),
  Object.freeze({ family: 'reconcile', requestType: 2, responseType: 3, requestSchema: 'GetObjectIdsV1', responseSchema: 'ObjectIdsPageV1', name: 'GET_OBJECT_IDS' }),
  Object.freeze({ family: 'reconcile', requestType: 10, responseType: 9, requestSchema: 'CancelV1', responseSchema: 'AckV1', name: 'CANCEL' }),
  Object.freeze({ family: 'object', requestType: 0, responseType: 1, requestSchema: 'GetWalObjectRangeV1', responseSchema: 'WalObjectRangeV1', name: 'GET_OBJECT_RANGE' }),
  Object.freeze({ family: 'object', requestType: 10, responseType: 9, requestSchema: 'CancelV1', responseSchema: 'AckV1', name: 'CANCEL' }),
]);

export function walWireMethod(family: WalWireFamily, requestType: number): WalWireMethodSpec | undefined {
  return WAL_WIRE_METHODS.find(method => method.family === family && method.requestType === requestType);
}

export interface WalWirePeerId {
  toString(): string;
  toBytes(): Uint8Array;
}

export interface WalRawProtocolRouter {
  register(
    protocolId: string,
    handler: (
      data: Uint8Array,
      peerId: WalWirePeerId,
      options?: { signal?: AbortSignal },
    ) => Promise<Uint8Array>,
    options?: { maxReadBytes?: number; readTimeoutMs?: number },
  ): void;
  unregister(protocolId: string): void;
  send(
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    options?: { timeoutMs?: number; payloadReuse?: 'reusable' | 'single-use'; signal?: AbortSignal },
  ): Promise<Uint8Array>;
}

export interface WalAuthorizedRequest {
  readonly family: WalWireFamily;
  readonly method: WalWireMethodSpec;
  readonly requestId: Uint8Array;
  readonly context: ProtocolTuple<'RequestContextV1'>;
  readonly transportPeerId: WalWirePeerId;
}

export interface WalWireProtocolService {
  getCapabilities(request: WalAuthorizedRequest, signal: AbortSignal): Promise<ProtocolTuple<'CapabilitiesV1'>>;
  getHead(request: WalAuthorizedRequest, body: ProtocolTuple<'GetHeadV1'>, signal: AbortSignal): Promise<ProtocolTuple<'AuthorCheckpointV1'>>;
  getVector(request: WalAuthorizedRequest, body: ProtocolTuple<'GetVectorV1'>, signal: AbortSignal): Promise<ProtocolTuple<'CollectionHeadVectorV1'>>;
  getCheckpoint(request: WalAuthorizedRequest, body: ProtocolTuple<'GetCheckpointV1'>, signal: AbortSignal): Promise<ProtocolTuple<'AuthorCheckpointV1'>>;
  announceHead(request: WalAuthorizedRequest, body: ProtocolTuple<'AnnounceHeadV1'>, signal: AbortSignal): Promise<void>;
  getReconciliationSymbols(request: WalAuthorizedRequest, body: ProtocolTuple<'GetReconciliationSymbolsV1'>, signal: AbortSignal): Promise<ProtocolTuple<'ReconciliationSymbolsV1'>>;
  getObjectIds(request: WalAuthorizedRequest, body: ProtocolTuple<'GetObjectIdsV1'>, signal: AbortSignal): Promise<ProtocolTuple<'ObjectIdsPageV1'>>;
  getObjectRange(request: WalAuthorizedRequest, body: ProtocolTuple<'GetWalObjectRangeV1'>, signal: AbortSignal): Promise<ProtocolTuple<'WalObjectRangeV1'>>;
}

export interface WalWireLimits {
  maximumFrameBytes: number;
  maximumSymbolsPerResponse: number;
  maximumFallbackIdsPerPage: number;
  maximumObjectRangeBytes: number;
  maximumWalObjectBytes: bigint;
  maximumConcurrentReconciliationStreamsPerPeer: number;
  maximumConcurrentObjectStreamsPerNamespacePeer: number;
  maximumOutstandingRequestsPerPeer: number;
  maximumOutstandingRequestsGlobal: number;
  maximumReplayEntriesPerPeer: number;
  maximumReplayEntriesGlobal: number;
  maximumQueuedRequestsPerKey: number;
  requestFreshnessMs: number;
  maximumClockSkewMs: number;
  requestHandlerTimeoutMs: number;
  inboundReadTimeoutMs: number;
  maximumCborArrayLength: number;
  maximumCborDepth: number;
}

export type WalWireLimitOverrides = Partial<WalWireLimits>;

export interface NegotiatedWalCapabilitiesV1 {
  protocolVersion: bigint;
  adapterVersion: bigint;
  maximumControlFrameBytes: bigint;
  maximumSymbolsPerResponse: bigint;
  maximumFallbackIdsPerPage: bigint;
  maximumObjectRangeBytes: bigint;
  maximumWalObjectBytes: bigint;
  maximumConcurrentRanges: bigint;
}
