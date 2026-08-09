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
  const common = {
    wireVersion: SYSTEM_RECORD_WIRE_VERSION_V1,
    requestId,
    kind: SYSTEM_RECORD_KIND_V1,
    networkId,
    payloadBytes: '0' as const,
  };
  if (lookup.type === 'inventory-object') {
    const path = Object.freeze([...lookup.path]);
    return exactRequest(Object.freeze({
      ...common,
      operation: 'get-inventory-object',
      rootDescriptorDigest: lookup.rootDescriptorDigest,
      path,
      objectKind: lookup.objectKind,
      objectDigest: lookup.objectDigest,
    }));
  }
  if (lookup.objectKind === 'profile-bundle') {
    return exactRequest(Object.freeze({
      ...common,
      operation: 'get-bundle',
      objectKind: lookup.objectKind,
      objectDigest: lookup.objectDigest,
    }));
  }
  return exactRequest(Object.freeze({
    ...common,
    operation: 'get-control-object',
    objectKind: lookup.objectKind,
    objectDigest: lookup.objectDigest,
  }));
}

function exactRequest(request: SystemRecordExactRequestHeaderV1): SystemRecordExactRequestV1 {
  return Object.freeze({ request, key: systemRecordExactRequestKeyV1(request) });
}

function systemRecordExactRequestKeyV1(request: SystemRecordExactRequestHeaderV1): string {
  switch (request.operation) {
    case 'get-inventory-object':
      return JSON.stringify([
        request.operation,
        request.rootDescriptorDigest,
        request.path,
        request.objectKind,
        request.objectDigest,
      ]);
    case 'get-bundle':
    case 'get-control-object':
      return JSON.stringify([
        request.operation,
        request.objectKind,
        request.objectDigest,
      ]);
  }
  throw new Error(`unsupported exact System Record operation: ${String(
    (request as SystemRecordRequestHeaderV1).operation,
  )}`);
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
