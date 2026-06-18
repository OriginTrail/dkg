import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  IMPORTED_ARTIFACT_AUTH_PURPOSE,
  IMPORTED_ARTIFACT_MAX_PAGE_BYTES,
  PROTOCOL_GET_ASSERTION_ARTIFACT,
  computeImportedArtifactSelector,
  ImportedArtifactMethods,
  type ImportedArtifactRequest,
} from '../src/imported-artifact.js';
import { DKGAgent } from '../src/dkg-agent.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

const contextGraphId = 'cg-artifact';
const ownerWallet = ethers.Wallet.createRandom();
const otherWallet = ethers.Wallet.createRandom();
const ownerAgentAddress = ownerWallet.address;
const otherAgentAddress = otherWallet.address;
const assertionUri = `did:dkg:context-graph:${contextGraphId}/assertion/${ownerAgentAddress}/imported`;
const hash = `keccak256:${'a'.repeat(64)}`;

function keccakHash(bytes: Buffer): string {
  return `keccak256:${ethers.keccak256(bytes).replace(/^0x/, '')}`;
}

function expectedSelector(payload: Record<string, unknown>): string {
  return `imported-artifact:v1:${ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)))}`;
}

function computeSyncDigest(
  contextGraphId: string,
  offset: number,
  limit: number,
  includeSharedMemory: boolean,
  targetPeerId: string,
  requesterPeerId: string | undefined,
  requestId: string | undefined,
  issuedAtMs: number | undefined,
  requesterAgentAddress: string | undefined,
  authPurpose?: string,
  authSelector?: string,
): Uint8Array {
  const types = ['string', 'uint256', 'uint256', 'bool', 'string', 'string', 'string', 'uint256', 'string'];
  const values: Array<string | bigint | boolean> = [
    contextGraphId,
    BigInt(offset),
    BigInt(limit),
    includeSharedMemory,
    targetPeerId,
    requesterPeerId ?? '',
    requestId ?? '',
    BigInt(issuedAtMs ?? 0),
    (requesterAgentAddress ?? '').toLowerCase(),
  ];
  if (authPurpose || authSelector) {
    types.push('string', 'string');
    values.push(authPurpose ?? '', authSelector ?? '');
  }
  return ethers.getBytes(ethers.solidityPackedKeccak256(types, values));
}

async function signSyncRequest(syncReq: SyncRequestEnvelope, signer: ethers.Wallet): Promise<void> {
  const digest = computeSyncDigest(
    syncReq.contextGraphId,
    syncReq.offset,
    syncReq.limit,
    syncReq.includeSharedMemory,
    syncReq.targetPeerId,
    syncReq.requesterPeerId,
    syncReq.requestId,
    syncReq.issuedAtMs,
    syncReq.requesterAgentAddress,
    syncReq.authPurpose,
    syncReq.authSelector,
  );
  const sig = ethers.Signature.from(await signer.signMessage(digest));
  syncReq.requesterIdentityId = '0';
  syncReq.requesterSignatureR = sig.r;
  syncReq.requesterSignatureVS = sig.yParityAndS;
}

async function request(overrides: Partial<ImportedArtifactRequest> = {}, opts: {
  requesterAgentAddress?: string;
  signer?: ethers.Wallet;
} = {}): Promise<ImportedArtifactRequest> {
  const base = {
    version: 1 as const,
    contextGraphId,
    assertionUri,
    kind: 'source' as const,
    hash,
    offset: 0,
    maxBytes: 4,
  };
  const selector = computeImportedArtifactSelector({ ...base, ...overrides });
  const syncReq: SyncRequestEnvelope = {
    contextGraphId,
    offset: 0,
    limit: 1,
    includeSharedMemory: false,
    targetPeerId: 'peer-local',
    requesterPeerId: 'peer-remote',
    requestId: 'req-1',
    issuedAtMs: Date.now(),
    requesterAgentAddress: opts.requesterAgentAddress ?? ownerAgentAddress,
    authPurpose: IMPORTED_ARTIFACT_AUTH_PURPOSE,
    authSelector: selector,
  };
  if (opts.signer) {
    await signSyncRequest(syncReq, opts.signer);
  }
  return {
    ...base,
    authB64: Buffer.from(JSON.stringify(syncReq)).toString('base64'),
    ...overrides,
  };
}

