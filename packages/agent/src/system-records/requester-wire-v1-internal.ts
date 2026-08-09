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

export function createSystemRecordExactRequestV1(
  networkId: NetworkIdV1,
  lookup: SystemRecordExactArtifactLookupV1,
  requestId: string,
): SystemRecordRequestHeaderV1 {
  const common = {
    wireVersion: SYSTEM_RECORD_WIRE_VERSION_V1,
    requestId,
    kind: SYSTEM_RECORD_KIND_V1,
    networkId,
    payloadBytes: '0' as const,
  };
  return lookup.type === 'inventory-object'
    ? Object.freeze({
      ...common,
      operation: 'get-inventory-object',
      rootDescriptorDigest: lookup.rootDescriptorDigest,
      path: Object.freeze([...lookup.path]),
      objectKind: lookup.objectKind,
      objectDigest: lookup.objectDigest,
    })
    : lookup.objectKind === 'profile-bundle'
      ? Object.freeze({
        ...common,
        operation: 'get-bundle',
        objectKind: lookup.objectKind,
        objectDigest: lookup.objectDigest,
      })
      : Object.freeze({
        ...common,
        operation: 'get-control-object',
        objectKind: lookup.objectKind,
        objectDigest: lookup.objectDigest,
      });
}

export function systemRecordExactRequestKeyV1(request: SystemRecordRequestHeaderV1): string {
  if (request.operation === 'get-root') {
    throw new Error('root discovery is not an exact-fetch coordinate');
  }
  const coordinate = request.operation === 'get-inventory-object'
    ? [
      request.operation,
      request.rootDescriptorDigest,
      request.path,
      request.objectKind,
      request.objectDigest,
    ]
    : [request.operation, request.objectKind, request.objectDigest];
  return JSON.stringify(coordinate);
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
