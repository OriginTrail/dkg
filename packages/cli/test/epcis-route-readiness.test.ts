import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleEpcisRoutes } from '../src/daemon/routes/epcis.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const VALID_OBJECT_EVENT_DOC = {
  '@context': {
    '@vocab': 'https://gs1.github.io/EPCIS/',
    epcis: 'https://gs1.github.io/EPCIS/',
    cbv: 'https://ref.gs1.org/cbv/',
    type: '@type',
    id: '@id',
    eventID: '@id',
  },
  type: 'EPCISDocument',
  schemaVersion: '2.0',
  creationDate: '2024-03-01T08:00:00Z',
  epcisBody: {
    eventList: [
      {
        eventID: 'urn:uuid:fixture-obj-1',
        type: 'ObjectEvent',
        eventTime: '2024-03-01T08:00:00.000Z',
        eventTimeZoneOffset: '+00:00',
        epcList: ['urn:epc:id:sgtin:4012345.011111.1001'],
        action: 'ADD',
        bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
        disposition: 'https://ref.gs1.org/cbv/Disp-in_progress',
        readPoint: { id: 'urn:epc:id:sgln:4012345.00001.0' },
        bizLocation: { id: 'urn:epc:id:sgln:4012345.00001.0' },
      },
    ],
  },
};

function createResponse() {
  const response = {
    statusCode: 0,
    headers: undefined as Record<string, string> | undefined,
    body: '',
    writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(body?: string) {
      this.body = body ?? '';
      this.writableEnded = true;
      return this;
    },
  };
  return response;
}

function createRequest(body?: unknown): RequestContext['req'] {
  const request = body === undefined
    ? new Readable({ read() { this.push(null); } })
    : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(request, {
    method: 'POST',
    url: '/api/epcis/capture',
    headers: {},
  });
  return request as RequestContext['req'];
}

function createGetRequest(url: string): RequestContext['req'] {
  const request = new Readable({ read() { this.push(null); } });
  Object.assign(request, {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1' },
  });
  return request as RequestContext['req'];
}

function createContext(overrides: Partial<RequestContext> = {}): RequestContext {
  const url = new URL('http://127.0.0.1/api/epcis/capture');
  return {
    req: createRequest(),
    res: createResponse() as unknown as ServerResponse,
    agent: {
      publishAsync: async () => {
        throw new Error('publishAsync should not be called when publisher runtime is unavailable');
      },
    } as unknown as RequestContext['agent'],
    publisherControl: {} as RequestContext['publisherControl'],
    publisherRuntime: null,
    config: {
      epcis: { contextGraphId: 'epcis-test' },
      publisher: { enabled: true },
    } as RequestContext['config'],
    startedAt: 0,
    dashDb: {} as RequestContext['dashDb'],
    opWallets: { adminWallet: { address: '0x0', privateKey: '0x0' }, wallets: [] } as RequestContext['opWallets'],
    network: null as RequestContext['network'],
    tracker: {} as RequestContext['tracker'],
    memoryManager: {} as RequestContext['memoryManager'],
    bridgeAuthToken: undefined,
    nodeVersion: 'test',
    nodeCommit: 'test',
    catchupTracker: {} as RequestContext['catchupTracker'],
    extractionRegistry: {} as RequestContext['extractionRegistry'],
    fileStore: {} as RequestContext['fileStore'],
    extractionStatus: new Map(),
    assertionImportLocks: new Map(),
    vectorStore: {} as RequestContext['vectorStore'],
    embeddingProvider: null,
    validTokens: new Set(),
    apiHost: '127.0.0.1',
    apiPortRef: { value: 0 },
    url,
    path: url.pathname,
    requestToken: undefined,
    requestAgentAddress: '0x0',
    ...overrides,
  };
}

function responseBody(ctx: RequestContext): Record<string, unknown> {
  return JSON.parse((ctx.res as unknown as { body: string }).body) as Record<string, unknown>;
}

