import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN,
  IMPORTED_ARTIFACT_BYTE_KIND_ORIGINAL,
  IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
  IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  contextGraphSharedMemoryUri,
} from '@origintrail-official/dkg-core';
import { FileStore } from '../src/file-store.js';
import { handleAssertionRoutes } from '../src/daemon/routes/assertion.js';

type OriginResponse = {
  status: (typeof IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS)[keyof typeof IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS];
  hash: string;
  kind: string;
  bytes: Uint8Array;
  reason?: string;
  actualHash?: string;
  contentType?: string;
  size?: number;
};

type FakeRes = {
  writableEnded: boolean;
  headersSent: boolean;
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  chunks: Buffer[];
  setHeader: (key: string, value: string | number | string[]) => void;
  writeHead: (status: number, headers?: Record<string, string | number | string[]>) => FakeRes;
  end: (chunk?: string | Uint8Array) => void;
};

function keccakHash(bytes: Buffer): string {
  return `keccak256:${ethers.keccak256(bytes).replace(/^0x/, '')}`;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    writableEnded: false,
    headersSent: false,
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader(key, value) {
      res.headers[key] = value;
    },
    writeHead(status, headers) {
      res.statusCode = status;
      if (headers) Object.assign(res.headers, headers);
      res.headersSent = true;
      return res;
    },
    end(chunk) {
      if (typeof chunk === 'string') res.chunks.push(Buffer.from(chunk));
      else if (chunk) res.chunks.push(Buffer.from(chunk));
      res.headersSent = true;
      res.writableEnded = true;
    },
  };
  return res;
}

function makeReq(method: string, path: string, body?: Record<string, unknown>): IncomingMessage {
  return {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    __dkgPrebufferedBody: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0),
  } as unknown as IncomingMessage;
}

