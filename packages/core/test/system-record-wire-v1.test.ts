import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  canonicalizeAgentProfileConflictEvidenceV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileConflictEvidenceDigestV1,
  digestSystemRecordBytesV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type AgentProfileHeadObjectV1,
  type SignedSystemRecordEnvelopeV1,
} from '../src/system-record-objects-v1.js';
import {
  canonicalizeSystemRecordInventoryInternalObjectV1,
  canonicalizeSystemRecordInventoryLeafObjectV1,
  canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1,
  computeSystemRecordInventoryInternalDigestV1,
  computeSystemRecordInventoryLeafDigestV1,
  computeSystemRecordRootDescriptorDigestV1,
} from '../src/system-record-inventory-v1.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES,
  SYSTEM_RECORD_MAX_HEADER_BYTES,
  type SystemRecordObjectKindV1,
} from '../src/system-record-limits-v1.js';
import {
  decodeSystemRecordRequestFrameV1,
  decodeSystemRecordResponseFrameV1,
  decodeSystemRecordResponseHeaderV1,
  encodeSystemRecordRequestFrameV1,
  encodeSystemRecordResponseFrameV1,
  readSystemRecordHeaderLengthV1,
  verifySystemRecordResponsePayloadV1,
  type SystemRecordRequestHeaderV1,
} from '../src/system-record-wire-v1.js';

const REQUEST_ID = '0123456789abcdef0123456789abcdef';
const DIGEST = `0x${'aa'.repeat(32)}` as const;
const COMMON = {
  wireVersion: '1', requestId: REQUEST_ID, kind: 'agents', networkId: 'otp:20430',
  payloadBytes: '0',
} as const;
const PEER_ID = '12D3KooWDxBauQDeJjCmcvWiREFALfKsr5VfTzGUJbZJ6CUcc7aF';
const vectors = JSON.parse(readFileSync(
  new URL('./fixtures/system-record-v1/vectors.json', import.meta.url),
  'utf8',
)) as WireGoldenVectors;

describe('system-record wire request framing', () => {
  it('round-trips every request operation with exact omission branches', () => {
    const requests: SystemRecordRequestHeaderV1[] = [
      { ...COMMON, operation: 'get-root' },
      {
        ...COMMON, operation: 'get-inventory-object', rootDescriptorDigest: DIGEST,
        path: [0, 255], objectKind: 'inventory-leaf', objectDigest: DIGEST,
      },
      { ...COMMON, operation: 'get-control-object', objectKind: 'fork-resolution', objectDigest: DIGEST },
      { ...COMMON, operation: 'get-bundle', objectKind: 'profile-bundle', objectDigest: DIGEST },
    ];
    for (const request of requests) {
      expect(decodeSystemRecordRequestFrameV1(encodeSystemRecordRequestFrameV1(request)))
        .toEqual(request);
    }
  });

  it('rejects malformed request IDs, unknown/null fields, paths, and payloads', () => {
    expect(() => encodeSystemRecordRequestFrameV1({
      ...COMMON, requestId: `0x${REQUEST_ID}`, operation: 'get-root',
    })).toThrow(/requestId/);
    expect(() => encodeSystemRecordRequestFrameV1({
      ...COMMON, operation: 'get-root', objectDigest: null,
    } as unknown as SystemRecordRequestHeaderV1)).toThrow(/omit optional|unknown or missing/);
    expect(() => encodeSystemRecordRequestFrameV1({
      ...COMMON, operation: 'get-inventory-object', rootDescriptorDigest: DIGEST,
      path: [0, 1, 2], objectKind: 'inventory-leaf', objectDigest: DIGEST,
    })).toThrow(/path/);
    const request = encodeSystemRecordRequestFrameV1({ ...COMMON, operation: 'get-root' });
    const withPayload = new Uint8Array(request.byteLength + 1);
    withPayload.set(request);
    expect(() => decodeSystemRecordRequestFrameV1(withPayload)).toThrow(/payload-free/);
  });

  it('checks the four-byte header cap before body allocation', () => {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, SYSTEM_RECORD_MAX_HEADER_BYTES + 1, false);
    expect(() => readSystemRecordHeaderLengthV1(prefix)).toThrow(/preallocation/);
  });
});

