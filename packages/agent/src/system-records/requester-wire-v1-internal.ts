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

export interface SystemRecordExactRequestV1 {
  readonly request: SystemRecordRequestHeaderV1;
  readonly key: string;
}

export function createSystemRecordExactRequestV1(
  networkId: NetworkIdV1,
  lookup: SystemRecordExactArtifactLookupV1,
  requestId: string,
): SystemRecordExactRequestV1 {
  const common = {
    wireVersion: SYSTEM_RECORD_WIRE_VERSION_V1,
    requestId,
    kind: SYSTEM_RECORD_KIND_V1,
    networkId,
    payloadBytes: '0' as const,
  };
  if (lookup.type === 'inventory-object') {
    const path = Object.freeze([...lookup.path]);
    return Object.freeze({
      request: Object.freeze({
        ...common,
        operation: 'get-inventory-object',
        rootDescriptorDigest: lookup.rootDescriptorDigest,
        path,
        objectKind: lookup.objectKind,
        objectDigest: lookup.objectDigest,
      }),
      key: JSON.stringify([
        'get-inventory-object',
        lookup.rootDescriptorDigest,
        path,
        lookup.objectKind,
        lookup.objectDigest,
      ]),
    });
  }
  if (lookup.objectKind === 'profile-bundle') {
    return Object.freeze({
      request: Object.freeze({
        ...common,
        operation: 'get-bundle',
        objectKind: lookup.objectKind,
        objectDigest: lookup.objectDigest,
      }),
      key: JSON.stringify(['get-bundle', lookup.objectKind, lookup.objectDigest]),
    });
  }
  return Object.freeze({
    request: Object.freeze({
      ...common,
      operation: 'get-control-object',
      objectKind: lookup.objectKind,
      objectDigest: lookup.objectDigest,
    }),
    key: JSON.stringify(['get-control-object', lookup.objectKind, lookup.objectDigest]),
  });
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
