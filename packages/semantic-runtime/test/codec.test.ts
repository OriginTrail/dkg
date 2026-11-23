import { encode } from 'cborg';
import { describe, expect, it } from 'vitest';

import {
  MESSAGE_TYPE,
  decodeAbiSuccess,
  decodeStepOutput,
  encodeCreateRequest,
  encodeEventRequest,
} from '../src/codec.js';

describe('semantic runtime CBOR boundary', () => {
  it('validates all 32-byte IDs and unsigned bounds before encoding', () => {
    expect(() =>
      encodeCreateRequest(1n, {
        partitionId: new Uint8Array(31),
        maxEvents: 1,
        maxAccumulator: 1n,
      }),
    ).toThrow(/32 bytes/);
    expect(() =>
      encodeEventRequest(1n, {
        kind: 'advance',
        eventId: new Uint8Array(32),
        logicalTime: -1n,
        delta: 1n,
      }),
    ).toThrow(/unsigned 64-bit/);
  });

  it('rejects response correlation mismatches before decoding the payload', () => {
    // A valid request is not a valid success response, but the correlation
    // check fires first and proves callers cannot consume a sibling result.
    const request = encodeCreateRequest(9n, {
      partitionId: new Uint8Array(32),
      maxEvents: 1,
      maxAccumulator: 1n,
    });
    expect(() => decodeAbiSuccess(request, 10n, MESSAGE_TYPE.create)).toThrow(/requestId/);
  });

  it('keeps the encoded step bytes available for native/Wasm comparison', () => {
    // [events=0, accumulator=0, deadline=null, digest=32 bytes, traces=[], yielded=false]
    const payload = encode([0, 0, null, new Uint8Array(32), [], false]);
    expect(decodeStepOutput(payload).encoded).toEqual(payload);
  });
});
