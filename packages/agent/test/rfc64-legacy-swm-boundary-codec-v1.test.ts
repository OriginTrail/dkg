// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  decodeRfc64BindingValueV1,
  parseRfc64LegacySwmBoundaryCaptureV1,
  parseRfc64LateLegacySwmBoundaryEntryV1,
} from '../src/rfc64/legacy-swm-boundary-codec-v1.js';

const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/legacy-boundary';
const UAL_ONE = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1';
const UAL_TWO = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/2';

describe('persisted legacy boundary corruption', () => {
  const entry = { contextGraphId: CONTEXT_GRAPH_ID, kaUal: UAL_ONE };
  const marker = {
    version: 1, ...entry, shareOperationId: 'share-original', assertionVersion: '1',
  };

  it.each([
    null,
    [],
    { version: 2, entries: [] },
    { version: 1, entries: [], extra: true },
    { version: 1, entries: null },
    { version: 1, entries: [null] },
    { version: 1, entries: [{ ...entry, extra: true }] },
    { version: 1, entries: [{ ...entry, contextGraphId: 7 }] },
    { version: 1, entries: [entry, entry] },
    { version: 1, entries: [{ ...entry, kaUal: UAL_TWO }, entry] },
  ])('rejects malformed or ambiguous captured authority %#', (capture) => {
    expect(() => parseRfc64LegacySwmBoundaryCaptureV1(
      new TextEncoder().encode(JSON.stringify(capture)),
    )).toThrow();
  });

  it('rejects invalid UTF-8 and truncated capture JSON', () => {
    expect(() => parseRfc64LegacySwmBoundaryCaptureV1(Uint8Array.of(0xff))).toThrow();
    expect(() => parseRfc64LegacySwmBoundaryCaptureV1(new TextEncoder().encode('{'))).toThrow();
  });

  it.each([
    '{', 'null', '[]',
    JSON.stringify({ ...marker, extra: true }),
    JSON.stringify({ ...marker, version: 2 }),
    JSON.stringify({ ...marker, assertionVersion: '0' }),
    JSON.stringify({ ...marker, assertionVersion: '01' }),
  ])('rejects corrupt late-share marker %# without inventing publication evidence', (encoded) => {
    expect(() => parseRfc64LateLegacySwmBoundaryEntryV1(encoded)).toThrow();
  });

  it('retains an exact valid marker and rejects malformed RDF literal carriers', () => {
    expect(parseRfc64LateLegacySwmBoundaryEntryV1(JSON.stringify(marker))).toEqual(marker);
    expect(() => decodeRfc64BindingValueV1('"unterminated')).toThrow();
  });
});
