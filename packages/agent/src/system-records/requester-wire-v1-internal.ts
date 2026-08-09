// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_WIRE_VERSION_V1,
  decodeSystemRecordRequestFrameV1,
  encodeSystemRecordRequestFrameV1,
  type NetworkIdV1,
  type SystemRecordRequestHeaderV1,
  type SystemRecordResponseStatusV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type {
  SystemRecordExactArtifactLookupV1,
  SystemRecordExactFetchResultV1,
} from './requester-api-v1.js';

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
  const request: SystemRecordRequestHeaderV1 = lookup.type === 'inventory-object'
    ? {
      ...common,
      operation: 'get-inventory-object',
      rootDescriptorDigest: lookup.rootDescriptorDigest,
      path: lookup.path,
      objectKind: lookup.objectKind,
      objectDigest: lookup.objectDigest,
    }
    : lookup.objectKind === 'profile-bundle'
      ? {
        ...common,
        operation: 'get-bundle',
        objectKind: lookup.objectKind,
        objectDigest: lookup.objectDigest,
      }
      : {
        ...common,
        operation: 'get-control-object',
        objectKind: lookup.objectKind,
        objectDigest: lookup.objectDigest,
      };
  return decodeSystemRecordRequestFrameV1(encodeSystemRecordRequestFrameV1(request));
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
): Exclude<SystemRecordExactFetchResultV1, Readonly<{ outcome: 'ok' }>>['outcome'] {
  switch (status) {
    case 'not-found': return 'not-found';
    case 'unsupported': return 'unsupported';
    case 'busy': return 'remote-busy';
    case 'invalid-request':
    case 'internal': return 'remote-error';
  }
  throw new Error(`unsupported system-record response status: ${String(status)}`);
}
