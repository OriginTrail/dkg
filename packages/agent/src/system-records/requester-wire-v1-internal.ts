// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_WIRE_VERSION_V1,
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

type SystemRecordExactRequestHeaderV1 = Exclude<
  SystemRecordRequestHeaderV1,
  Readonly<{ operation: 'get-root' }>
>;

export interface SystemRecordExactRequestV1 {
  readonly request: SystemRecordExactRequestHeaderV1;
  readonly key: string;
}

export function createSystemRecordExactRequestV1(
  networkId: NetworkIdV1,
  lookup: SystemRecordExactArtifactLookupV1,
  requestId: string,
): SystemRecordExactRequestV1 {
  const normalized = snapshotSystemRecordExactLookupV1(lookup);
  const common = {
    wireVersion: SYSTEM_RECORD_WIRE_VERSION_V1,
    requestId,
    kind: SYSTEM_RECORD_KIND_V1,
    networkId,
    payloadBytes: '0' as const,
  };
  let request: SystemRecordExactRequestHeaderV1;
  if (normalized.type === 'inventory-object') {
    request = Object.freeze({
      ...common,
      operation: 'get-inventory-object',
      rootDescriptorDigest: normalized.rootDescriptorDigest,
      path: normalized.path,
      objectKind: normalized.objectKind,
      objectDigest: normalized.objectDigest,
    });
  } else if (normalized.objectKind === 'profile-bundle') {
    request = Object.freeze({
      ...common,
      operation: 'get-bundle',
      objectKind: normalized.objectKind,
      objectDigest: normalized.objectDigest,
    });
  } else {
    request = Object.freeze({
      ...common,
      operation: 'get-control-object',
      objectKind: normalized.objectKind,
      objectDigest: normalized.objectDigest,
    });
  }
  return Object.freeze({ request, key: systemRecordExactLookupKeyV1(normalized) });
}

function snapshotSystemRecordExactLookupV1(
  lookup: SystemRecordExactArtifactLookupV1,
): SystemRecordExactArtifactLookupV1 {
  return lookup.type === 'inventory-object'
    ? Object.freeze({ ...lookup, path: Object.freeze([...lookup.path]) })
    : Object.freeze({ ...lookup });
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