describe('system-record wire response framing', () => {
  it('round-trips and digest-verifies an exact bundle response', () => {
    const payload = new TextEncoder().encode('canonical bundle bytes');
    const objectDigest = digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle, payload);
    const request = {
      ...COMMON, operation: 'get-bundle', objectKind: 'profile-bundle', objectDigest,
    } as const;
    const header = {
      wireVersion: '1', requestId: REQUEST_ID, status: 'ok', objectKind: 'profile-bundle',
      objectDigest, payloadBytes: String(payload.byteLength),
    } as const;
    const frame = encodeSystemRecordResponseFrameV1(header, payload);
    const decoded = decodeSystemRecordResponseFrameV1(frame);
    expect(decoded.header).toEqual(header);
    expect(decoded.payload).toEqual(payload);
    expect(() => verifySystemRecordResponsePayloadV1(request, decoded.header, decoded.payload))
      .not.toThrow();
    expect(frame.byteLength).toBeLessThanOrEqual(SYSTEM_RECORD_MAX_FRAME_BYTES);
    expect(decoded.payload.buffer).toBe(frame.buffer);
  });

  it('accepts the exact payload ceiling, rejects +1, and rejects hostile JSON encodings', () => {
    const payload = new Uint8Array(SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES);
    const objectDigest = digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle, payload);
    const header = {
      wireVersion: '1', requestId: REQUEST_ID, status: 'ok', objectKind: 'profile-bundle',
      objectDigest, payloadBytes: String(payload.byteLength),
    } as const;
    expect(encodeSystemRecordResponseFrameV1(header, payload).byteLength)
      .toBeLessThanOrEqual(SYSTEM_RECORD_MAX_FRAME_BYTES);
    expect(() => encodeSystemRecordResponseFrameV1(
      { ...header, payloadBytes: String(payload.byteLength + 1) },
      new Uint8Array(payload.byteLength + 1),
    )).toThrow(/object cap/);
    const duplicate = new TextEncoder().encode(
      `{"objectDigest":"${DIGEST}","objectDigest":"${DIGEST}","objectKind":"profile-bundle","payloadBytes":"1","requestId":"${REQUEST_ID}","status":"ok","wireVersion":"1"}`,
    );
    expect(() => decodeSystemRecordResponseHeaderV1(duplicate)).toThrow(/[Dd]uplicate|canonical/);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{}')]);
    expect(() => decodeSystemRecordResponseHeaderV1(bom)).toThrow();
    expect(readSystemRecordHeaderLengthV1(Uint8Array.of(0, 0, 0x20, 0))).toBe(SYSTEM_RECORD_MAX_HEADER_BYTES);
  });

  it('rejects status/error mismatches, declared over-cap bodies, and digest mismatch', () => {
    expect(() => encodeSystemRecordResponseFrameV1({
      wireVersion: '1', requestId: REQUEST_ID, status: 'busy', payloadBytes: '0',
      errorCode: 'internal',
    }, new Uint8Array())).toThrow(/tuple/);

    const oversizedHeader = new TextEncoder().encode(JSON.stringify({
      objectDigest: DIGEST, objectKind: 'conflict-evidence', payloadBytes: '16385',
      requestId: REQUEST_ID, status: 'ok', wireVersion: '1',
    }));
    expect(() => decodeSystemRecordResponseHeaderV1(oversizedHeader)).toThrow(/object cap/);

    const payload = new TextEncoder().encode('bytes');
    const request = {
      ...COMMON, operation: 'get-bundle', objectKind: 'profile-bundle', objectDigest: DIGEST,
    } as const;
    const response = {
      wireVersion: '1', requestId: REQUEST_ID, status: 'ok', objectKind: 'profile-bundle',
      objectDigest: DIGEST, payloadBytes: String(payload.byteLength),
    } as const;
    expect(() => verifySystemRecordResponsePayloadV1(request, response, payload)).toThrow(/digest/);
  });

  it('rejects a valid root descriptor from a different requested network', () => {
    const object = {
      objectType: 'root-descriptor', kind: 'agents', networkId: 'otp:9999',
      epoch: '0', version: '0', treeRootDigest: DIGEST, totalRows: '0',
    } as const;
    const objectDigest = computeSystemRecordRootDescriptorDigestV1(object);
    const payload = canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1({
      object,
      objectDigest,
      providerPeerId: '12D3KooWDxBauQDeJjCmcvWiREFALfKsr5VfTzGUJbZJ6CUcc7aF',
      signatureSuite: 'ed25519-v1',
      signature: Buffer.alloc(64).toString('base64url'),
    });
    const request = { ...COMMON, operation: 'get-root' } as const;
    const response = {
      wireVersion: '1', requestId: REQUEST_ID, status: 'ok', objectKind: 'root-descriptor',
      objectDigest, payloadBytes: String(payload.byteLength),
    } as const;

    expect(() => verifySystemRecordResponsePayloadV1(request, response, payload))
      .toThrow(/requested kind\/network/);
  });

  it('verifies both inventory object payloads and binds root-path context', () => {
    const leaf = { objectType: 'inventory-leaf', rows: [] } as const;
    const internal = {
      objectType: 'inventory-internal', firstKeyHash: DIGEST,
      lastKeyHash: `0x${'cc'.repeat(32)}` as const,
      entries: [
        {
          separatorKeyHash: DIGEST,
          childDigest: `0x${'bb'.repeat(32)}` as const,
          childKind: 'inventory-leaf',
        },
        {
          separatorKeyHash: `0x${'cc'.repeat(32)}` as const,
          childDigest: `0x${'dd'.repeat(32)}` as const,
          childKind: 'inventory-leaf',
        },
      ],
    } as const;
    const cases = [
      {
        objectKind: 'inventory-leaf' as const,
        payload: canonicalizeSystemRecordInventoryLeafObjectV1(leaf, COMMON.networkId, true),
        objectDigest: computeSystemRecordInventoryLeafDigestV1(leaf, COMMON.networkId, true),
      },
      {
        objectKind: 'inventory-internal' as const,
        payload: canonicalizeSystemRecordInventoryInternalObjectV1(internal, true),
        objectDigest: computeSystemRecordInventoryInternalDigestV1(internal, true),
      },
    ];

    for (const value of cases) {
      const request = {
        ...COMMON, operation: 'get-inventory-object', rootDescriptorDigest: DIGEST,
        path: [], objectKind: value.objectKind, objectDigest: value.objectDigest,
      } as const;
      const response = okResponse(value.objectKind, value.objectDigest, value.payload);
      expect(() => verifySystemRecordResponsePayloadV1(request, response, value.payload)).not.toThrow();
    }

    const value = cases[0];
    const nonRootRequest = {
      ...COMMON, operation: 'get-inventory-object', rootDescriptorDigest: DIGEST,
      path: [0], objectKind: value.objectKind, objectDigest: value.objectDigest,
    } as const;
    expect(() => verifySystemRecordResponsePayloadV1(
      nonRootRequest,
      okResponse(value.objectKind, value.objectDigest, value.payload),
      value.payload,
    )).toThrow(/occupancy/);
  });

  it('verifies every control payload branch and rejects cross-network signed controls', () => {
    const signed = [
      ['agent-profile-head', vectors.signed.activeEip191.envelope],
      ['authority-transition', vectors.signed.coSignedTransitionEip191.envelope],
      ['fork-resolution', vectors.signed.forkV0Eip191.envelope],
    ] as const;
    for (const [objectKind, envelope] of signed) {
      const payload = canonicalizeSignedSystemRecordEnvelopeV1(envelope);
      const request = {
        ...COMMON, operation: 'get-control-object', objectKind, objectDigest: envelope.objectDigest,
      } as const;
      const response = okResponse(objectKind, envelope.objectDigest, payload);
      expect(() => verifySystemRecordResponsePayloadV1(request, response, payload)).not.toThrow();
      expect(() => verifySystemRecordResponsePayloadV1(
        { ...request, networkId: 'otp:9999' }, response, payload,
      )).toThrow(/requested kind\/network/);
    }

    const evidence = {
      objectType: 'conflict-evidence', kind: 'agents', networkId: COMMON.networkId,
      peerId: PEER_ID,
      entries: [{
        type: 'fork', authoritySequence: '0', version: '0',
        objectDigests: [DIGEST, `0x${'bb'.repeat(32)}` as const],
      }],
    } as const;
    const evidencePayload = canonicalizeAgentProfileConflictEvidenceV1(evidence);
    const evidenceDigest = computeAgentProfileConflictEvidenceDigestV1(evidence);
    const evidenceRequest = {
      ...COMMON, operation: 'get-control-object', objectKind: 'conflict-evidence',
      objectDigest: evidenceDigest,
    } as const;
    expect(() => verifySystemRecordResponsePayloadV1(
      evidenceRequest,
      okResponse('conflict-evidence', evidenceDigest, evidencePayload),
      evidencePayload,
    )).not.toThrow();
    expect(() => verifySystemRecordResponsePayloadV1(
      { ...evidenceRequest, networkId: 'otp:9999' },
      okResponse('conflict-evidence', evidenceDigest, evidencePayload),
      evidencePayload,
    )).toThrow(/requested kind\/network/);

    const tablePayload = new TextEncoder().encode('[]');
    const tableDigest = digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.ownedSubjectTable,
      tablePayload,
    );
    const tableRequest = {
      ...COMMON, operation: 'get-control-object', objectKind: 'owned-subject-table',
      objectDigest: tableDigest,
    } as const;
    expect(() => verifySystemRecordResponsePayloadV1(
      tableRequest,
      okResponse('owned-subject-table', tableDigest, tablePayload),
      tablePayload,
    )).not.toThrow();
  });
});

function okResponse(
  objectKind: SystemRecordObjectKindV1,
  objectDigest: `0x${string}`,
  payload: Uint8Array,
) {
  return {
    wireVersion: '1', requestId: REQUEST_ID, status: 'ok', objectKind,
    objectDigest, payloadBytes: String(payload.byteLength),
  } as const;
}

type WireControlObject =
  | AgentProfileHeadObjectV1
  | AgentProfileAuthorityTransitionV1
  | AgentProfileForkResolutionV1;

interface WireGoldenVectors {
  readonly signed: Readonly<Record<string, {
    readonly envelope: SignedSystemRecordEnvelopeV1<WireControlObject>;
  }>>;
}