describe('import artifact read-file route', () => {
  let tempDir: string;
  let fileStore: FileStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dkg-import-artifact-read-file-'));
    fileStore = new FileStore(join(tempDir, 'files'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function dispatch(
    agent: any,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) {
    const url = new URL(path, 'http://127.0.0.1');
    const res = makeRes();
    await handleAssertionRoutes({
      req: makeReq(method, url.pathname, body),
      res: res as unknown as ServerResponse,
      agent,
      publisherControl: {},
      publisherRuntime: null,
      config: {},
      startedAt: Date.now(),
      dashDb: {},
      opWallets: {},
      network: {},
      tracker: {},
      memoryManager: {},
      bridgeAuthToken: undefined,
      nodeVersion: 'test',
      nodeCommit: 'test',
      catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
      extractionRegistry: {},
      fileStore,
      extractionStatus: new Map(),
      assertionImportLocks: new Map(),
      vectorStore: {},
      embeddingProvider: null,
      validTokens: new Set(),
      apiHost: '127.0.0.1',
      apiPortRef: { value: 0 },
      url,
      path: url.pathname,
      requestToken: undefined,
      requestAgentAddress: 'did:dkg:agent:test',
    } as any);
    if (!res.writableEnded) {
      res.statusCode = 404;
      res.end();
    }
    const rawBody = Buffer.concat(res.chunks).toString('utf8');
    return {
      status: res.statusCode,
      body: rawBody ? JSON.parse(rawBody) : undefined,
    };
  }

  function makeAgent(args: {
    contextGraphId: string;
    assertionUri: string;
    sourceHash: string;
    markdownHash?: string;
    contentType?: string;
    policy?: { accessPolicy?: number; publishPolicy?: number };
    originPeerId?: string | null;
    originResponse?: OriginResponse;
    originError?: Error;
  }) {
    const originRequests: Array<{ peerId: string; request: Record<string, unknown> }> = [];
    const originResolutions: string[] = [];
    const agent = {
      async getContextGraphOnChainPolicy() {
        return args.policy ?? { accessPolicy: 0, publishPolicy: 1 };
      },
      async resolveImportedArtifactBytePeerId(agentAddress: string) {
        originResolutions.push(agentAddress);
        return args.originPeerId ?? null;
      },
      async requestImportedArtifactBytesFromPeer(peerId: string, request: Record<string, unknown>) {
        originRequests.push({ peerId, request });
        if (args.originError) throw args.originError;
        return args.originResponse;
      },
      store: {
        async query(sparql: string) {
          if (sparql.includes('SELECT ?fileHash')) {
            expect(sparql).toContain(`<${contextGraphMetaUri(args.contextGraphId)}>`);
            return {
              type: 'bindings',
              bindings: [{
                fileHash: args.sourceHash,
                contentType: args.contentType ?? 'application/pdf',
                rootEntity: 'urn:doc:imported',
                structuralTripleCount: '3',
                semanticTripleCount: '0',
                extractionMethod: 'markitdown',
                extractionStatus: 'completed',
                ...(args.markdownHash ? { mdIntermediateHash: args.markdownHash } : {}),
              }],
            };
          }
          if (sparql.includes('SELECT ?sourceFile')) {
            expect(sparql).toContain(`<${contextGraphSharedMemoryUri(args.contextGraphId)}>`);
            return {
              type: 'bindings',
              bindings: [{
                sourceFile: `urn:dkg:file:${args.sourceHash}`,
                contentType: args.contentType ?? 'application/pdf',
                rootEntity: args.assertionUri,
                ...(args.markdownHash ? { markdownForm: `urn:dkg:file:${args.markdownHash}` } : {}),
              }],
            };
          }
          if (sparql.includes('?markdownForm')) {
            expect(sparql).toContain(`GRAPH <${args.assertionUri}>`);
            return {
              type: 'bindings',
              bindings: args.markdownHash
                ? [{ markdownForm: `urn:dkg:file:${args.markdownHash}` }]
                : [],
            };
          }
          if (sparql.includes('SELECT ?p ?o')) {
            return { type: 'bindings', bindings: [] };
          }
          throw new Error(`unexpected query: ${sparql}`);
        },
      },
    };
    return { agent, originRequests, originResolutions };
  }

  it('fetches and caches missing public + open non-owner source bytes from the origin peer', async () => {
    const sourceBytes = Buffer.from('%PDF-source\n');
    const sourceHash = keccakHash(sourceBytes);
    const contextGraphId = 'cg-public-open-source-bytes';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', 'imported-pdf');
    const { agent, originRequests, originResolutions } = makeAgent({
      contextGraphId,
      assertionUri,
      sourceHash,
      originPeerId: 'peer-source',
      originResponse: {
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW,
        hash: sourceHash,
        kind: IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
        bytes: sourceBytes,
        contentType: 'application/pdf',
        size: sourceBytes.length,
      },
    });

    const read = await dispatch(agent, 'POST', '/api/assertion/import-artifact/read-file', {
      contextGraphId,
      assertionUri,
    });

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      kind: IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
      hash: sourceHash,
      fileHash: sourceHash,
      sourceFileHash: sourceHash,
      contentType: 'application/pdf',
      bytes: sourceBytes.length,
      contentBase64: sourceBytes.toString('base64'),
    });
    expect(await fileStore.has(sourceHash)).toBe(true);
    expect(originResolutions).toEqual(['did:dkg:agent:source']);
    expect(originRequests).toEqual([{
      peerId: 'peer-source',
      request: {
        contextGraphId,
        assertionUri,
        hash: sourceHash,
        kind: IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
      },
    }]);
  });

  it('rejects oversized origin source bytes before caching them', async () => {
    const sourceBytes = Buffer.from('oversized source bytes');
    const sourceHash = keccakHash(sourceBytes);
    const contextGraphId = 'cg-public-open-source-bytes-max';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', 'imported-pdf');
    const { agent, originRequests } = makeAgent({
      contextGraphId,
      assertionUri,
      sourceHash,
      originPeerId: 'peer-source',
      originResponse: {
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW,
        hash: sourceHash,
        kind: IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
        bytes: sourceBytes,
        contentType: 'application/pdf',
        size: sourceBytes.length,
      },
    });

    const read = await dispatch(agent, 'POST', '/api/assertion/import-artifact/read-file', {
      contextGraphId,
      assertionUri,
      maxBytes: 4,
    });

    expect(read.status).toBe(413);
    expect(read.body.error).toMatch(/maxBytes \(4\)/);
    expect(originRequests).toHaveLength(1);
    expect(await fileStore.has(sourceHash)).toBe(false);
  });

  it('accepts explicit original kind and hash for source bytes', async () => {
    const sourceBytes = Buffer.from('original bytes');
    const entry = await fileStore.put(sourceBytes, 'text/plain');
    const contextGraphId = 'cg-original-kind-local';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', 'imported-original');
    const { agent, originRequests } = makeAgent({
      contextGraphId,
      assertionUri,
      sourceHash: entry.keccak256,
      contentType: 'text/plain',
    });

    const read = await dispatch(agent, 'POST', '/api/assertion/import-artifact/read-file', {
      contextGraphId,
      assertionUri,
      kind: IMPORTED_ARTIFACT_BYTE_KIND_ORIGINAL,
      hash: entry.keccak256,
    });

    expect(read.status).toBe(200);
    expect(read.body.kind).toBe(IMPORTED_ARTIFACT_BYTE_KIND_ORIGINAL);
    expect(read.body.contentBase64).toBe(sourceBytes.toString('base64'));
    expect(originRequests).toHaveLength(0);
  });

  it('keeps read-markdown fetching and caching missing markdown bytes', async () => {
    const sourceBytes = Buffer.from('%PDF-source\n');
    const markdownBytes = Buffer.from('# Converted\n');
    const sourceHash = keccakHash(sourceBytes);
    const markdownHash = keccakHash(markdownBytes);
    const contextGraphId = 'cg-public-open-markdown-bytes';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', 'imported-pdf');
    const { agent, originRequests } = makeAgent({
      contextGraphId,
      assertionUri,
      sourceHash,
      markdownHash,
      originPeerId: 'peer-source',
      originResponse: {
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW,
        hash: markdownHash,
        kind: IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN,
        bytes: markdownBytes,
        contentType: 'text/markdown',
        size: markdownBytes.length,
      },
    });

    const read = await dispatch(agent, 'POST', '/api/assertion/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri,
    });

    expect(read.status).toBe(200);
    expect(read.body.markdown).toBe('# Converted\n');
    expect(await fileStore.has(markdownHash)).toBe(true);
    expect(originRequests[0].request).toMatchObject({
      hash: markdownHash,
      kind: IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN,
    });
  });

  it('rejects oversized origin markdown bytes before caching them', async () => {
    const sourceBytes = Buffer.from('%PDF-source\n');
    const markdownBytes = Buffer.from('# Converted markdown that is too large\n');
    const sourceHash = keccakHash(sourceBytes);
    const markdownHash = keccakHash(markdownBytes);
    const contextGraphId = 'cg-public-open-markdown-bytes-max';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', 'imported-pdf');
    const { agent, originRequests } = makeAgent({
      contextGraphId,
      assertionUri,
      sourceHash,
      markdownHash,
      originPeerId: 'peer-source',
      originResponse: {
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW,
        hash: markdownHash,
        kind: IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN,
        bytes: markdownBytes,
        contentType: 'text/markdown',
        size: markdownBytes.length,
      },
    });

    const read = await dispatch(agent, 'POST', '/api/assertion/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri,
      maxBytes: 4,
    });

    expect(read.status).toBe(413);
    expect(read.body.error).toMatch(/maxBytes \(4\)/);
    expect(originRequests).toHaveLength(1);
    expect(await fileStore.has(markdownHash)).toBe(false);
  });

  it('maps origin deny to 403', async () => {
    const sourceHash = keccakHash(Buffer.from('source'));
    const contextGraphId = 'cg-origin-deny';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', 'imported-denied');
    const { agent } = makeAgent({
      contextGraphId,
      assertionUri,
      sourceHash,
      originPeerId: 'peer-source',
      originResponse: {
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.DENY,
        hash: sourceHash,
        kind: IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
        bytes: new Uint8Array(0),
        reason: 'not authorized',
      },
    });

    const read = await dispatch(agent, 'POST', '/api/assertion/import-artifact/read-file', {
      contextGraphId,
      assertionUri,
    });

    expect(read.status).toBe(403);
    expect(read.body.error).toMatch(/denied/);
    expect(read.body.error).toMatch(/not authorized/);
  });

  it.each([
    ['origin miss', {
      originResponse: {
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.MISS,
        hash: '',
        kind: IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
        bytes: new Uint8Array(0),
        reason: 'not local',
      } as OriginResponse,
    }],
    ['origin unreachable', { originError: new Error('timeout') }],
  ])('maps %s to 404', async (_label, overrides) => {
    const sourceHash = keccakHash(Buffer.from('source'));
    const contextGraphId = `cg-${_label.replace(/\s+/g, '-')}`;
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', 'imported-miss');
    if (overrides.originResponse) overrides.originResponse.hash = sourceHash;
    const { agent } = makeAgent({
      contextGraphId,
      assertionUri,
      sourceHash,
      originPeerId: 'peer-source',
      ...overrides,
    });

    const read = await dispatch(agent, 'POST', '/api/assertion/import-artifact/read-file', {
      contextGraphId,
      assertionUri,
    });

    expect(read.status).toBe(404);
    expect(read.body.error).toMatch(/origin/i);
  });

  it('maps origin hash_mismatch to 502', async () => {
    const sourceHash = keccakHash(Buffer.from('source'));
    const contextGraphId = 'cg-origin-hash-mismatch';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', 'imported-mismatch');
    const { agent } = makeAgent({
      contextGraphId,
      assertionUri,
      sourceHash,
      originPeerId: 'peer-source',
      originResponse: {
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.HASH_MISMATCH,
        hash: sourceHash,
        kind: IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
        bytes: new Uint8Array(0),
        actualHash: `keccak256:${'f'.repeat(64)}`,
      },
    });

    const read = await dispatch(agent, 'POST', '/api/assertion/import-artifact/read-file', {
      contextGraphId,
      assertionUri,
    });

    expect(read.status).toBe(502);
    expect(read.body.error).toMatch(/hash mismatch/);
  });

  it.each([
    ['private', { accessPolicy: 1, publishPolicy: 1 }],
    ['curated', { accessPolicy: 0, publishPolicy: 0 }],
  ])('keeps non-owner %s CG reads owner-gated', async (_label, policy) => {
    const sourceHash = keccakHash(Buffer.from('source'));
    const contextGraphId = `cg-${_label}-source-read`;
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', 'imported-private');
    const { agent, originRequests } = makeAgent({
      contextGraphId,
      assertionUri,
      sourceHash,
      policy,
      originPeerId: 'peer-source',
    });

    const read = await dispatch(agent, 'POST', '/api/assertion/import-artifact/read-file', {
      contextGraphId,
      assertionUri,
    });

    expect(read.status).toBe(403);
    expect(read.body.error).toMatch(/owned by the requesting agent/);
    expect(originRequests).toHaveLength(0);
  });

  it('rejects markdown kind on read-file', async () => {
    const sourceHash = keccakHash(Buffer.from('source'));
    const contextGraphId = 'cg-reject-markdown-read-file';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', 'imported-source');
    const { agent, originRequests } = makeAgent({ contextGraphId, assertionUri, sourceHash });

    const read = await dispatch(agent, 'POST', '/api/assertion/import-artifact/read-file', {
      contextGraphId,
      assertionUri,
      kind: IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN,
    });

    expect(read.status).toBe(400);
    expect(read.body.error).toMatch(/read-markdown/);
    expect(originRequests).toHaveLength(0);
  });

  it('keeps bare GET /api/file/:hash local-only', async () => {
    const sourceBytes = Buffer.from('remote only');
    const sourceHash = keccakHash(sourceBytes);
    const contextGraphId = 'cg-bare-file-local-only';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', 'imported-remote');
    const { agent, originRequests } = makeAgent({
      contextGraphId,
      assertionUri,
      sourceHash,
      originPeerId: 'peer-source',
      originResponse: {
        status: IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW,
        hash: sourceHash,
        kind: IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
        bytes: sourceBytes,
      },
    });

    const read = await dispatch(agent, 'GET', `/api/file/${encodeURIComponent(sourceHash)}`);

    expect(read.status).toBe(404);
    expect(read.body.error).toContain('File not found');
    expect(originRequests).toHaveLength(0);
    expect(await fileStore.has(sourceHash)).toBe(false);
  });
});