describe('EPCIS async capture publisher readiness', () => {
  it('returns 503 when publisher config is enabled but the async runtime is not running', async () => {
    const ctx = createContext();

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(503);
    expect(responseBody(ctx)).toMatchObject({
      error: 'PublisherUnavailable',
    });
  });

  it('keeps disabled publisher config mapped to PublisherDisabled', async () => {
    const ctx = createContext({
      config: {
        epcis: { contextGraphId: 'epcis-test' },
        publisher: { enabled: false },
      } as RequestContext['config'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(503);
    expect(responseBody(ctx)).toMatchObject({
      error: 'PublisherDisabled',
    });
  });

  it('accepts capture and publishes bare documents as private content without route public wrapping', async () => {
    const published: Array<{ contextGraphId: string; content: unknown; opts: unknown }> = [];
    const ctx = createContext({
      req: createRequest({
        epcisDocument: VALID_OBJECT_EVENT_DOC,
        publishOptions: { accessPolicy: 'allowList', allowedPeers: ['peer-a'] },
      }),
      agent: {
        publishAsync: async (contextGraphId: string, content: unknown, opts: unknown) => {
          published.push({ contextGraphId, content, opts });
          return { captureID: 'capture-route-1' };
        },
      } as unknown as RequestContext['agent'],
      publisherRuntime: {
        walletIds: ['0xpublisher'],
        runner: {},
        publisher: {},
        stop: async () => {},
      } as unknown as RequestContext['publisherRuntime'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(202);
    expect(responseBody(ctx)).toMatchObject({
      captureID: 'capture-route-1',
      status: 'accepted',
      eventCount: 1,
    });
    expect(published).toEqual([
      {
        contextGraphId: 'epcis-test',
        content: { private: VALID_OBJECT_EVENT_DOC },
        opts: { accessPolicy: 'allowList', allowedPeers: ['peer-a'] },
      },
    ]);
  });

  it('uses per-request contextGraphId and threads subGraphName into publisher opts', async () => {
    const published: Array<{ contextGraphId: string; content: unknown; opts: unknown }> = [];
    const ctx = createContext({
      req: createRequest({
        contextGraphId: 'per-request-cg',
        subGraphName: 'research',
        epcisDocument: VALID_OBJECT_EVENT_DOC,
      }),
      agent: {
        publishAsync: async (contextGraphId: string, content: unknown, opts: unknown) => {
          published.push({ contextGraphId, content, opts });
          return { captureID: 'capture-route-2' };
        },
      } as unknown as RequestContext['agent'],
      publisherRuntime: {
        walletIds: ['0xpublisher'],
        runner: {},
        publisher: {},
        stop: async () => {},
      } as unknown as RequestContext['publisherRuntime'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(202);
    expect(published).toEqual([
      {
        contextGraphId: 'per-request-cg',
        content: { private: VALID_OBJECT_EVENT_DOC },
        opts: { subGraphName: 'research' },
      },
    ]);
  });

  it('returns 400 InvalidContent when neither body nor config supplies a contextGraphId', async () => {
    const ctx = createContext({
      req: createRequest({ epcisDocument: VALID_OBJECT_EVENT_DOC }),
      config: {
        epcis: {},
        publisher: { enabled: true },
      } as RequestContext['config'],
      publisherRuntime: {
        walletIds: ['0xpublisher'],
        runner: {},
        publisher: {},
        stop: async () => {},
      } as unknown as RequestContext['publisherRuntime'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(400);
    const body = responseBody(ctx);
    expect(body.error).toBe('InvalidContent');
    expect(body.message).toMatch(/contextGraphId/);
    expect(body.message).toMatch(/epcis\.contextGraphId/);
  });

  it('returns 400 InvalidContent for an invalid per-request contextGraphId', async () => {
    const ctx = createContext({
      req: createRequest({
        contextGraphId: 'bad cg with spaces',
        epcisDocument: VALID_OBJECT_EVENT_DOC,
      }),
      publisherRuntime: {
        walletIds: ['0xpublisher'],
        runner: {},
        publisher: {},
        stop: async () => {},
      } as unknown as RequestContext['publisherRuntime'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(400);
    const body = responseBody(ctx);
    expect(body.error).toBe('InvalidContent');
    expect(body.message).toMatch(/contextGraphId/);
  });

  it('returns 400 InvalidContent for an invalid subGraphName', async () => {
    const ctx = createContext({
      req: createRequest({
        subGraphName: '_reserved',
        epcisDocument: VALID_OBJECT_EVENT_DOC,
      }),
      publisherRuntime: {
        walletIds: ['0xpublisher'],
        runner: {},
        publisher: {},
        stop: async () => {},
      } as unknown as RequestContext['publisherRuntime'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(400);
    const body = responseBody(ctx);
    expect(body.error).toBe('InvalidContent');
    expect(body.message).toMatch(/subGraphName/);
    expect(body.message).toMatch(/reserved/);
  });
});

describe('EPCIS events query route — per-request CG + sub-graph', () => {
  function createGetContext(rawUrl: string, overrides: Partial<RequestContext> = {}): RequestContext {
    const url = new URL(rawUrl, 'http://127.0.0.1');
    const queryCalls: Array<{ sparql: string; opts: unknown }> = [];
    const baseAgent = {
      query: async (sparql: string, opts: unknown) => {
        queryCalls.push({ sparql, opts });
        return { bindings: [] };
      },
    } as unknown as RequestContext['agent'];

    return createContext({
      req: createGetRequest(`${url.pathname}${url.search}`),
      url,
      path: url.pathname,
      agent: baseAgent,
      ...overrides,
    });
  }

  // Capture agent.query SPARQL for assertions. The route plumbs the
  // resolved CG + sub-graph through to the SPARQL builder, so this is
  // the cleanest end-to-end observation point.
  function captureSparql(): { agent: RequestContext['agent']; calls: Array<{ sparql: string; opts: unknown }> } {
    const calls: Array<{ sparql: string; opts: unknown }> = [];
    const agent = {
      query: async (sparql: string, opts: unknown) => {
        calls.push({ sparql, opts });
        return { bindings: [] };
      },
    } as unknown as RequestContext['agent'];
    return { agent, calls };
  }

  it('keeps existing config-only callers working (back-compat: no contextGraphId in query string)', async () => {
    const { agent, calls } = captureSparql();
    const ctx = createGetContext('/api/epcis/events', { agent });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:epcis-test>');
    expect(calls[0].opts).toEqual({ contextGraphId: 'epcis-test' });
  });

  it('per-request contextGraphId overrides config and reaches the SPARQL builder', async () => {
    const { agent, calls } = captureSparql();
    const ctx = createGetContext('/api/epcis/events?contextGraphId=per-request-cg', { agent });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:per-request-cg>');
    expect(calls[0].sparql).not.toContain('GRAPH <did:dkg:context-graph:epcis-test>');
    expect(calls[0].opts).toEqual({ contextGraphId: 'per-request-cg' });
  });

  it('per-request subGraphName reaches the SPARQL builder for both public and private graphs', async () => {
    const { agent, calls } = captureSparql();
    const ctx = createGetContext(
      '/api/epcis/events?contextGraphId=per-request-cg&subGraphName=research',
      { agent },
    );

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    // Finalized sub-graph URI is `<cg>/<sub>` (not `<cg>/context/<sub>`) —
    // matches `packages/agent/src/finalization-handler.ts:358-362`, which
    // is where the publisher actually writes finalized sub-graph data.
    // An earlier expectation against `<cg>/context/<sub>` (contextGraphDataUri's
    // 2-arg form) read from a graph URI the publisher never populates.
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:per-request-cg/research>');
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:per-request-cg/research/_private>');
    expect(calls[0].sparql).not.toContain('GRAPH <did:dkg:context-graph:per-request-cg/_private>');
    expect(calls[0].sparql).not.toContain('GRAPH <did:dkg:context-graph:per-request-cg/context/research>');
  });

  it('per-request subGraphName picks SWM partition when finalized=false', async () => {
    const { agent, calls } = captureSparql();
    const ctx = createGetContext(
      '/api/epcis/events?contextGraphId=per-request-cg&subGraphName=research&finalized=false',
      { agent },
    );

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(200);
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:per-request-cg/research/_shared_memory>');
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:per-request-cg/research/_private>');
    expect(calls[0].sparql).not.toContain('GRAPH <did:dkg:context-graph:per-request-cg/_private>');
  });

  it('returns 400 InvalidContent when neither query nor config supplies a contextGraphId', async () => {
    const ctx = createGetContext('/api/epcis/events', {
      config: {
        epcis: {},
        publisher: { enabled: true },
      } as RequestContext['config'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(400);
    const body = responseBody(ctx);
    expect(body.error).toBe('InvalidContent');
    expect(body.message).toMatch(/contextGraphId/);
    expect(body.message).toMatch(/epcis\.contextGraphId/);
  });

  it('returns 400 InvalidContent for an invalid per-request contextGraphId', async () => {
    const ctx = createGetContext('/api/epcis/events?contextGraphId=bad%20cg%20with%20spaces');

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(400);
    const body = responseBody(ctx);
    expect(body.error).toBe('InvalidContent');
    expect(body.message).toMatch(/contextGraphId/);
  });

  it('returns 400 InvalidContent for an invalid subGraphName (reserved underscore prefix)', async () => {
    const ctx = createGetContext(
      '/api/epcis/events?contextGraphId=per-request-cg&subGraphName=_reserved',
    );

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(400);
    const body = responseBody(ctx);
    expect(body.error).toBe('InvalidContent');
    expect(body.message).toMatch(/subGraphName/);
    expect(body.message).toMatch(/reserved/);
  });

  it('does not call agent.query when validation fails (CG)', async () => {
    const { agent, calls } = captureSparql();
    const ctx = createGetContext('/api/epcis/events?contextGraphId=bad%20cg', { agent });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