function fakeAgent(args: {
  authorize?: boolean;
  queryBindings?: Array<Record<string, unknown>>;
  bytes?: Buffer;
  onChainPolicy?: { accessPolicy?: number; publishPolicy?: number };
}) {
  const authorizeSyncRequest = vi.fn(async (
    syncReq: SyncRequestEnvelope,
    remotePeerId: string,
  ) => (args.authorize ?? true) &&
    syncReq.targetPeerId === 'peer-local' &&
    syncReq.requesterPeerId === remotePeerId);
  return {
    peerId: 'peer-local',
    localAgents: new Map(),
    chain: {
      getIdentityId: vi.fn(async () => 0n),
    },
    config: {
      importedArtifactByteStore: {
        stat: vi.fn(async () => ({ size: args.bytes?.length ?? 0 })),
        readRange: vi.fn(async (_hash: string, offset: number, length: number) =>
          (args.bytes ?? Buffer.alloc(0)).subarray(offset, offset + length)),
      },
    },
    node: {
      libp2p: {
        getPeers: vi.fn(() => [
          { toString: () => 'peer-local' },
          { toString: () => 'peer-a' },
          { toString: () => 'peer-a' },
          { toString: () => 'peer-b' },
        ]),
      },
    },
    store: {
      query: vi.fn(async () => ({
        type: 'bindings',
        bindings: args.queryBindings ?? [{
          fileHash: hash,
          contentType: 'text/markdown',
          extractionStatus: 'completed',
          structuralTripleCount: '3',
        }],
      })),
    },
    parseSyncRequest: (data: Uint8Array) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
    computeSyncDigest,
    authorizeSyncRequest,
    getContextGraphOnChainPolicy: args.onChainPolicy
      ? vi.fn(async () => args.onChainPolicy)
      : vi.fn(async () => ({})),
    findLocalAgentForContextGraph: vi.fn(async () => 'did:dkg:agent:owner'),
    sendToPeer: vi.fn(async () => new TextEncoder().encode(JSON.stringify({
      version: 1,
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
      offset: 0,
      bytesB64: Buffer.from('ok').toString('base64'),
    }))),
    log: { warn: vi.fn() },
  };
}

