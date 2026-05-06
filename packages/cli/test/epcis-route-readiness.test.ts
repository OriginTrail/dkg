import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { handleEpcisRoutes } from '../src/daemon/routes/epcis.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

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

function createContext(overrides: Partial<RequestContext> = {}): RequestContext {
  const request = {
    method: 'POST',
    url: '/api/epcis/capture',
  };
  const url = new URL('http://127.0.0.1/api/epcis/capture');
  return {
    req: request as RequestContext['req'],
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
});
