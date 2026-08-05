import {
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileConflictEvidenceDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  digestSystemRecordBytesV1,
  parseCanonicalAgentProfileConflictEvidenceV1,
  parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1,
  parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
} from './system-record-objects-v1.js';
import {
  assertSignedSystemRecordRootDescriptorEnvelopeV1,
  computeSystemRecordInventoryInternalDigestV1,
  computeSystemRecordInventoryLeafDigestV1,
  computeSystemRecordRootDescriptorDigestV1,
  parseCanonicalSystemRecordInventoryInternalObjectV1,
  parseCanonicalSystemRecordInventoryLeafObjectV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
} from './system-record-inventory-v1.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_MAX_ARRAY_JSON_DEPTH,
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
  SYSTEM_RECORD_MAX_HEADER_BYTES,
  SYSTEM_RECORD_MAX_INVENTORY_CHILD_INDEX,
  SYSTEM_RECORD_MAX_INVENTORY_PATH_DEPTH,
  SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
  SYSTEM_RECORD_MAX_WIRE_REQUEST_JSON_DEPTH,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  SYSTEM_RECORD_WIRE_VERSION_V1,
  type SystemRecordObjectKindV1,
} from './system-record-limits-v1.js';
import { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
import {
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  parseCanonicalDecimalU64,
  type DecimalU64V1,
  type Digest32V1,
} from './sync-wire-scalars.js';
import { snapshotExactDataRecord } from './sync-wire-objects.js';

const REQUEST_ID = /^[0-9a-f]{32}$/;

export type SystemRecordRequestOperationV1 =
  | 'get-root'
  | 'get-inventory-object'
  | 'get-control-object'
  | 'get-bundle';

interface SystemRecordRequestCommonV1 {
  readonly wireVersion: typeof SYSTEM_RECORD_WIRE_VERSION_V1;
  readonly requestId: string;
  readonly kind: typeof SYSTEM_RECORD_KIND_V1;
  readonly networkId: NetworkIdV1;
  readonly operation: SystemRecordRequestOperationV1;
  readonly payloadBytes: '0';
}

export interface SystemRecordGetRootRequestV1 extends SystemRecordRequestCommonV1 {
  readonly operation: 'get-root';
}

export interface SystemRecordGetInventoryObjectRequestV1 extends SystemRecordRequestCommonV1 {
  readonly operation: 'get-inventory-object';
  readonly rootDescriptorDigest: Digest32V1;
  readonly path: readonly number[];
  readonly objectKind: 'inventory-internal' | 'inventory-leaf';
  readonly objectDigest: Digest32V1;
}

export interface SystemRecordGetControlObjectRequestV1 extends SystemRecordRequestCommonV1 {
  readonly operation: 'get-control-object';
  readonly objectKind:
    | 'agent-profile-head'
    | 'authority-transition'
    | 'fork-resolution'
    | 'conflict-evidence'
    | 'owned-subject-table';
  readonly objectDigest: Digest32V1;
}

export interface SystemRecordGetBundleRequestV1 extends SystemRecordRequestCommonV1 {
  readonly operation: 'get-bundle';
  readonly objectKind: 'profile-bundle';
  readonly objectDigest: Digest32V1;
}

export type SystemRecordRequestHeaderV1 =
  | SystemRecordGetRootRequestV1
  | SystemRecordGetInventoryObjectRequestV1
  | SystemRecordGetControlObjectRequestV1
  | SystemRecordGetBundleRequestV1;

export type SystemRecordResponseStatusV1 =
  | 'ok'
  | 'not-found'
  | 'invalid-request'
  | 'unsupported'
  | 'busy'
  | 'internal';

export interface SystemRecordOkResponseHeaderV1 {
  readonly wireVersion: typeof SYSTEM_RECORD_WIRE_VERSION_V1;
  readonly requestId: string;
  readonly status: 'ok';
  readonly objectKind: SystemRecordObjectKindV1;
  readonly objectDigest: Digest32V1;
  readonly payloadBytes: DecimalU64V1;
}

export interface SystemRecordErrorResponseHeaderV1 {
  readonly wireVersion: typeof SYSTEM_RECORD_WIRE_VERSION_V1;
  readonly requestId: string;
  readonly status: Exclude<SystemRecordResponseStatusV1, 'ok'>;
  readonly payloadBytes: '0';
  readonly errorCode: 'not_found' | 'invalid_request' | 'unsupported' | 'busy' | 'internal';
}

export type SystemRecordResponseHeaderV1 =
  | SystemRecordOkResponseHeaderV1
  | SystemRecordErrorResponseHeaderV1;

export interface SystemRecordDecodedResponseHeaderV1 {
  readonly header: SystemRecordResponseHeaderV1;
  readonly payloadCap: number;
}

export interface SystemRecordDecodedResponseFrameV1 {
  readonly header: SystemRecordResponseHeaderV1;
  readonly payload: Uint8Array;
}

export function readSystemRecordHeaderLengthV1(prefix: Uint8Array): number {
  if (!(prefix instanceof Uint8Array) || prefix.byteLength !== 4) {
    throw new Error('system-record frame prefix must be exactly four bytes');
  }
  const length = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, false);
  if (length < 2 || length > SYSTEM_RECORD_MAX_HEADER_BYTES) {
    throw new Error('system-record header length exceeds the preallocation cap');
  }
  return length;
}