async function invoke(agent: any, req: ImportedArtifactRequest, fromPeerId = 'peer-remote') {
  const bytes = await ImportedArtifactMethods.prototype.handleGetImportedArtifact.call(
    agent,
    new TextEncoder().encode(JSON.stringify(req)),
    fromPeerId,
  );
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe('generic imported artifact peer handler', () => {
  it('keeps no-subgraph selectors compatible with the original canonical payload', () => {
    const payload = {
      version: 1 as const,
      contextGraphId,
      assertionUri,
      kind: 'source' as const,
      hash,
      offset: 0,
      maxBytes: 4,
    };

    expect(computeImportedArtifactSelector(payload)).toBe(expectedSelector(payload));
  });

  it('binds non-empty subGraphName into the selector canonical payload', () => {
    const base = {
      version: 1 as const,
      contextGraphId,
      assertionUri,
      kind: 'source' as const,
      hash,
      offset: 0,
      maxBytes: 4,
    };
    const withSubGraph = { ...base, subGraphName: 'research' };

    expect(computeImportedArtifactSelector(withSubGraph)).toBe(expectedSelector(withSubGraph));
    expect(computeImportedArtifactSelector(withSubGraph)).not.toBe(computeImportedArtifactSelector(base));
  });

  it('reuses authorizeSyncRequest before serving bounded bytes', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });
    const res = await invoke(agent, await request({}, { signer: ownerWallet }));

    expect(agent.authorizeSyncRequest).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      version: 1,
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
      offset: 0,
      totalBytes: 6,
      nextOffset: 4,
      truncated: true,
      bytesB64: Buffer.from('abcd').toString('base64'),
    });
  });

  it('clamps oversized byte-store reads to the requested protocol page', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });
    agent.config.importedArtifactByteStore.readRange = vi.fn(async () => Buffer.from('abcdef'));
    const res = await invoke(agent, await request({ maxBytes: 4 }, { signer: ownerWallet }));

    expect(agent.config.importedArtifactByteStore.readRange).toHaveBeenCalledWith(hash, 0, 4);
    expect(res).toMatchObject({
      totalBytes: 6,
      nextOffset: 4,
      truncated: true,
      bytesB64: Buffer.from('abcd').toString('base64'),
    });
    expect(Buffer.from(res.bytesB64, 'base64').byteLength).toBe(4);
  });

  it('denies requesterPeerId/fromPeerId mismatches before artifact resolution', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });
    const res = await invoke(agent, await request({}, { signer: ownerWallet }), 'peer-other');

    expect(agent.authorizeSyncRequest).not.toHaveBeenCalled();
    expect(agent.store.query).not.toHaveBeenCalled();
    expect(res.denied).toBe('denied');
  });

  it('denies targetPeerId mismatches before artifact resolution', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });
    const req = await request({}, { signer: ownerWallet });
    const syncReq = JSON.parse(Buffer.from(req.authB64, 'base64').toString('utf8')) as SyncRequestEnvelope;
    syncReq.targetPeerId = 'peer-other';
    req.authB64 = Buffer.from(JSON.stringify(syncReq)).toString('base64');
    const res = await invoke(agent, req);

    expect(agent.authorizeSyncRequest).not.toHaveBeenCalled();
    expect(agent.store.query).not.toHaveBeenCalled();
    expect(res.denied).toBe('denied');
  });

  it('denies subGraphName tampering before artifact resolution', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });
    const tampered = await request({}, { signer: ownerWallet });
    tampered.subGraphName = 'other-subgraph';
    const res = await invoke(agent, tampered);

    expect(agent.authorizeSyncRequest).not.toHaveBeenCalled();
    expect(agent.store.query).not.toHaveBeenCalled();
    expect(res.denied).toBe('denied');
  });

  it('returns hashMismatch only after authorization and metadata linkage check', async () => {
    const agent = fakeAgent({
      bytes: Buffer.from('abcdef'),
      queryBindings: [{
        fileHash: `keccak256:${'b'.repeat(64)}`,
        contentType: 'text/markdown',
        extractionStatus: 'completed',
        structuralTripleCount: '3',
      }],
    });
    const res = await invoke(agent, await request({}, { signer: ownerWallet }));

    expect(agent.authorizeSyncRequest).toHaveBeenCalledTimes(1);
    expect(res.hashMismatch).toBe(true);
  });

  it('denies non-owner artifact reads even when context graph sync auth passes', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });
    const nonOwner = await request({}, {
      requesterAgentAddress: otherAgentAddress,
      signer: otherWallet,
    });
    const res = await invoke(agent, nonOwner);

    expect(agent.authorizeSyncRequest).toHaveBeenCalledTimes(1);
    expect(agent.store.query).not.toHaveBeenCalled();
    expect(res.denied).toBe('denied');
  });

  it('denies forged owner claims on direct artifact reads without selector-bound owner proof', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });
    const forgedOwner = await request();
    const res = await invoke(agent, forgedOwner);

    expect(agent.authorizeSyncRequest).toHaveBeenCalledTimes(1);
    expect(agent.store.query).not.toHaveBeenCalled();
    expect(res.denied).toBe('denied');
  });

  it('allows non-owner artifact reads on public + open context graphs', async () => {
    const agent = fakeAgent({
      bytes: Buffer.from('abcdef'),
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });
    const nonOwner = await request();
    const syncReq = JSON.parse(Buffer.from(nonOwner.authB64, 'base64').toString('utf8')) as SyncRequestEnvelope;
    syncReq.requesterAgentAddress = otherAgentAddress;
    nonOwner.authB64 = Buffer.from(JSON.stringify(syncReq)).toString('base64');
    const res = await invoke(agent, nonOwner);

    expect(agent.authorizeSyncRequest).toHaveBeenCalledTimes(1);
    expect(res.bytesB64).toBe(Buffer.from('abcd').toString('base64'));
  });

  it('serves markdown via mdIntermediateHash and not source-specific naming', async () => {
    const markdownHash = `keccak256:${'c'.repeat(64)}`;
    const agent = fakeAgent({
      bytes: Buffer.from('markdown page'),
      queryBindings: [{
        fileHash: hash,
        mdIntermediateHash: markdownHash,
        contentType: 'application/pdf',
        extractionStatus: 'completed',
        structuralTripleCount: '3',
      }],
    });
    const res = await invoke(agent, await request(
      { kind: 'markdown', hash: markdownHash, maxBytes: 8 },
      { signer: ownerWallet },
    ));

    expect(res).toMatchObject({
      kind: 'markdown',
      hash: markdownHash,
      contentType: 'text/markdown',
      bytesB64: Buffer.from('markdown').toString('base64'),
    });
  });

  it('exposes local availability only for linked imported-artifact bytes', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });

    await expect(ImportedArtifactMethods.prototype.hasLocalAssertionArtifact.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
    })).resolves.toBe(true);

    await expect(ImportedArtifactMethods.prototype.hasLocalAssertionArtifact.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash: `keccak256:${'b'.repeat(64)}`,
    })).resolves.toBe(false);
  });

  it('discovers unique connected artifact candidates without including itself', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });

    await expect(ImportedArtifactMethods.prototype.discoverAssertionArtifactCandidates.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
    })).resolves.toEqual(['peer-a', 'peer-b']);
  });

  it('filters discovered artifact candidates by protocol support when peer protocols are available', async () => {
    const agent = {
      ...fakeAgent({ bytes: Buffer.from('abcdef') }),
      getPeerProtocols: vi.fn(async (peerId: string) =>
        peerId === 'peer-a' ? [PROTOCOL_GET_ASSERTION_ARTIFACT] : ['/other/protocol']),
    };

    await expect(ImportedArtifactMethods.prototype.discoverAssertionArtifactCandidates.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
    })).resolves.toEqual(['peer-a']);
  });

  it('builds unsigned selector-bound requests for public + open artifact reads', async () => {
    const agent = fakeAgent({
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });
    agent.chain.getIdentityId = vi.fn(async () => {
      throw new Error('signing should not be required');
    });

    await ImportedArtifactMethods.prototype.readAssertionArtifact.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
      sourcePeerId: 'peer-local',
    });

    const sent = JSON.parse(new TextDecoder().decode(agent.sendToPeer.mock.calls[0][2]));
    const auth = JSON.parse(Buffer.from(sent.authB64, 'base64').toString('utf8')) as SyncRequestEnvelope;
    expect(auth.requesterSignatureR).toBeUndefined();
    expect(auth.authPurpose).toBe(IMPORTED_ARTIFACT_AUTH_PURPOSE);
    expect(auth.authSelector).toBe(computeImportedArtifactSelector({
      version: 1,
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
      offset: 0,
      maxBytes: 1024 * 1024,
    }));
  });

  it('treats malformed peer artifact responses as unavailable instead of throwing', async () => {
    const agent = fakeAgent({
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });
    agent.sendToPeer = vi.fn(async () => new TextEncoder().encode(JSON.stringify({
      version: 1,
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
      offset: 0,
      bytesB64: 123,
      nextOffset: 'x',
    })));

    const response = await ImportedArtifactMethods.prototype.readAssertionArtifact.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
      sourcePeerId: 'peer-local',
    });

    expect(response).toMatchObject({
      version: 1,
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
      offset: 0,
      unavailable: true,
    });
  });

  it('keeps malformed peer artifact responses in the handled fetch path', async () => {
    const agent = fakeAgent({
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });
    agent.readAssertionArtifact = ImportedArtifactMethods.prototype.readAssertionArtifact;
    agent.sendToPeer = vi.fn(async () => new TextEncoder().encode('{not json'));

    const result = await ImportedArtifactMethods.prototype.fetchAndVerifyAssertionArtifact.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
      sourcePeerId: 'peer-local',
      cache: true,
    });

    expect(result.verifiedBytes).toBeUndefined();
    expect(result.response).toMatchObject({
      unavailable: true,
      contextGraphId,
      assertionUri,
      hash,
    });
  });

  it('signs private artifact requests with the claimed agent key even when an identity signer exists', async () => {
    const agent = fakeAgent({
      onChainPolicy: { accessPolicy: 1, publishPolicy: 0 },
    });
    agent.findLocalAgentForContextGraph = vi.fn(async () => otherAgentAddress);
    agent.localAgents = new Map([[ownerAgentAddress, { privateKey: ownerWallet.privateKey }]]);
    agent.chain.getIdentityId = vi.fn(async () => 123n);
    agent.chain.signMessage = vi.fn(async (digest: Uint8Array) => {
      const sig = ethers.Signature.from(await otherWallet.signMessage(digest));
      return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
    });

    await ImportedArtifactMethods.prototype.readAssertionArtifact.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
      sourcePeerId: 'peer-local',
    });

    const sent = JSON.parse(new TextDecoder().decode(agent.sendToPeer.mock.calls[0][2]));
    const auth = JSON.parse(Buffer.from(sent.authB64, 'base64').toString('utf8')) as SyncRequestEnvelope;
    const digest = computeSyncDigest(
      auth.contextGraphId,
      auth.offset,
      auth.limit,
      auth.includeSharedMemory,
      auth.targetPeerId!,
      auth.requesterPeerId!,
      auth.requestId!,
      auth.issuedAtMs!,
      auth.requesterAgentAddress,
      auth.authPurpose,
      auth.authSelector,
    );
    const recovered = ethers.recoverAddress(ethers.hashMessage(digest), {
      r: auth.requesterSignatureR!,
      yParityAndS: auth.requesterSignatureVS!,
    });

    expect(agent.findLocalAgentForContextGraph).not.toHaveBeenCalled();
    expect(agent.chain.signMessage).not.toHaveBeenCalled();
    expect(auth.requesterIdentityId).toBe('0');
    expect(auth.requesterAgentAddress).toBe(ownerAgentAddress);
    expect(recovered).toBe(ownerAgentAddress);
  });

  it('signs private artifact requests as the assertion owner on multi-agent nodes', async () => {
    const agent = fakeAgent({
      onChainPolicy: { accessPolicy: 1, publishPolicy: 0 },
    });
    agent.findLocalAgentForContextGraph = vi.fn(async () => otherAgentAddress);
    agent.localAgents = new Map([
      [otherAgentAddress, { privateKey: otherWallet.privateKey }],
      [ownerAgentAddress, { privateKey: ownerWallet.privateKey }],
    ]);

    await ImportedArtifactMethods.prototype.readAssertionArtifact.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash,
      sourcePeerId: 'peer-local',
      requestingAgentAddress: `did:dkg:agent:${ownerAgentAddress.toLowerCase()}`,
    });

    const sent = JSON.parse(new TextDecoder().decode(agent.sendToPeer.mock.calls[0][2]));
    const auth = JSON.parse(Buffer.from(sent.authB64, 'base64').toString('utf8')) as SyncRequestEnvelope;
    const digest = computeSyncDigest(
      auth.contextGraphId,
      auth.offset,
      auth.limit,
      auth.includeSharedMemory,
      auth.targetPeerId!,
      auth.requesterPeerId!,
      auth.requestId!,
      auth.issuedAtMs!,
      auth.requesterAgentAddress,
      auth.authPurpose,
      auth.authSelector,
    );
    const recovered = ethers.recoverAddress(ethers.hashMessage(digest), {
      r: auth.requesterSignatureR!,
      yParityAndS: auth.requesterSignatureVS!,
    });

    expect(agent.findLocalAgentForContextGraph).not.toHaveBeenCalled();
    expect(auth.requesterAgentAddress).toBe(ownerAgentAddress);
    expect(recovered).toBe(ownerAgentAddress);
  });

  it('rejects remote pagination that does not advance nextOffset', async () => {
    const bytes = Buffer.from('abcdef');
    const artifactHash = keccakHash(bytes);
    const agent = {
      readAssertionArtifact: vi.fn()
        .mockResolvedValueOnce({
          version: 1,
          contextGraphId,
          assertionUri,
          kind: 'source',
          hash: artifactHash,
          offset: 0,
          totalBytes: bytes.length,
          nextOffset: 3,
          truncated: true,
          bytesB64: Buffer.from('abc').toString('base64'),
        })
        .mockResolvedValueOnce({
          version: 1,
          contextGraphId,
          assertionUri,
          kind: 'source',
          hash: artifactHash,
          offset: 3,
          totalBytes: bytes.length,
          nextOffset: 3,
          truncated: true,
          bytesB64: Buffer.from('def').toString('base64'),
        }),
    };

    const res = await ImportedArtifactMethods.prototype.fetchAndVerifyAssertionArtifact.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash: artifactHash,
      sourcePeerId: 'peer-local',
      cache: true,
    });

    expect(res.response.hashMismatch).toBe(true);
    expect(res.verifiedBytes).toBeUndefined();
    expect(agent.readAssertionArtifact).toHaveBeenCalledTimes(2);
  });

  it('returns the requested remote page without full-artifact verification when cache is false', async () => {
    const bytes = Buffer.from('abcdef');
    const artifactHash = keccakHash(bytes);
    const agent = {
      readAssertionArtifact: vi.fn(async ({ offset = 0, maxBytes = IMPORTED_ARTIFACT_MAX_PAGE_BYTES }) => ({
        version: 1,
        contextGraphId,
        assertionUri,
        kind: 'source',
        hash: artifactHash,
        offset,
        totalBytes: bytes.length,
        nextOffset: offset + Math.min(maxBytes, bytes.length - offset),
        truncated: offset + maxBytes < bytes.length,
        bytesB64: bytes.subarray(offset, offset + maxBytes).toString('base64'),
      })),
    };

    const res = await ImportedArtifactMethods.prototype.fetchAndVerifyAssertionArtifact.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash: artifactHash,
      offset: 1,
      maxBytes: 3,
      sourcePeerId: 'peer-local',
      cache: false,
    });

    expect(res.response.hashMismatch).toBeUndefined();
    expect(res.response.offset).toBe(1);
    expect(res.response.bytesB64).toBe(Buffer.from('bcd').toString('base64'));
    expect(res.verifiedBytes).toBeUndefined();
    expect(agent.readAssertionArtifact).toHaveBeenCalledTimes(1);
    expect(agent.readAssertionArtifact).toHaveBeenCalledWith(expect.objectContaining({
      offset: 1,
      maxBytes: 3,
    }));
  });

  it('serves requested pages for artifacts larger than the cache promotion cap', async () => {
    const firstPage = Buffer.from('first page');
    const requestedPage = Buffer.from('requested page');
    const largeTotal = 64 * 1024 * 1024 + 1;
    const artifactHash = `keccak256:${'d'.repeat(64)}`;
    const agent = {
      readAssertionArtifact: vi.fn()
        .mockResolvedValueOnce({
          version: 1,
          contextGraphId,
          assertionUri,
          kind: 'source',
          hash: artifactHash,
          offset: 0,
          totalBytes: largeTotal,
          nextOffset: firstPage.length,
          truncated: true,
          bytesB64: firstPage.toString('base64'),
        })
        .mockResolvedValueOnce({
          version: 1,
          contextGraphId,
          assertionUri,
          kind: 'source',
          hash: artifactHash,
          offset: 1024,
          totalBytes: largeTotal,
          nextOffset: 1024 + requestedPage.length,
          truncated: true,
          bytesB64: requestedPage.toString('base64'),
        }),
    };

    const res = await ImportedArtifactMethods.prototype.fetchAndVerifyAssertionArtifact.call(agent, {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash: artifactHash,
      offset: 1024,
      maxBytes: 4096,
      sourcePeerId: 'peer-local',
      cache: true,
    });

    expect(res.response.unavailable).toBeUndefined();
    expect(res.response.offset).toBe(1024);
    expect(res.response.bytesB64).toBe(requestedPage.toString('base64'));
    expect(res.verifiedBytes).toBeUndefined();
    expect(agent.readAssertionArtifact).toHaveBeenCalledTimes(2);
    expect(agent.readAssertionArtifact).toHaveBeenNthCalledWith(2, expect.objectContaining({
      offset: 1024,
      maxBytes: 4096,
    }));
  });

  it('registers a configured imported artifact byte store during DKGAgent.create', async () => {
    const store = {
      stat: vi.fn(),
      readRange: vi.fn(),
    };
    const register = vi
      .spyOn(DKGAgent.prototype as DKGAgent, 'registerImportedArtifactByteStore')
      .mockImplementation(function (this: DKGAgent, configuredStore) {
        this.config.importedArtifactByteStore = configuredStore;
      });
    try {
      await DKGAgent.create({
        name: 'ArtifactStoreConfig',
        importedArtifactByteStore: store,
      });
      expect(register).toHaveBeenCalledWith(store);
    } finally {
      register.mockRestore();
    }
  });
});
