// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_MAX_INVENTORY_CHILD_INDEX,
  SYSTEM_RECORD_MAX_INVENTORY_PATH_DEPTH,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_WIRE_VERSION_V1,
  assertCanonicalDigest,
  assertNetworkIdV1,
  encodeSystemRecordRequestFrameV1,
  type NetworkIdV1,
  type SystemRecordRequestHeaderV1,
  type SystemRecordResponseStatusV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { SystemRecordExactArtifactLookupV1 } from './requester-api-v1.js';

export type SystemRecordRemoteFetchOutcomeV1 =
  | 'not-found'
  | 'unsupported'
  | 'remote-busy'
  | 'remote-error';

type SystemRecordExactRequestHeaderV1 = Extract<
  SystemRecordRequestHeaderV1,
  Readonly<{
    operation: 'get-bundle' | 'get-control-object' | 'get-inventory-object';
  }>
>;

type SystemRecordExactObjectKindV1 = Extract<
  SystemRecordExactArtifactLookupV1,
  Readonly<{ type: 'object' }>
>['objectKind'];

type SystemRecordExactOperationForObjectKindV1<
  Kind extends SystemRecordExactObjectKindV1,
> = Kind extends Extract<
  SystemRecordExactRequestHeaderV1,
  Readonly<{ operation: 'get-bundle' }>
>['objectKind']
  ? 'get-bundle'
  : 'get-control-object';

const SYSTEM_RECORD_EXACT_OPERATION_BY_OBJECT_KIND_V1 = Object.freeze({
  'profile-bundle': 'get-bundle',
  'agent-profile-head': 'get-control-object',
  'authority-transition': 'get-control-object',
  'fork-resolution': 'get-control-object',
  'conflict-evidence': 'get-control-object',
  'owned-subject-table': 'get-control-object',
} satisfies Readonly<{
  [Kind in SystemRecordExactObjectKindV1]: SystemRecordExactOperationForObjectKindV1<Kind>;
}>);

export interface SystemRecordExactRequestV1 {
  readonly request: SystemRecordExactRequestHeaderV1;
  readonly requestFrame: Uint8Array;
}

export interface NormalizedSystemRecordExactLookupV1 {
  readonly networkId: NetworkIdV1;
  readonly lookup: SystemRecordExactArtifactLookupV1;
  readonly key: string;
}

export function normalizeSystemRecordExactLookupV1(
  networkId: NetworkIdV1,
  lookup: SystemRecordExactArtifactLookupV1,
): NormalizedSystemRecordExactLookupV1 {
  assertNetworkIdV1(networkId);
  const normalized = snapshotSystemRecordExactLookupV1(lookup);
  return Object.freeze({
    networkId,
    lookup: normalized,
    key: systemRecordExactLookupKeyV1(normalized),
  });
}

export function createSystemRecordExactRequestV1(
  normalized: NormalizedSystemRecordExactLookupV1,
  requestId: string,
): SystemRecordExactRequestV1 {
  const common = {
    wireVersion: SYSTEM_RECORD_WIRE_VERSION_V1,
    requestId,
    kind: SYSTEM_RECORD_KIND_V1,
    networkId: normalized.networkId,
    payloadBytes: '0' as const,
  };
  let request: SystemRecordExactRequestHeaderV1;
  if (normalized.lookup.type === 'inventory-object') {
    request = Object.freeze({
      ...common,
      operation: 'get-inventory-object',
      rootDescriptorDigest: normalized.lookup.rootDescriptorDigest,
      path: normalized.lookup.path,
      objectKind: normalized.lookup.objectKind,
      objectDigest: normalized.lookup.objectDigest,
    });
  } else {
    request = createSystemRecordExactObjectRequestV1(common, normalized.lookup);
  }
  const requestFrame = encodeSystemRecordRequestFrameV1(request);
  return Object.freeze({ request, requestFrame });
}

