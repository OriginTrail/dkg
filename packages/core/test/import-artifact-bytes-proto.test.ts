import { describe, expect, it } from 'vitest';
import {
  IMPORTED_ARTIFACT_BYTE_KIND_ORIGINAL,
  IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN,
  IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
  IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS,
  PROTOCOL_IMPORTED_ARTIFACT_BYTES,
  decodeImportedArtifactBytesRequest,
  decodeImportedArtifactBytesResponse,
  encodeImportedArtifactBytesRequest,
  encodeImportedArtifactBytesResponse,
  type ImportedArtifactBytesRequestMsg,
  type ImportedArtifactBytesResponseMsg,
} from '../src/index.js';
import {
  ImportedArtifactBytesRequestSchema,
  ImportedArtifactBytesResponseSchema,
} from '../src/proto/import-artifact-bytes.js';

const VALID_REQUEST: ImportedArtifactBytesRequestMsg = {
  contextGraphId: 'dkg-code-project',
  assertionUri: 'did:dkg:context-graph:dkg-code-project/assertion/agent/imported-readme',
  hash: 'sha256:abc123',
  kind: IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN,
};

function unsafeEncodeRequest(overrides: Partial<ImportedArtifactBytesRequestMsg>): Uint8Array {
  return ImportedArtifactBytesRequestSchema.encode(
    ImportedArtifactBytesRequestSchema.create({
      ...VALID_REQUEST,
      ...overrides,
    }),
  ).finish();
}

function unsafeEncodeResponse(overrides: Partial<ImportedArtifactBytesResponseMsg>): Uint8Array {
  return ImportedArtifactBytesResponseSchema.encode(
    ImportedArtifactBytesResponseSchema.create({
      status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW,
      hash: VALID_REQUEST.hash,
      kind: VALID_REQUEST.kind,
      bytes: new TextEncoder().encode('# Imported artifact\n'),
      ...overrides,
    }),
  ).finish();
}

