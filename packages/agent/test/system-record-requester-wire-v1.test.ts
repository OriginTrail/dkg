import {
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_WIRE_VERSION_V1,
  decodeSystemRecordRequestFrameV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { describe, expect, it } from 'vitest';

import type { SystemRecordExactArtifactLookupV1 } from '../src/system-records/requester-api-v1.js';
import { createSystemRecordExactRequestV1 } from '../src/system-records/requester-wire-v1-internal.js';

const NETWORK = 'base:84532' as const;
const REQUEST_ID = '1'.repeat(32);
const DIGEST_A = `0x${'aa'.repeat(32)}` as Digest32V1;
const DIGEST_B = `0x${'bb'.repeat(32)}` as Digest32V1;

describe('system-record exact requester wire mapping V1', () => {
  it('writes profile bundle lookups as get-bundle requests', () => {
    const { key, request } = writtenRequest({
      type: 'object',
      objectKind: 'profile-bundle',
      objectDigest: DIGEST_A,
    });

    expect(request).toMatchObject({
      operation: 'get-bundle',
      objectKind: 'profile-bundle',
      objectDigest: DIGEST_A,
    });
    expect(key).toBe(JSON.stringify(['object', 'profile-bundle', DIGEST_A]));
  });

  it('writes non-bundle exact lookups as get-control-object requests', () => {
    const { key, request } = writtenRequest({
      type: 'object',
      objectKind: 'owned-subject-table',
      objectDigest: DIGEST_A,
    });

    expect(request).toMatchObject({
      operation: 'get-control-object',
      objectKind: 'owned-subject-table',
      objectDigest: DIGEST_A,
    });
    expect(key).toBe(JSON.stringify([
      'object',
      'owned-subject-table',
      DIGEST_A,
    ]));
  });

  it('preserves the complete coordinate in get-inventory-object requests', () => {
    const { key, request } = writtenRequest({
      type: 'inventory-object',
      rootDescriptorDigest: DIGEST_A,
      path: [1, 7],
      objectKind: 'inventory-leaf',
      objectDigest: DIGEST_B,
    });

    expect(request).toMatchObject({
      operation: 'get-inventory-object',
      rootDescriptorDigest: DIGEST_A,
      path: [1, 7],
      objectKind: 'inventory-leaf',
      objectDigest: DIGEST_B,
    });
    expect(key).toBe(JSON.stringify([
      'inventory-object',
      DIGEST_A,
      [1, 7],
      'inventory-leaf',
      DIGEST_B,
    ]));
  });

  it('snapshots and freezes mutable inventory paths before asynchronous transfer', () => {
    const path = [1, 7];
    const { key, request } = createSystemRecordExactRequestV1(NETWORK, {
      type: 'inventory-object',
      rootDescriptorDigest: DIGEST_A,
      path,
      objectKind: 'inventory-leaf',
      objectDigest: DIGEST_B,
    }, REQUEST_ID);
    path[0] = 0;

    expect(request.operation).toBe('get-inventory-object');
    if (request.operation !== 'get-inventory-object') return;
    expect(request.path).toEqual([1, 7]);
    expect(key).toBe(JSON.stringify([
      'inventory-object',
      DIGEST_A,
      [1, 7],
      'inventory-leaf',
      DIGEST_B,
    ]));
    expect(Object.isFrozen(request.path)).toBe(true);
    expect(Object.isFrozen(request)).toBe(true);
  });

  it('rejects object kinds outside the Core exact-request taxonomy', () => {
    const invalid = {
      type: 'object',
      objectKind: 'root-descriptor',
      objectDigest: DIGEST_A,
    } as unknown as SystemRecordExactArtifactLookupV1;

    expect(() => createSystemRecordExactRequestV1(
      NETWORK,
      invalid,
      REQUEST_ID,
    )).toThrow('exact request object kind is invalid');
  });
});

function writtenRequest(lookup: SystemRecordExactArtifactLookupV1) {
  const mapped = createSystemRecordExactRequestV1(NETWORK, lookup, REQUEST_ID);
  const request = decodeSystemRecordRequestFrameV1(mapped.requestFrame);
  expect(request).toMatchObject({
    wireVersion: SYSTEM_RECORD_WIRE_VERSION_V1,
    requestId: REQUEST_ID,
    kind: SYSTEM_RECORD_KIND_V1,
    networkId: NETWORK,
    payloadBytes: '0',
  });
  return Object.freeze({
    key: mapped.key,
    request,
  });
}
