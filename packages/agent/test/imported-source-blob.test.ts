import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { SourceBlobMethods } from '../src/dkg-agent-source-blob.js';
import {
  IMPORTED_SOURCE_BLOB_WIRE_VERSION,
  decodeImportedSourceBlobResponse,
  encodeImportedSourceBlobRequest,
  encodeImportedSourceBlobResponse,
} from '../src/imported-source-blob-wire.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

const AUTH_PURPOSE = 'imported-source-blob:v1';
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const REQUESTER_PEER_ID = 'peer-requester';
const RESPONDER_PEER_ID = 'peer-source';
const REQUESTER_WALLET = new ethers.Wallet(`0x${'11'.repeat(32)}`);

function selector(input: {
  assertionUri: string;
  blobHash: string;
  offset: number;
  maxBytes: number;
}): string {
  return ethers.solidityPackedKeccak256(
    ['uint256', 'string', 'string', 'uint256', 'uint256'],
    [
      BigInt(IMPORTED_SOURCE_BLOB_WIRE_VERSION),
      input.assertionUri,
      input.blobHash.toLowerCase(),
      BigInt(input.offset),
      BigInt(input.maxBytes),
    ],
  );
}

function hash(bytes: Uint8Array): string {
  return `keccak256:${ethers.keccak256(bytes).replace(/^0x/, '')}`;
}

function unsignedAuthEnvelope(input: {
  contextGraphId: string;
  assertionUri: string;
  blobHash: string;
  offset?: number;
  maxBytes?: number;
  authPurpose?: string;
  authSelector?: string;
}): Uint8Array {
  const offset = input.offset ?? 0;
  const maxBytes = input.maxBytes ?? 1024;
  return new TextEncoder().encode(JSON.stringify({
    contextGraphId: input.contextGraphId,
    offset,
    limit: maxBytes,
    includeSharedMemory: true,
    authPurpose: input.authPurpose ?? AUTH_PURPOSE,
    authSelector: input.authSelector ?? selector({
      assertionUri: input.assertionUri,
      blobHash: input.blobHash,
      offset,
      maxBytes,
    }),
  }));
}

async function signedAuthEnvelope(input: {
  contextGraphId: string;
  assertionUri: string;
  blobHash: string;
  offset?: number;
  maxBytes?: number;
  authPurpose?: string;
  authSelector?: string;
  requesterIdentityId?: string;
  includeRequesterAgentAddress?: boolean;
}): Promise<Uint8Array> {
  const offset = input.offset ?? 0;
  const maxBytes = input.maxBytes ?? 1024;
  const requesterIdentityId = input.requesterIdentityId ?? '0';
  const request: SyncRequestEnvelope = {
    contextGraphId: input.contextGraphId,
    offset,
    limit: maxBytes,
    includeSharedMemory: true,
    targetPeerId: RESPONDER_PEER_ID,
    requesterPeerId: REQUESTER_PEER_ID,
    requestId: ethers.hexlify(ethers.randomBytes(12)),
    issuedAtMs: Date.now(),
    requesterIdentityId,
    authPurpose: input.authPurpose ?? AUTH_PURPOSE,
    authSelector: input.authSelector ?? selector({
      assertionUri: input.assertionUri,
      blobHash: input.blobHash,
      offset,
      maxBytes,
    }),
  };
  if (input.includeRequesterAgentAddress ?? (requesterIdentityId === '0')) {
    request.requesterAgentAddress = REQUESTER_WALLET.address;
  }
  const digest = ContextGraphResolveMethods.prototype.computeSyncDigest.call(
    {},
    request.contextGraphId,
    request.offset,
    request.limit,
    request.includeSharedMemory,
    request.targetPeerId,
    request.requesterPeerId,
    request.requestId,
    request.issuedAtMs,
    request.requesterAgentAddress,
    request.authPurpose,
    request.authSelector,
  );
  const sig = ethers.Signature.from(await REQUESTER_WALLET.signMessage(digest));
  return new TextEncoder().encode(JSON.stringify({
    ...request,
    requesterSignatureR: sig.r,
    requesterSignatureVS: sig.yParityAndS,
  }));
}