describe('ImportedArtifactBytes proto', () => {
  it('uses a Universal Messenger protocol id', () => {
    expect(PROTOCOL_IMPORTED_ARTIFACT_BYTES).toBe('/dkg/10.0.1/imported-artifact-bytes');
  });

  it('round-trips markdown byte requests', () => {
    const decoded = decodeImportedArtifactBytesRequest(
      encodeImportedArtifactBytesRequest(VALID_REQUEST),
    );

    expect(decoded).toEqual(VALID_REQUEST);
  });

  it.each([
    IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
    IMPORTED_ARTIFACT_BYTE_KIND_ORIGINAL,
  ])('round-trips %s byte requests', (kind) => {
    const request = {
      ...VALID_REQUEST,
      hash: `keccak256:${'a'.repeat(64)}`,
      kind,
      subGraphName: 'documents',
    };

    const decoded = decodeImportedArtifactBytesRequest(
      encodeImportedArtifactBytesRequest(request),
    );

    expect(decoded).toEqual(request);
  });

  it.each([
    ['contextGraphId', { contextGraphId: '' }],
    ['assertionUri', { assertionUri: '' }],
    ['hash', { hash: '' }],
    ['kind', { kind: '' }],
    ['kind whitespace', { kind: '   ' }],
  ] satisfies Array<[string, Partial<ImportedArtifactBytesRequestMsg>]>)(
    'rejects empty request %s on encode and decode',
    (_label, overrides) => {
      expect(() => encodeImportedArtifactBytesRequest({
        ...VALID_REQUEST,
        ...overrides,
      })).toThrow(/Invalid ImportedArtifactBytesRequest payload/);

      expect(() => decodeImportedArtifactBytesRequest(
        unsafeEncodeRequest(overrides),
      )).toThrow(/Invalid ImportedArtifactBytesRequest payload/);
    },
  );

  it('round-trips allowed markdown bytes', () => {
    const bytes = new TextEncoder().encode('# Imported artifact\n');
    const decoded = decodeImportedArtifactBytesResponse(
      encodeImportedArtifactBytesResponse({
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW,
        hash: VALID_REQUEST.hash,
        kind: VALID_REQUEST.kind,
        bytes,
      }),
    );

    expect(decoded.status).toBe(IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW);
    expect(decoded.hash).toBe(VALID_REQUEST.hash);
    expect(decoded.kind).toBe(IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN);
    expect(new Uint8Array(decoded.bytes)).toEqual(bytes);
  });

  it('round-trips allowed source bytes with content metadata', () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const decoded = decodeImportedArtifactBytesResponse(
      encodeImportedArtifactBytesResponse({
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW,
        hash: `keccak256:${'b'.repeat(64)}`,
        kind: IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
        bytes,
        contentType: 'application/pdf',
        size: bytes.length,
      }),
    );

    expect(decoded.status).toBe(IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW);
    expect(decoded.kind).toBe(IMPORTED_ARTIFACT_BYTE_KIND_SOURCE);
    expect(decoded.contentType).toBe('application/pdf');
    expect(decoded.size).toBe(bytes.length);
    expect(new Uint8Array(decoded.bytes)).toEqual(bytes);
  });

  it.each([
    [IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.DENY, 'not a participant'],
    [IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.MISS, 'artifact not replicated'],
  ])('round-trips expected %s responses without throwing', (status, reason) => {
    const decoded = decodeImportedArtifactBytesResponse(
      encodeImportedArtifactBytesResponse({
        status,
        hash: VALID_REQUEST.hash,
        kind: VALID_REQUEST.kind,
        bytes: new Uint8Array(0),
        reason,
      }),
    );

    expect(decoded.status).toBe(status);
    expect(decoded.reason).toBe(reason);
    expect(decoded.bytes.length).toBe(0);
  });

  it('normalizes omitted response bytes to an empty Uint8Array', () => {
    const decoded = decodeImportedArtifactBytesResponse(
      ImportedArtifactBytesResponseSchema.encode(
        ImportedArtifactBytesResponseSchema.create({
          status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.MISS,
          hash: VALID_REQUEST.hash,
          kind: VALID_REQUEST.kind,
          reason: 'not local',
        }),
      ).finish(),
    );

    expect(decoded.bytes).toBeInstanceOf(Uint8Array);
    expect(decoded.bytes.length).toBe(0);
  });

  it('round-trips hash mismatch as a structured response without bytes', () => {
    const decoded = decodeImportedArtifactBytesResponse(
      encodeImportedArtifactBytesResponse({
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.HASH_MISMATCH,
        hash: VALID_REQUEST.hash,
        kind: VALID_REQUEST.kind,
        bytes: new Uint8Array(0),
        actualHash: 'sha256:def456',
        reason: 'stored bytes do not match requested hash',
      }),
    );

    expect(decoded.status).toBe(IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.HASH_MISMATCH);
    expect(decoded.actualHash).toBe('sha256:def456');
    expect(decoded.bytes.length).toBe(0);
  });

  it('rejects invalid response status and hash-unsafe payloads', () => {
    expect(() => decodeImportedArtifactBytesResponse(new Uint8Array(0))).toThrow(
      /Invalid ImportedArtifactBytesResponse payload/,
    );
    expect(() => encodeImportedArtifactBytesResponse({
      status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.MISS,
      hash: VALID_REQUEST.hash,
      kind: VALID_REQUEST.kind,
      bytes: new Uint8Array([1]),
    })).toThrow(/only allow responses may carry bytes/);
    expect(() => decodeImportedArtifactBytesResponse(
      unsafeEncodeResponse({
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.MISS,
        bytes: new Uint8Array([1]),
      }),
    )).toThrow(/only allow responses may carry bytes/);
    expect(() => decodeImportedArtifactBytesResponse(
      unsafeEncodeResponse({
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.HASH_MISMATCH,
        bytes: new Uint8Array(0),
        actualHash: '',
      }),
    )).toThrow(/actualHash is required/);
  });
});
