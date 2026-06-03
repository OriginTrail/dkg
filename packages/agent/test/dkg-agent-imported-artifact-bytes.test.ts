import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN,
  IMPORTED_ARTIFACT_BYTE_KIND_ORIGINAL,
  IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
  IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS,
  contextGraphAssertionUri,
  decodeImportedArtifactBytesResponse,
  encodeImportedArtifactBytesRequest,
  type ImportedArtifactBytesRequestMsg,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';

const DKG = 'http://dkg.io/ontology/';

function keccakHash(bytes: Uint8Array): string {
  return `keccak256:${ethers.keccak256(bytes).replace(/^0x/, '')}`;
}

function sha256Hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function makeRequest(overrides: Partial<ImportedArtifactBytesRequestMsg>): ImportedArtifactBytesRequestMsg {
  const contextGraphId = 'cg-imported-artifact-bytes';
  return {
    contextGraphId,
    assertionUri: contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:origin', 'imported-file'),
    hash: `keccak256:${'a'.repeat(64)}`,
    kind: IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
    ...overrides,
  };
}

function makeAgent(args: {
  sourceHash: string;
  markdownHash?: string;
  contentType?: string;
  bytes?: Uint8Array | null;
  policy?: { accessPolicy?: number; publishPolicy?: number };
}) {
  return Object.assign(Object.create(DKGAgent.prototype), {
    importedArtifactByteStore: {
      get: vi.fn(async () => args.bytes ?? null),
    },
    getContextGraphOnChainPolicy: vi.fn(async () => (
      args.policy ?? { accessPolicy: 0, publishPolicy: 1 }
    )),
    log: { warn: vi.fn() },
    store: {
      query: vi.fn(async (sparql: string) => {
        expect(sparql).toContain(`${DKG}sourceFile`);
        expect(sparql).toContain(`${DKG}sourceFileHash`);
        expect(sparql).toContain(`${DKG}mdIntermediateHash`);
        return {
          type: 'bindings',
          bindings: [{
            sourceFile: `urn:dkg:file:${args.sourceHash}`,
            sourceFileHash: args.sourceHash,
            sourceContentType: args.contentType ?? 'application/octet-stream',
            ...(args.markdownHash
              ? {
                  markdownForm: `urn:dkg:file:${args.markdownHash}`,
                  mdIntermediateHash: args.markdownHash,
                }
              : {}),
          }],
        };
      }),
    },
  });
}

async function requestBytes(
  agent: unknown,
  request: ImportedArtifactBytesRequestMsg,
) {
  const payload = encodeImportedArtifactBytesRequest(request);
  const raw = await (agent as any).handleImportedArtifactBytesRequest(payload, 'peer-origin');
  return decodeImportedArtifactBytesResponse(raw);
}

describe('DKGAgent imported-artifact byte receiver', () => {
  it.each([
    IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
    IMPORTED_ARTIFACT_BYTE_KIND_ORIGINAL,
  ])('serves linked %s bytes with content metadata on public + open CGs', async (kind) => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const sourceHash = keccakHash(bytes);
    const agent = makeAgent({
      sourceHash,
      bytes,
      contentType: 'application/pdf',
    });

    const response = await requestBytes(agent, makeRequest({ hash: sourceHash, kind }));

    expect(response.status).toBe(IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW);
    expect(response.hash).toBe(sourceHash);
    expect(response.kind).toBe(kind);
    expect(response.contentType).toBe('application/pdf');
    expect(response.size).toBe(bytes.length);
    expect(new Uint8Array(response.bytes)).toEqual(bytes);
  });

  it('keeps markdown byte requests working with text/markdown metadata', async () => {
    const sourceBytes = new Uint8Array([1, 2, 3]);
    const markdownBytes = new TextEncoder().encode('# Imported\n');
    const sourceHash = keccakHash(sourceBytes);
    const markdownHash = keccakHash(markdownBytes);
    const agent = makeAgent({
      sourceHash,
      markdownHash,
      bytes: markdownBytes,
      contentType: 'application/pdf',
    });

    const response = await requestBytes(agent, makeRequest({
      hash: markdownHash,
      kind: IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN,
    }));

    expect(response.status).toBe(IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW);
    expect(response.contentType).toBe('text/markdown');
    expect(response.size).toBe(markdownBytes.length);
    expect(new TextDecoder().decode(response.bytes)).toBe('# Imported\n');
  });

  it('denies source bytes when the CG policy is not public + open', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sourceHash = keccakHash(bytes);
    const agent = makeAgent({
      sourceHash,
      bytes,
      policy: { accessPolicy: 0, publishPolicy: 0 },
    });

    const response = await requestBytes(agent, makeRequest({ hash: sourceHash }));

    expect(response.status).toBe(IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.DENY);
    expect(response.reason).toMatch(/not public \+ open/);
  });

  it('denies requests for hashes not linked to the imported assertion metadata', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sourceHash = keccakHash(bytes);
    const agent = makeAgent({ sourceHash, bytes });

    const response = await requestBytes(agent, makeRequest({
      hash: `keccak256:${'f'.repeat(64)}`,
    }));

    expect(response.status).toBe(IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.DENY);
    expect(response.reason).toMatch(/not linked/);
  });

  it('returns a structured hash_mismatch when stored bytes do not match the linked hash', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const linkedHash = `keccak256:${'e'.repeat(64)}`;
    const agent = makeAgent({ sourceHash: linkedHash, bytes });

    const response = await requestBytes(agent, makeRequest({ hash: linkedHash }));

    expect(response.status).toBe(IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.HASH_MISMATCH);
    expect(response.actualHash).toBe(keccakHash(bytes));
    expect(response.reason).toMatch(/do not match/);
  });

  it('accepts sha256-linked source metadata as well as keccak metadata', async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const sourceHash = sha256Hash(bytes);
    const agent = makeAgent({ sourceHash, bytes, contentType: 'text/plain' });

    const response = await requestBytes(agent, makeRequest({ hash: sourceHash }));

    expect(response.status).toBe(IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW);
    expect(response.contentType).toBe('text/plain');
    expect(new Uint8Array(response.bytes)).toEqual(bytes);
  });
});
