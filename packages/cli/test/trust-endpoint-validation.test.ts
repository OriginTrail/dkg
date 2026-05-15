import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';

const VERIFY_COLLECTION_TIMEOUT_MAX_MS = 30 * 60 * 1000;

type CapturedResponse = {
  statusCode?: number;
  body?: string;
  writableEnded?: boolean;
  writeHead: (statusCode: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

function response(): CapturedResponse {
  return {
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
  };
}

function request(path: string, body: unknown): any {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
  req.method = 'POST';
  req.url = path;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

async function callTrustRoute(path: '/api/verify' | '/api/endorse', body: unknown) {
  const req = request(path, body);
  const res = response();
  const agent = {
    verify: vi.fn(async () => {
      throw new Error('agent.verify should not be reached');
    }),
    endorse: vi.fn(async () => {
      throw new Error('agent.endorse should not be reached');
    }),
  };

  await handleQueryRoutes({
    req,
    res,
    agent,
    publisherControl: null,
    publisherRuntime: null,
    config: {},
    startedAt: 0,
    dashDb: null,
    opWallets: {},
    network: {},
    tracker: {},
    memoryManager: null,
    bridgeAuthToken: undefined,
    nodeVersion: 'test',
    nodeCommit: 'test',
    catchupTracker: { latestByContextGraph: new Map(), jobs: new Map() },
    extractionRegistry: null,
    fileStore: null,
    extractionStatus: new Map(),
    assertionImportLocks: new Map(),
    vectorStore: null,
    embeddingProvider: null,
    validTokens: new Set(),
    apiHost: '127.0.0.1',
    apiPortRef: { value: 0 },
    url: new URL(`http://127.0.0.1${path}`),
    path,
    requestToken: undefined,
    requestAgentAddress: '0x0000000000000000000000000000000000000001',
  } as any);

  return {
    status: res.statusCode,
    body: JSON.parse(res.body ?? '{}') as { error?: string },
    agent,
  };
}

describe('trust endpoint input validation', () => {
  it('/api/verify rejects unsafe contextGraphId before agent.verify', async () => {
    const result = await callTrustRoute('/api/verify', {
      contextGraphId: 'cg> } INSERT DATA { ?s ?p ?o } #',
      verifiedMemoryId: '1',
      batchId: '1',
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/contextGraphId|context graph ID|disallowed/i);
    expect(result.agent.verify).not.toHaveBeenCalled();
  });

  it('/api/endorse rejects unsafe contextGraphId before agent.endorse', async () => {
    const result = await callTrustRoute('/api/endorse', {
      contextGraphId: 'cg> } INSERT DATA { ?s ?p ?o } #',
      ual: 'did:dkg:asset:1',
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/contextGraphId|context graph ID|disallowed/i);
    expect(result.agent.endorse).not.toHaveBeenCalled();
  });

  it('/api/endorse rejects unsafe UAL before agent.endorse', async () => {
    const result = await callTrustRoute('/api/endorse', {
      contextGraphId: 'cg-safe',
      ual: 'did:dkg:asset:1> } INSERT DATA { ?s ?p ?o } #',
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/ual|safe IRI/i);
    expect(result.agent.endorse).not.toHaveBeenCalled();
  });

  it('/api/verify rejects oversized timeoutMs before agent.verify', async () => {
    const result = await callTrustRoute('/api/verify', {
      contextGraphId: 'cg-safe',
      verifiedMemoryId: '1',
      batchId: '1',
      timeoutMs: VERIFY_COLLECTION_TIMEOUT_MAX_MS + 1,
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/timeoutMs/);
    expect(result.agent.verify).not.toHaveBeenCalled();
  });
});