export function encodeSystemRecordRequestFrameV1(
  header: SystemRecordRequestHeaderV1,
): Uint8Array {
  const validated = validateRequestHeader(header);
  const headerBytes = canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_MAX_HEADER_BYTES,
  });
  return frame(headerBytes, new Uint8Array());
}

export function decodeSystemRecordRequestFrameV1(frameBytes: Uint8Array): SystemRecordRequestHeaderV1 {
  const { headerBytes, payload } = splitFrame(frameBytes);
  if (payload.byteLength !== 0) throw new Error('system-record requests must be payload-free');
  return validateRequestHeader(parseCanonicalJson(headerBytes, {
    maxBytes: SYSTEM_RECORD_MAX_HEADER_BYTES, maxDepth: SYSTEM_RECORD_MAX_WIRE_REQUEST_JSON_DEPTH,
  }));
}

export function encodeSystemRecordResponseFrameV1(
  header: SystemRecordResponseHeaderV1,
  payload: Uint8Array,
): Uint8Array {
  const validated = validateResponseHeader(header);
  const expected = Number(parseCanonicalDecimalU64(validated.payloadBytes));
  if (!(payload instanceof Uint8Array) || payload.byteLength !== expected) {
    throw new Error('system-record response payload length does not match its header');
  }
  const cap = validated.status === 'ok' ? SYSTEM_RECORD_OBJECT_CAPS_V1[validated.objectKind] : 0;
  if (payload.byteLength > cap) throw new Error('system-record response payload exceeds its object-kind cap');
  const headerBytes = canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_MAX_HEADER_BYTES,
  });
  return frame(headerBytes, payload);
}

/** Parse only validated header bytes and expose the kind-specific payload allocation cap. */
export function decodeSystemRecordResponseHeaderV1(
  headerBytes: Uint8Array,
): SystemRecordDecodedResponseHeaderV1 {
  const header = validateResponseHeader(parseCanonicalJson(headerBytes, {
    maxBytes: SYSTEM_RECORD_MAX_HEADER_BYTES, maxDepth: SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
  }));
  const payloadCap = header.status === 'ok' ? SYSTEM_RECORD_OBJECT_CAPS_V1[header.objectKind] : 0;
  if (Number(parseCanonicalDecimalU64(header.payloadBytes)) > payloadCap) {
    throw new Error('response declares more payload than its validated object kind permits');
  }
  return Object.freeze({ header, payloadCap });
}

export function decodeSystemRecordResponseFrameV1(
  frameBytes: Uint8Array,
): SystemRecordDecodedResponseFrameV1 {
  const { headerBytes, payload } = splitFrame(frameBytes);
  const { header, payloadCap } = decodeSystemRecordResponseHeaderV1(headerBytes);
  if (payload.byteLength !== Number(parseCanonicalDecimalU64(header.payloadBytes))) {
    throw new Error('response payload length does not match its header');
  }
  if (payload.byteLength > payloadCap) throw new Error('response payload exceeds its object-kind cap');
  // The decoded payload is a borrowed view of frameBytes; callers copy only when retaining it.
  return Object.freeze({ header, payload });
}

export function verifySystemRecordResponsePayloadV1(
  request: SystemRecordRequestHeaderV1,
  response: SystemRecordResponseHeaderV1,
  payload: Uint8Array,
): void {
  const validatedRequest = validateRequestHeader(request);
  const validatedResponse = validateResponseHeader(response);
  if (validatedResponse.requestId !== validatedRequest.requestId) {
    throw new Error('system-record response requestId mismatch');
  }
  if (validatedResponse.status !== 'ok') {
    if (payload.byteLength !== 0) throw new Error('error response must be payload-free');
    return;
  }
  const expectedKind = validatedRequest.operation === 'get-root'
    ? 'root-descriptor'
    : validatedRequest.objectKind;
  if (validatedResponse.objectKind !== expectedKind) {
    throw new Error('system-record response object kind does not match the request');
  }
  if (validatedRequest.operation !== 'get-root'
    && validatedResponse.objectDigest !== validatedRequest.objectDigest) {
    throw new Error('system-record response object digest does not match the request');
  }
  if (payload.byteLength !== Number(parseCanonicalDecimalU64(validatedResponse.payloadBytes))) {
    throw new Error('system-record payload length mismatch');
  }
  const computed = computePayloadObjectDigestV1(validatedRequest, validatedResponse.objectKind, payload);
  if (computed !== validatedResponse.objectDigest) {
    throw new Error('system-record payload canonical object digest mismatch');
  }
}

