import {
  decodeSystemRecordRequestFrameV1,
  encodeSystemRecordRequestFrameV1,
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
    const request = writtenRequest({
      type: 'object',
      objectKind: 'profile-bundle',
      objectDigest: DIGEST_A,
    });

    expect(request).toMatchObject({
      operation: 'get-bundle',
      objectKind: 'profile-bundle',
      objectDigest: DIGEST_A,
    });
  });

  it('writes non-bundle exact lookups as get-control-object requests', () => {
    const request = writtenRequest({
      type: 'object',
      objectKind: 'owned-subject-table',
      objectDigest: DIGEST_A,
    });

    expect(request).toMatchObject({
      operation: 'get-control-object',
      objectKind: 'owned-subject-table',
      objectDigest: DIGEST_A,
    });
  });

  it('preserves the complete coordinate in get-inventory-object requests', () => {
    const request = writtenRequest({
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
  });
});

function writtenRequest(lookup: SystemRecordExactArtifactLookupV1) {
  const mapped = createSystemRecordExactRequestV1(NETWORK, lookup, REQUEST_ID);
  return decodeSystemRecordRequestFrameV1(encodeSystemRecordRequestFrameV1(mapped));
}