function sourceBlobRequest(input: {
  contextGraphId: string;
  assertionUri: string;
  blobHash: string;
  subGraphName?: string;
  offset?: number;
  maxBytes?: number;
  auth?: Uint8Array;
}): Uint8Array {
  return encodeImportedSourceBlobRequest({
    version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
    contextGraphId: input.contextGraphId,
    assertionUri: input.assertionUri,
    blobHash: input.blobHash,
    ...(input.subGraphName ? { subGraphName: input.subGraphName } : {}),
    offset: input.offset ?? 0,
    maxBytes: input.maxBytes ?? 1024,
    authB64: Buffer.from(input.auth ?? unsignedAuthEnvelope({
      contextGraphId: input.contextGraphId,
      assertionUri: input.assertionUri,
      blobHash: input.blobHash,
      offset: input.offset,
      maxBytes: input.maxBytes,
    })).toString('base64'),
  });
}

function fakeResponder(args: {
  blobHash: string;
  bytes?: Buffer;
  policy?: { accessPolicy?: number; publishPolicy?: number };
  contentType?: string;
  mdIntermediateHash?: string;
  verifySyncIdentity?: (address: string, identityId: bigint) => Promise<boolean>;
}) {
  const bytes = args.bytes ?? Buffer.from('# Imported\n');
  const verifySyncIdentity = vi.fn(args.verifySyncIdentity ?? (async () => false));
  const storeQuery = vi.fn(async (sparql: string) => {
    if (sparql.includes('SELECT ?sourceFileHash')) {
      return {
        type: 'bindings',
        bindings: [{
          sourceFileHash: args.blobHash,
          sourceContentType: args.contentType ?? 'text/markdown',
          ...(args.mdIntermediateHash ? { mdIntermediateHash: args.mdIntermediateHash } : {}),
        }],
      };
    }
    if (sparql.includes('SELECT ?sourceFile')) {
      return { type: 'bindings', bindings: [] };
    }
    throw new Error(`unexpected query: ${sparql}`);
  });
  const stat = vi.fn(async () => ({ size: bytes.length }));
  const readRange = vi.fn(async (_hash: string, offset: number, length: number) =>
    bytes.subarray(offset, offset + length));
  return {
    peerId: RESPONDER_PEER_ID,
    chain: { verifySyncIdentity },
    seenPrivateSyncRequestIds: new Map<string, number>(),
    getContextGraphOnChainPolicy: vi.fn(async () => args.policy ?? { accessPolicy: 0, publishPolicy: 1 }),
    computeSyncDigest: ContextGraphResolveMethods.prototype.computeSyncDigest,
    parseSyncRequest: vi.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
    authorizeSyncRequest: vi.fn(async () => true),
    getPrivateContextGraphParticipants: vi.fn(async () => null),
    getContextGraphAllowedPeers: vi.fn(async () => null),
    getContextGraphAgentGateAddresses: vi.fn(async () => null),
    getContextGraphAllowedDelegateePeers: vi.fn(async () => new Map<string, string[]>()),
    getContextGraphAllowedDelegateeKeys: vi.fn(async () => new Map<string, string[]>()),
    refreshMetaFromCurator: vi.fn(async () => false),
    log: { warn: vi.fn(), info: vi.fn() },
    validateImportedSourceBlobSignature: SourceBlobMethods.prototype.validateImportedSourceBlobSignature,
    importedSourceBlobSignatureIdentityIsValid: SourceBlobMethods.prototype.importedSourceBlobSignatureIdentityIsValid,
    authorizeImportedSourceBlobRequest: SourceBlobMethods.prototype.authorizeImportedSourceBlobRequest,
    importedSourceBlobHashIsReferenced: SourceBlobMethods.prototype.importedSourceBlobHashIsReferenced,
    store: { query: storeQuery },
    importedSourceBlobStore: { stat, readRange },
    _spies: { storeQuery, stat, readRange, verifySyncIdentity },
  };
}