function computePayloadObjectDigestV1(
  request: SystemRecordRequestHeaderV1,
  objectKind: SystemRecordObjectKindV1,
  payload: Uint8Array,
): Digest32V1 {
  switch (objectKind) {
    case 'root-descriptor': {
      const parsed = parseCanonicalJson(payload, {
        maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['root-descriptor'], maxDepth: SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
      });
      assertSignedSystemRecordRootDescriptorEnvelopeV1(parsed);
      return (parsed as unknown as SignedSystemRecordRootDescriptorEnvelopeV1).objectDigest;
    }
    case 'inventory-internal': {
      if (request.operation !== 'get-inventory-object') throw new Error('inventory response/request mismatch');
      const root = request.path.length === 0;
      const object = parseCanonicalSystemRecordInventoryInternalObjectV1(payload, root);
      return computeSystemRecordInventoryInternalDigestV1(object, root);
    }
    case 'inventory-leaf': {
      if (request.operation !== 'get-inventory-object') throw new Error('inventory response/request mismatch');
      const root = request.path.length === 0;
      const object = parseCanonicalSystemRecordInventoryLeafObjectV1(payload, request.networkId, root);
      return computeSystemRecordInventoryLeafDigestV1(object, request.networkId, root);
    }
    case 'agent-profile-head': {
      const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(payload);
      return computeAgentProfileHeadObjectDigestV1(envelope.object);
    }
    case 'authority-transition': {
      const envelope = parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(payload);
      return computeAgentProfileAuthorityTransitionDigestV1(envelope.object);
    }
    case 'fork-resolution': {
      const envelope = parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1(payload);
      return computeAgentProfileForkResolutionDigestV1(envelope.object);
    }
    case 'conflict-evidence': {
      return computeAgentProfileConflictEvidenceDigestV1(
        parseCanonicalAgentProfileConflictEvidenceV1(payload),
      );
    }
    case 'owned-subject-table': {
      const canonical = parseCanonicalJson(payload, {
        maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'], maxDepth: SYSTEM_RECORD_MAX_ARRAY_JSON_DEPTH,
      });
      if (!Array.isArray(canonical)) throw new Error('owned-subject table payload must be an array');
      return digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.ownedSubjectTable, payload);
    }
    case 'profile-bundle':
      return digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle, payload);
  }
}

function validateRequestHeader(value: unknown): SystemRecordRequestHeaderV1 {
  const probe = plainRecord(value, 'system-record request header');
  const operation = probe.operation;
  let expected: readonly string[];
  if (operation === 'get-root') {
    expected = ['wireVersion', 'requestId', 'kind', 'networkId', 'operation', 'payloadBytes'];
  } else if (operation === 'get-inventory-object') {
    expected = [
      'wireVersion', 'requestId', 'kind', 'networkId', 'operation',
      'rootDescriptorDigest', 'path', 'objectKind', 'objectDigest', 'payloadBytes',
    ];
  } else if (operation === 'get-control-object' || operation === 'get-bundle') {
    expected = [
      'wireVersion', 'requestId', 'kind', 'networkId', 'operation',
      'objectKind', 'objectDigest', 'payloadBytes',
    ];
  } else {
    throw new Error('system-record request operation is invalid');
  }
  const request = snapshotExactDataRecord(value, expected, 'system-record request header');
  validateHeaderCommon(request);
  if (request.kind !== SYSTEM_RECORD_KIND_V1 || request.payloadBytes !== '0') {
    throw new Error('system-record request kind/payloadBytes is invalid');
  }
  assertNetworkIdV1(request.networkId);
  if (operation === 'get-inventory-object') {
    assertCanonicalDigest(request.rootDescriptorDigest);
    assertPath(request.path);
    if (request.objectKind !== 'inventory-internal' && request.objectKind !== 'inventory-leaf') {
      throw new Error('inventory request object kind is invalid');
    }
    assertCanonicalDigest(request.objectDigest);
  } else if (operation === 'get-control-object') {
    if (![
      'agent-profile-head', 'authority-transition', 'fork-resolution',
      'conflict-evidence', 'owned-subject-table',
    ].includes(request.objectKind as string)) {
      throw new Error('control request object kind is invalid');
    }
    assertCanonicalDigest(request.objectDigest);
  } else if (operation === 'get-bundle') {
    if (request.objectKind !== 'profile-bundle') throw new Error('bundle request object kind is invalid');
    assertCanonicalDigest(request.objectDigest);
  }
  return Object.freeze({ ...request }) as unknown as SystemRecordRequestHeaderV1;
}

