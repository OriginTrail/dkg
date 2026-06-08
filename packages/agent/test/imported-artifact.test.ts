import { describe, expect, it, vi } from 'vitest';
import {
  IMPORTED_ARTIFACT_AUTH_PURPOSE,
  computeImportedArtifactSelector,
  ImportedArtifactMethods,
  type ImportedArtifactRequest,
} from '../src/imported-artifact.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

const contextGraphId = 'cg-artifact';
const assertionUri = `did:dkg:context-graph:${contextGraphId}/assertion/did:dkg:agent:owner/imported`;
const hash = `keccak256:${'a'.repeat(64)}`;

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
}) {
  const authorizeSyncRequest = vi.fn(async () => args.authorize ?? true);
  return {
    peerId: 'peer-local',
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
});