function createSystemRecordExactObjectRequestV1(
  common: Readonly<{
    wireVersion: typeof SYSTEM_RECORD_WIRE_VERSION_V1;
    requestId: string;
    kind: typeof SYSTEM_RECORD_KIND_V1;
    networkId: NetworkIdV1;
    payloadBytes: '0';
  }>,
  lookup: Extract<SystemRecordExactArtifactLookupV1, Readonly<{ type: 'object' }>>,
): SystemRecordExactRequestHeaderV1 {
  const operation = SYSTEM_RECORD_EXACT_OPERATION_BY_OBJECT_KIND_V1[lookup.objectKind];
  return Object.freeze({
    ...common,
    operation,
    objectKind: lookup.objectKind,
    objectDigest: lookup.objectDigest,
  }) as SystemRecordExactRequestHeaderV1;
}

function snapshotSystemRecordExactLookupV1(
  lookup: SystemRecordExactArtifactLookupV1,
): SystemRecordExactArtifactLookupV1 {
  if (typeof lookup !== 'object' || lookup === null) {
    throw new TypeError('system-record exact lookup must be an object');
  }
  const candidate = lookup as unknown as Readonly<Record<string, unknown>>;
  const type = candidate.type;
  if (type === 'inventory-object') {
    const rootDescriptorDigest = candidate.rootDescriptorDigest;
    assertCanonicalDigest(rootDescriptorDigest, 'inventory root descriptor digest');
    const pathValue = candidate.path;
    if (!Array.isArray(pathValue)
      || pathValue.length > SYSTEM_RECORD_MAX_INVENTORY_PATH_DEPTH) {
      throw new Error(
        `inventory traversal path must contain at most ${SYSTEM_RECORD_MAX_INVENTORY_PATH_DEPTH} indexes`,
      );
    }
    const path: number[] = [];
    for (let index = 0; index < pathValue.length; index += 1) {
      const childIndex = pathValue[index];
      if (!Number.isInteger(childIndex)
        || (childIndex as number) < 0
        || (childIndex as number) > SYSTEM_RECORD_MAX_INVENTORY_CHILD_INDEX) {
        throw new Error('inventory traversal path must contain bounded child indexes');
      }
      path.push(childIndex as number);
    }
    const objectKind = candidate.objectKind;
    if (objectKind !== 'inventory-internal' && objectKind !== 'inventory-leaf') {
      throw new Error('inventory request object kind is invalid');
    }
    const objectDigest = candidate.objectDigest;
    assertCanonicalDigest(objectDigest, 'inventory object digest');
    return Object.freeze({
      type,
      rootDescriptorDigest,
      path: Object.freeze(path),
      objectKind,
      objectDigest,
    });
  }
  if (type !== 'object') throw new Error('system-record exact lookup type is invalid');
  const objectKind = candidate.objectKind;
  if (typeof objectKind !== 'string'
    || !Object.prototype.hasOwnProperty.call(
      SYSTEM_RECORD_EXACT_OPERATION_BY_OBJECT_KIND_V1,
      objectKind,
    )) {
    throw new Error('exact request object kind is invalid');
  }
  const objectDigest = candidate.objectDigest;
  assertCanonicalDigest(objectDigest, 'exact object digest');
  return Object.freeze({ type, objectKind: objectKind as SystemRecordExactObjectKindV1, objectDigest });
}

function systemRecordExactLookupKeyV1(lookup: SystemRecordExactArtifactLookupV1): string {
  if (lookup.type === 'inventory-object') {
    return JSON.stringify([
      lookup.type,
      lookup.rootDescriptorDigest,
      lookup.path,
      lookup.objectKind,
      lookup.objectDigest,
    ]);
  }
  return JSON.stringify([lookup.type, lookup.objectKind, lookup.objectDigest]);
}

export function systemRecordExactResponseOutcomeV1(
  status: Exclude<SystemRecordResponseStatusV1, 'ok'>,
): SystemRecordRemoteFetchOutcomeV1 {
  switch (status) {
    case 'not-found': return 'not-found';
    case 'unsupported': return 'unsupported';
    case 'busy': return 'remote-busy';
    case 'invalid-request':
    case 'internal': return 'remote-error';
  }
  throw new Error(`unsupported system-record response status: ${String(status)}`);
}