function validateResponseHeader(value: unknown): SystemRecordResponseHeaderV1 {
  const probe = plainRecord(value, 'system-record response header');
  const status = probe.status;
  if (status === 'ok') {
    const response = snapshotExactDataRecord(
      value,
      ['wireVersion', 'requestId', 'status', 'objectKind', 'objectDigest', 'payloadBytes'],
      'successful system-record response header',
    );
    validateHeaderCommon(response);
    if (!(response.objectKind as string in SYSTEM_RECORD_OBJECT_CAPS_V1)) {
      throw new Error('response object kind is invalid');
    }
    assertCanonicalDigest(response.objectDigest);
    assertCanonicalDecimalU64(response.payloadBytes);
    const payloadBytes = parseCanonicalDecimalU64(response.payloadBytes);
    if (payloadBytes < 1n
      || payloadBytes > BigInt(SYSTEM_RECORD_OBJECT_CAPS_V1[response.objectKind as SystemRecordObjectKindV1])) {
      throw new Error('successful response payloadBytes is outside its object cap');
    }
    return Object.freeze({ ...response }) as unknown as SystemRecordOkResponseHeaderV1;
  }
  const errors = {
    'not-found': 'not_found',
    'invalid-request': 'invalid_request',
    unsupported: 'unsupported',
    busy: 'busy',
    internal: 'internal',
  } as const;
  if (!(status as string in errors)) throw new Error('response status is invalid');
  const response = snapshotExactDataRecord(
    value,
    ['wireVersion', 'requestId', 'status', 'payloadBytes', 'errorCode'],
    'error system-record response header',
  );
  validateHeaderCommon(response);
  if (response.payloadBytes !== '0'
    || response.errorCode !== errors[status as keyof typeof errors]) {
    throw new Error('response status/errorCode/payloadBytes tuple is invalid');
  }
  return Object.freeze({ ...response }) as unknown as SystemRecordErrorResponseHeaderV1;
}

function validateHeaderCommon(header: Readonly<Record<string, unknown>>): void {
  if (header.wireVersion !== SYSTEM_RECORD_WIRE_VERSION_V1
    || typeof header.requestId !== 'string'
    || !REQUEST_ID.test(header.requestId)) {
    throw new Error('system-record wireVersion/requestId is invalid');
  }
}

function assertPath(value: unknown): asserts value is readonly number[] {
  if (!Array.isArray(value) || value.length > SYSTEM_RECORD_MAX_INVENTORY_PATH_DEPTH
    || value.some((index) => !Number.isInteger(index)
      || index < 0 || index > SYSTEM_RECORD_MAX_INVENTORY_CHILD_INDEX)) {
    throw new Error('inventory traversal path must contain at most two child indexes');
  }
}

function frame(header: Uint8Array, payload: Uint8Array): Uint8Array {
  if (header.byteLength > SYSTEM_RECORD_MAX_HEADER_BYTES) throw new Error('system-record header exceeds cap');
  const total = 4 + header.byteLength + payload.byteLength;
  if (total > SYSTEM_RECORD_MAX_FRAME_BYTES) throw new Error('system-record frame exceeds cap');
  const result = new Uint8Array(total);
  new DataView(result.buffer).setUint32(0, header.byteLength, false);
  result.set(header, 4);
  result.set(payload, 4 + header.byteLength);
  return result;
}

function splitFrame(frameBytes: Uint8Array): { headerBytes: Uint8Array; payload: Uint8Array } {
  if (!(frameBytes instanceof Uint8Array)
    || frameBytes.byteLength < 6
    || frameBytes.byteLength > SYSTEM_RECORD_MAX_FRAME_BYTES) {
    throw new Error('system-record frame length is invalid');
  }
  const headerLength = readSystemRecordHeaderLengthV1(frameBytes.subarray(0, 4));
  if (4 + headerLength > frameBytes.byteLength) throw new Error('system-record frame is truncated');
  return {
    headerBytes: frameBytes.subarray(4, 4 + headerLength),
    payload: frameBytes.subarray(4 + headerLength),
  };
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} must not contain symbols`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must contain only enumerable data properties`);
    }
    if (descriptor.value === null) throw new Error(`${label} must omit optional fields, not use null`);
  }
  return value as Record<string, unknown>;
}