describe('imported source blob protocol', () => {
  it('serves a referenced Markdown blob after auth using bounded range reads', async () => {
    const bytes = Buffer.alloc(MAX_PAGE_BYTES + 11, 0x61);
    const blobHash = hash(bytes);
    const contextGraphId = 'cg-source-blob';
    const assertionUri = 'did:dkg:context-graph:cg-source-blob/assertion/did:dkg:agent:source/imported-md';
    const responder = fakeResponder({ blobHash, bytes });

    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      responder as any,
      sourceBlobRequest({
        contextGraphId,
        assertionUri,
        blobHash,
        maxBytes: MAX_PAGE_BYTES + 1000,
        auth: await signedAuthEnvelope({
          contextGraphId,
          assertionUri,
          blobHash,
          maxBytes: MAX_PAGE_BYTES + 1000,
        }),
      }),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.denied).toBeUndefined();
    expect(response.totalBytes).toBe(bytes.length);
    expect(response.nextOffset).toBe(MAX_PAGE_BYTES);
    expect(response.truncated).toBe(true);
    expect(Buffer.from(response.bytesB64 ?? '', 'base64')).toHaveLength(MAX_PAGE_BYTES);
    expect(responder._spies.readRange).toHaveBeenCalledWith(blobHash, 0, MAX_PAGE_BYTES);
  });

  it('normalizes source blob hash casing before metadata and store lookups', async () => {
    const bytes = Buffer.from('# Mixed Case Hash\n');
    const blobHash = hash(bytes);
    const mixedCaseBlobHash = blobHash.replace('keccak256:', 'KECCAK256:').toUpperCase();
    const contextGraphId = 'cg-source-blob-mixed-case';
    const assertionUri = 'did:dkg:context-graph:cg-source-blob-mixed-case/assertion/did:dkg:agent:source/imported-md';
    const responder = fakeResponder({ blobHash, bytes });

    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      responder as any,
      sourceBlobRequest({
        contextGraphId,
        assertionUri,
        blobHash: mixedCaseBlobHash,
        auth: await signedAuthEnvelope({
          contextGraphId,
          assertionUri,
          blobHash: mixedCaseBlobHash,
        }),
      }),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.denied).toBeUndefined();
    expect(response.blobHash).toBe(blobHash);
    expect(responder._spies.stat).toHaveBeenCalledWith(blobHash);
    expect(responder._spies.readRange).toHaveBeenCalledWith(blobHash, 0, bytes.length);
  });

  it('serves an identity-signed auth envelope without an agent address claim', async () => {
    const bytes = Buffer.from('# Identity Signed\n');
    const blobHash = hash(bytes);
    const contextGraphId = 'cg-source-blob-identity-auth';
    const assertionUri = 'did:dkg:context-graph:cg-source-blob-identity-auth/assertion/did:dkg:agent:source/imported-md';
    const identityId = 77n;
    const responder = fakeResponder({
      blobHash,
      bytes,
      verifySyncIdentity: async (address, claimedIdentityId) =>
        address.toLowerCase() === REQUESTER_WALLET.address.toLowerCase() &&
        claimedIdentityId === identityId,
    });

    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      responder as any,
      sourceBlobRequest({
        contextGraphId,
        assertionUri,
        blobHash,
        auth: await signedAuthEnvelope({
          contextGraphId,
          assertionUri,
          blobHash,
          requesterIdentityId: identityId.toString(),
          includeRequesterAgentAddress: false,
        }),
      }),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.denied).toBeUndefined();
    expect(response.totalBytes).toBe(bytes.length);
    expect(responder._spies.verifySyncIdentity).toHaveBeenCalledWith(REQUESTER_WALLET.address, identityId);
    expect(responder._spies.readRange).toHaveBeenCalledWith(blobHash, 0, bytes.length);
  });

  it('uses root import metadata when a source blob request includes subGraphName', async () => {
    const bytes = Buffer.from('# Subgraph Markdown\n');
    const blobHash = hash(bytes);
    const contextGraphId = 'cg-source-blob-subgraph';
    const subGraphName = 'research';
    const assertionUri = 'did:dkg:context-graph:cg-source-blob-subgraph/research/assertion/did:dkg:agent:source/imported-md';
    const responder = fakeResponder({ blobHash, bytes });

    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      responder as any,
      sourceBlobRequest({
        contextGraphId,
        assertionUri,
        blobHash,
        subGraphName,
        auth: await signedAuthEnvelope({
          contextGraphId,
          assertionUri,
          blobHash,
        }),
      }),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.denied).toBeUndefined();
    const metadataQuery = responder._spies.storeQuery.mock.calls
      .map(([sparql]) => sparql)
      .find((sparql) => sparql.includes('SELECT ?sourceFileHash'));
    expect(metadataQuery).toContain(`<${contextGraphMetaUri(contextGraphId)}>`);
  });

  it('serves owner source blobs when publish is curated', async () => {
    const bytes = Buffer.from('# Public Curated Publish\n');
    const blobHash = hash(bytes);
    const contextGraphId = 'cg-public-curators-only';
    const assertionUri = `did:dkg:context-graph:cg-public-curators-only/assertion/did:dkg:agent:${REQUESTER_WALLET.address}/imported-md`;
    const responder = fakeResponder({
      blobHash,
      bytes,
      policy: { accessPolicy: 0, publishPolicy: 0 },
    });

    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      responder as any,
      sourceBlobRequest({
        contextGraphId,
        assertionUri,
        blobHash,
        auth: await signedAuthEnvelope({
          contextGraphId,
          assertionUri,
          blobHash,
        }),
      }),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.denied).toBeUndefined();
    expect(response.totalBytes).toBe(bytes.length);
    expect(responder._spies.storeQuery).toHaveBeenCalled();
    expect(responder._spies.stat).toHaveBeenCalledWith(blobHash);
    expect(responder._spies.readRange).toHaveBeenCalledWith(blobHash, 0, bytes.length);
  });

  it('denies cross-agent source blobs when public publish is curated', async () => {
    const bytes = Buffer.from('# Public Curated Publish\n');
    const blobHash = hash(bytes);
    const contextGraphId = 'cg-public-curators-only-cross-agent';
    const assertionUri = 'did:dkg:context-graph:cg-public-curators-only-cross-agent/assertion/did:dkg:agent:source/imported-md';
    const responder = fakeResponder({
      blobHash,
      bytes,
      policy: { accessPolicy: 0, publishPolicy: 0 },
    });

    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      responder as any,
      sourceBlobRequest({
        contextGraphId,
        assertionUri,
        blobHash,
        auth: await signedAuthEnvelope({
          contextGraphId,
          assertionUri,
          blobHash,
        }),
      }),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.denied).toMatch(/unauthorized/);
    expect(responder._spies.storeQuery).not.toHaveBeenCalled();
    expect(responder._spies.stat).not.toHaveBeenCalled();
  });

  it('serves owner source blobs when chain policy is unknown', async () => {
    const bytes = Buffer.from('# Unknown Policy Owner\n');
    const blobHash = hash(bytes);
    const contextGraphId = 'cg-source-blob-unknown-policy-owner';
    const assertionUri = `did:dkg:context-graph:cg-source-blob-unknown-policy-owner/assertion/did:dkg:agent:${REQUESTER_WALLET.address}/imported-md`;
    const responder = fakeResponder({
      blobHash,
      bytes,
      policy: {},
    });

    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      responder as any,
      sourceBlobRequest({
        contextGraphId,
        assertionUri,
        blobHash,
        auth: await signedAuthEnvelope({
          contextGraphId,
          assertionUri,
          blobHash,
        }),
      }),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.denied).toBeUndefined();
    expect(responder._spies.readRange).toHaveBeenCalledWith(blobHash, 0, bytes.length);
  });

  it('forces private authorization when chain policy is unknown for a non-owner', async () => {
    const bytes = Buffer.from('# Unknown Policy Non Owner\n');
    const blobHash = hash(bytes);
    const contextGraphId = 'cg-source-blob-unknown-policy-non-owner';
    const assertionUri = 'did:dkg:context-graph:cg-source-blob-unknown-policy-non-owner/assertion/did:dkg:agent:source/imported-md';
    const responder = fakeResponder({
      blobHash,
      bytes,
      policy: {},
    });

    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      responder as any,
      sourceBlobRequest({
        contextGraphId,
        assertionUri,
        blobHash,
        auth: await signedAuthEnvelope({
          contextGraphId,
          assertionUri,
          blobHash,
        }),
      }),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.denied).toMatch(/unauthorized/);
    expect(responder.getPrivateContextGraphParticipants).toHaveBeenCalledWith(contextGraphId);
    expect(responder._spies.storeQuery).not.toHaveBeenCalled();
    expect(responder._spies.stat).not.toHaveBeenCalled();
  });

  it('forces private authorization when on-chain policy says access is private', async () => {
    const bytes = Buffer.from('# Curated Secret\n');
    const blobHash = hash(bytes);
    const contextGraphId = 'cg-curated-stale-local-public';
    const assertionUri = 'did:dkg:context-graph:cg-curated-stale-local-public/assertion/did:dkg:agent:source/imported-md';
    const responder = fakeResponder({
      blobHash,
      bytes,
      policy: { accessPolicy: 1, publishPolicy: 1 },
    });

    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      responder as any,
      sourceBlobRequest({
        contextGraphId,
        assertionUri,
        blobHash,
        auth: await signedAuthEnvelope({
          contextGraphId,
          assertionUri,
          blobHash,
        }),
      }),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.denied).toMatch(/unauthorized/);
    expect(responder.authorizeSyncRequest).not.toHaveBeenCalled();
    expect(responder._spies.storeQuery).not.toHaveBeenCalled();
    expect(responder._spies.stat).not.toHaveBeenCalled();
  });

  it('rejects auth envelopes that do not bind the requested assertion and blob hash', async () => {
    const bytes = Buffer.from('# Secret\n');
    const blobHash = hash(bytes);
    const responder = fakeResponder({ blobHash, bytes });
    const contextGraphId = 'cg-source-blob';
    const assertionUri = 'did:dkg:context-graph:cg-source-blob/assertion/did:dkg:agent:source/imported-md';

    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      responder as any,
      sourceBlobRequest({
        contextGraphId,
        assertionUri,
        blobHash,
        auth: await signedAuthEnvelope({
          contextGraphId,
          assertionUri,
          blobHash,
          authSelector: selector({
            assertionUri: `${assertionUri}-other`,
            blobHash,
            offset: 0,
            maxBytes: 1024,
          }),
        }),
      }),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.denied).toMatch(/bind source blob selector/);
    expect(responder.authorizeSyncRequest).not.toHaveBeenCalled();
    expect(responder._spies.storeQuery).not.toHaveBeenCalled();
  });

  it('returns malformed request denial details in a decodable response', async () => {
    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      {} as any,
      new TextEncoder().encode('{not-json'),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.contextGraphId).toBe('');
    expect(response.assertionUri).toBe('');
    expect(response.denied).toMatch(/malformed request/);
  });

  it('serves a converter Markdown intermediate instead of the original source blob', async () => {
    const sourceBytes = Buffer.from('%PDF original');
    const markdownBytes = Buffer.from('# Converted\n');
    const sourceHash = hash(sourceBytes);
    const markdownHash = hash(markdownBytes);
    const contextGraphId = 'cg-converted';
    const assertionUri = 'did:dkg:context-graph:cg-converted/assertion/did:dkg:agent:source/converted';
    const responder = fakeResponder({
      blobHash: sourceHash,
      bytes: sourceBytes,
      contentType: 'application/pdf',
      mdIntermediateHash: markdownHash,
    });

    const responseBytes = await SourceBlobMethods.prototype.handleGetImportedSourceBlob.call(
      responder as any,
      sourceBlobRequest({
        contextGraphId,
        assertionUri,
        blobHash: sourceHash,
        auth: await signedAuthEnvelope({
          contextGraphId,
          assertionUri,
          blobHash: sourceHash,
        }),
      }),
      REQUESTER_PEER_ID,
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);

    expect(response.denied).toMatch(/not referenced/);
    expect(responder._spies.stat).not.toHaveBeenCalled();
  });

  it('rejects mismatched fetch responses and preserves empty byte pages', async () => {
    const contextGraphId = 'cg-fetch';
    const assertionUri = 'did:dkg:context-graph:cg-fetch/assertion/did:dkg:agent:source/imported-md';
    const blobHash = hash(new Uint8Array());
    const requestAgent = {
      buildImportedSourceBlobAuthEnvelope: vi.fn(async () => new Uint8Array([1])),
      messenger: {
        sendToPeer: vi.fn(async () => encodeImportedSourceBlobResponse({
          version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
          contextGraphId,
          assertionUri,
          blobHash,
          offset: 0,
          totalBytes: 0,
          bytesB64: '',
        })),
      },
    };

    const fetched = await SourceBlobMethods.prototype.fetchImportedSourceBlobFromPeer.call(
      requestAgent as any,
      'peer-source',
      { contextGraphId, assertionUri, blobHash, maxBytes: 1024 },
    );
    expect(fetched.bytes).toEqual(new Uint8Array());

    requestAgent.messenger.sendToPeer = vi.fn(async () => encodeImportedSourceBlobResponse({
      version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
      contextGraphId,
      assertionUri,
      blobHash,
      offset: 0,
      totalBytes: 14,
      bytesB64: Buffer.from('# Wrong Bytes\n').toString('base64'),
    }));

    await expect(SourceBlobMethods.prototype.fetchImportedSourceBlobFromPeer.call(
      requestAgent as any,
      'peer-source',
      { contextGraphId, assertionUri, blobHash, maxBytes: 1024 },
    )).rejects.toThrow(/hash mismatch/);

    requestAgent.messenger.sendToPeer = vi.fn(async () => encodeImportedSourceBlobResponse({
      version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
      contextGraphId,
      assertionUri,
      blobHash,
      offset: 0,
      totalBytes: 100,
      truncated: false,
      bytesB64: Buffer.from('# Partial But Claims Complete\n').toString('base64'),
    }));

    await expect(SourceBlobMethods.prototype.fetchImportedSourceBlobFromPeer.call(
      requestAgent as any,
      'peer-source',
      { contextGraphId, assertionUri, blobHash, maxBytes: 1024 },
    )).rejects.toThrow(/inconsistent pagination metadata/);

    requestAgent.messenger.sendToPeer = vi.fn(async () => encodeImportedSourceBlobResponse({
      version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
      contextGraphId: 'other-cg',
      assertionUri,
      blobHash,
      offset: 0,
      bytesB64: '',
    }));

    await expect(SourceBlobMethods.prototype.fetchImportedSourceBlobFromPeer.call(
      requestAgent as any,
      'peer-source',
      { contextGraphId, assertionUri, blobHash, maxBytes: 1024 },
    )).rejects.toThrow(/does not match request/);

    requestAgent.messenger.sendToPeer = vi.fn(async () => encodeImportedSourceBlobResponse({
      version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
      contextGraphId: '',
      assertionUri: '',
      blobHash: `keccak256:${'0'.repeat(64)}`,
      offset: 0,
      denied: 'malformed request: invalid JSON',
    }));

    await expect(SourceBlobMethods.prototype.fetchImportedSourceBlobFromPeer.call(
      requestAgent as any,
      'peer-source',
      { contextGraphId, assertionUri, blobHash, maxBytes: 1024 },
    )).resolves.toEqual({ denied: 'malformed request: invalid JSON' });
  });

  it('returns partial fetch response bytes without whole-blob hash verification', async () => {
    const contextGraphId = 'cg-fetch-paged';
    const assertionUri = 'did:dkg:context-graph:cg-fetch-paged/assertion/did:dkg:agent:source/imported-md';
    const fullBytes = Buffer.from('# Paged\n\nFirst page then second page\n');
    const pageBytes = fullBytes.subarray(0, 12);
    const blobHash = hash(fullBytes);
    const requestAgent = {
      buildImportedSourceBlobAuthEnvelope: vi.fn(async () => new Uint8Array([1])),
      messenger: {
        sendToPeer: vi.fn(async () => encodeImportedSourceBlobResponse({
          version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
          contextGraphId,
          assertionUri,
          blobHash,
          offset: 0,
          totalBytes: fullBytes.length,
          nextOffset: pageBytes.length,
          truncated: true,
          bytesB64: pageBytes.toString('base64'),
        })),
      },
    };

    const fetched = await SourceBlobMethods.prototype.fetchImportedSourceBlobFromPeer.call(
      requestAgent as any,
      'peer-source',
      { contextGraphId, assertionUri, blobHash, maxBytes: pageBytes.length },
    );

    expect(Buffer.from(fetched.bytes ?? new Uint8Array())).toEqual(pageBytes);
    expect(fetched.totalBytes).toBe(fullBytes.length);
    expect(fetched.nextOffset).toBe(pageBytes.length);
    expect(fetched.truncated).toBe(true);
  });

  it('rejects oversized fetch responses even when response metadata omits truncation', async () => {
    const contextGraphId = 'cg-fetch-oversized';
    const assertionUri = 'did:dkg:context-graph:cg-fetch-oversized/assertion/did:dkg:agent:source/imported-md';
    const blobHash = `keccak256:${'b'.repeat(64)}`;
    const requestAgent = {
      buildImportedSourceBlobAuthEnvelope: vi.fn(async () => new Uint8Array([1])),
      messenger: {
        sendToPeer: vi.fn(async () => encodeImportedSourceBlobResponse({
          version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
          contextGraphId,
          assertionUri,
          blobHash,
          offset: 0,
          bytesB64: Buffer.alloc(2048, 0x61).toString('base64'),
        })),
      },
    };

    await expect(SourceBlobMethods.prototype.fetchImportedSourceBlobFromPeer.call(
      requestAgent as any,
      'peer-source',
      { contextGraphId, assertionUri, blobHash, maxBytes: 1024 },
    )).rejects.toThrow(/exceeds requested maxBytes/);
  });
});
