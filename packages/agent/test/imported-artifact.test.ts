import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  IMPORTED_ARTIFACT_AUTH_PURPOSE,
  IMPORTED_ARTIFACT_MAX_PAGE_BYTES,
  computeImportedArtifactSelector,
  ImportedArtifactMethods,
  type ImportedArtifactRequest,
} from '../src/imported-artifact.js';
import { DKGAgent } from '../src/dkg-agent.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

const contextGraphId = 'cg-artifact';
const assertionUri = `did:dkg:context-graph:${contextGraphId}/assertion/did:dkg:agent:owner/imported`;
const hash = `keccak256:${'a'.repeat(64)}`;

function keccakHash(bytes: Buffer): string {
  return `keccak256:${ethers.keccak256(bytes).replace(/^0x/, '')}`;
}

function expectedSelector(payload: Record<string, unknown>): string {
  return `imported-artifact:v1:${ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)))}`;
}

function request(overrides: Partial<ImportedArtifactRequest> = {}): ImportedArtifactRequest {
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
    requesterAgentAddress: 'did:dkg:agent:owner',
    authPurpose: IMPORTED_ARTIFACT_AUTH_PURPOSE,
    authSelector: selector,
  };
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
    const res = await invoke(agent, request());

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

  it('denies requesterPeerId/fromPeerId mismatches before artifact resolution', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });
    const res = await invoke(agent, request(), 'peer-other');

    expect(agent.authorizeSyncRequest).not.toHaveBeenCalled();
    expect(agent.store.query).not.toHaveBeenCalled();
    expect(res.denied).toBe('denied');
  });

  it('denies targetPeerId mismatches before artifact resolution', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });
    const req = request();
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
    const tampered = request();
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
    const res = await invoke(agent, request());

    expect(agent.authorizeSyncRequest).toHaveBeenCalledTimes(1);
    expect(res.hashMismatch).toBe(true);
  });

  it('denies non-owner artifact reads even when context graph sync auth passes', async () => {
    const agent = fakeAgent({ bytes: Buffer.from('abcdef') });
    const nonOwner = request();
    const syncReq = JSON.parse(Buffer.from(nonOwner.authB64, 'base64').toString('utf8')) as SyncRequestEnvelope;
    syncReq.requesterAgentAddress = 'did:dkg:agent:other';
    nonOwner.authB64 = Buffer.from(JSON.stringify(syncReq)).toString('base64');
    const res = await invoke(agent, nonOwner);

    expect(agent.authorizeSyncRequest).toHaveBeenCalledTimes(1);
    expect(agent.store.query).not.toHaveBeenCalled();
    expect(res.denied).toBe('denied');
  });

  it('allows non-owner artifact reads on public + open context graphs', async () => {
    const agent = fakeAgent({
      bytes: Buffer.from('abcdef'),
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });
    const nonOwner = request();
    const syncReq = JSON.parse(Buffer.from(nonOwner.authB64, 'base64').toString('utf8')) as SyncRequestEnvelope;
    syncReq.requesterAgentAddress = 'did:dkg:agent:other';
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
    const res = await invoke(agent, request({ kind: 'markdown', hash: markdownHash, maxBytes: 8 }));

    expect(res).toMatchObject({
      kind: 'markdown',
      hash: markdownHash,
      contentType: 'text/markdown',
      bytesB64: Buffer.from('markdown').toString('base64'),
    });
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

  it('verifies the full remote artifact before returning bytes even when cache is false', async () => {
    const bytes = Buffer.from('abcdef');
    const artifactHash = keccakHash(bytes);
    const agent = {
      readAssertionArtifact: vi.fn(async () => ({
        version: 1,
        contextGraphId,
        assertionUri,
        kind: 'source',
        hash: artifactHash,
        offset: 0,
        totalBytes: bytes.length,
        truncated: false,
        bytesB64: bytes.toString('base64'),
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
    expect(res.verifiedBytes?.equals(bytes)).toBe(true);
    expect(agent.readAssertionArtifact).toHaveBeenCalledWith(expect.objectContaining({
      offset: 0,
      maxBytes: IMPORTED_ARTIFACT_MAX_PAGE_BYTES,
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
