import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenClawChannelHeaders,
  cancelPendingLocalAgentAttachJob,
  connectLocalAgentIntegrationFromUi,
  connectLocalAgentIntegration,
  daemonState,
  getLocalAgentIntegration,
  getOpenClawChannelTargets,
  hasConfiguredLocalAgentChat,
  hasOpenClawChatTurnContent,
  isLoopbackClientIp,
  isOpenClawMemorySlotElected,
  normalizeOpenClawAttachmentRefs,
  normalizeOpenClawChatContextEntry,
  normalizeOpenClawChatContextEntries,
  isValidOpenClawPersistTurnPayload,
  listLocalAgentIntegrations,
  OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
  parseRequiredSignatures,
  pipeOpenClawStream,
  probeOpenClawChannelHealth,
  refreshLocalAgentIntegrationFromUi,
  reverseLocalAgentSetupForUi,
  runOpenClawUiSetup,
  verifyOpenClawAttachmentRefsProvenance,
  normalizeExplicitLocalAgentDisconnectBody,
  shouldBypassRateLimitForLoopbackTraffic,
  updateLocalAgentIntegration,
} from '../src/daemon.js';
import { handleOpenclawRoutes } from '../src/daemon/routes/openclaw.js';
import { mergeOpenClawConfig, type AdapterEntryConfig } from '@origintrail-official/dkg-adapter-openclaw';
import type { DkgConfig } from '../src/config.js';

// Default entryConfig fixture matching the shape `runSetup` builds at
// Step 5 — same values setup writes into plugins.entries.adapter-openclaw.config.
const testEntryConfig: AdapterEntryConfig = {
  daemonUrl: 'http://127.0.0.1:9200',
  memory: { enabled: true },
  channel: { enabled: true },
};

function makeConfig(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return {
    name: 'test-node',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
    ...overrides,
  };
}

function makeJsonRequest(method: string, path: string, payload: unknown) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = {};
  setTimeout(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  }, 0);
  return req;
}

function makeJsonResponse() {
  const res = new EventEmitter() as any;
  res.statusCode = 0;
  res.headers = {};
  res.body = '';
  res.writableEnded = false;
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.write = (chunk: string | Buffer) => {
    res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    return true;
  };
  res.end = (chunk?: string | Buffer) => {
    if (chunk) res.write(chunk);
    res.writableEnded = true;
  };
  return res;
}

function freshExtractionStatusTimes() {
  const completedAt = new Date().toISOString();
  const startedAt = new Date(Date.now() - 1000).toISOString();
  return { startedAt, completedAt };
}

function makeOpenClawRouteContext(
  payload: unknown,
  path = '/api/openclaw-channel/send',
  configOverrides: Partial<DkgConfig> = {},
) {
  const req = makeJsonRequest('POST', path, payload);
  const res = makeJsonResponse();
  return {
    ctx: {
      req,
      res,
      agent: {
        store: { query: vi.fn(async () => ({ bindings: [] })) },
      },
      config: makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            capabilities: { localChat: true },
            transport: { kind: 'openclaw-channel', bridgeUrl: 'http://127.0.0.1:9301' },
          },
        },
        ...configOverrides,
      }),
      memoryManager: {
        storeChatExchange: vi.fn(async () => {}),
      },
      bridgeAuthToken: 'bridge-token',
      extractionStatus: new Map(),
      path,
      requestAgentAddress: '0x0000000000000000000000000000000000000001',
    } as any,
    res,
  };
}

describe('OpenClaw channel routing helpers', () => {
  beforeEach(() => {
    daemonState.openClawBridgeHealth = null;
  });



  it('does not replay OpenClaw stream when the bridge returns an unknown upstream 504', async () => {
    const urls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9301/inbound/stream') {
        return new Response('gateway timeout from proxy', { status: 504 });
      }
      return new Response(JSON.stringify({ text: 'gateway stream', correlationId: 'corr-stream' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        text: 'slow task',
        correlationId: 'corr-stream',
      }, '/api/openclaw-channel/stream', {
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            capabilities: { localChat: true },
            transport: {
              kind: 'openclaw-channel',
              bridgeUrl: 'http://127.0.0.1:9301',
              gatewayUrl: 'https://openclaw.example.com',
            },
          },
        },
      });

      await handleOpenclawRoutes(ctx);

      expect(urls).toEqual([
        'http://127.0.0.1:9301/health',
        'http://127.0.0.1:9301/inbound/stream',
      ]);
      expect(res.statusCode).toBe(504);
      expect(JSON.parse(res.body)).toMatchObject({
        error: 'OpenClaw bridge response timeout',
        code: 'OPENCLAW_BRIDGE_RESPONSE_TIMEOUT',
        source: 'openclaw-channel',
        target: 'bridge',
        details: 'gateway timeout from proxy',
        correlationId: 'corr-stream',
        timeoutMs: OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not mark OpenClaw stream bridge unhealthy when the local bridge fetch times out', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout') as Error & { name: string };
    timeoutError.name = 'TimeoutError';
    const urls: string[] = [];
    let bridgeStreamCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9301/inbound/stream') {
        bridgeStreamCalls += 1;
        if (bridgeStreamCalls === 1) {
          throw timeoutError;
        }
        return new Response(JSON.stringify({
          text: 'stream bridge recovered',
          correlationId: 'corr-stream-timeout-next',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        text: 'gateway stream',
        correlationId: 'corr-stream-timeout-next',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        text: 'slow stream task',
        correlationId: 'corr-stream-timeout',
      }, '/api/openclaw-channel/stream', {
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            capabilities: { localChat: true },
            transport: {
              kind: 'openclaw-channel',
              bridgeUrl: 'http://127.0.0.1:9301',
              gatewayUrl: 'https://openclaw.example.com',
            },
          },
        },
      });

      await handleOpenclawRoutes(ctx);

      expect(urls).toEqual([
        'http://127.0.0.1:9301/health',
        'http://127.0.0.1:9301/inbound/stream',
      ]);
      expect(res.statusCode).toBe(504);
      expect(JSON.parse(res.body)).toMatchObject({
        error: 'OpenClaw bridge response timeout',
        code: 'OPENCLAW_BRIDGE_RESPONSE_TIMEOUT',
        source: 'openclaw-channel',
        target: 'bridge',
        correlationId: 'corr-stream-timeout',
        timeoutMs: OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
      });

      const { ctx: nextCtx, res: nextRes } = makeOpenClawRouteContext({
        text: 'next stream task',
        correlationId: 'corr-stream-timeout-next',
      }, '/api/openclaw-channel/stream', {
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            capabilities: { localChat: true },
            transport: {
              kind: 'openclaw-channel',
              bridgeUrl: 'http://127.0.0.1:9301',
              gatewayUrl: 'https://openclaw.example.com',
            },
          },
        },
      });

      await handleOpenclawRoutes(nextCtx);

      expect(urls).toEqual([
        'http://127.0.0.1:9301/health',
        'http://127.0.0.1:9301/inbound/stream',
        'http://127.0.0.1:9301/inbound/stream',
      ]);
      expect(nextRes.statusCode).toBe(200);
      expect(nextRes.headers['Content-Type']).toContain('text/event-stream');
      expect(nextRes.body).toContain('"text":"stream bridge recovered"');
      expect(nextRes.body).toContain('"correlationId":"corr-stream-timeout-next"');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('preserves structured OpenClaw stream timeout metadata returned through a bridge proxy', async () => {
    const urls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9301/inbound/stream') {
        return new Response(JSON.stringify({
          error: 'OpenClaw gateway response timeout',
          code: 'OPENCLAW_GATEWAY_RESPONSE_TIMEOUT',
          source: 'openclaw-channel',
          target: 'gateway',
          details: 'Nested OpenClaw gateway stream did not produce an agent response',
          correlationId: 'upstream-corr',
          timeoutMs: 5678,
        }), { status: 504 });
      }
      return new Response(JSON.stringify({ text: 'gateway stream', correlationId: 'corr-stream' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        text: 'slow task',
        correlationId: 'corr-stream',
      }, '/api/openclaw-channel/stream', {
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            capabilities: { localChat: true },
            transport: {
              kind: 'openclaw-channel',
              bridgeUrl: 'http://127.0.0.1:9301',
              gatewayUrl: 'https://openclaw.example.com',
            },
          },
        },
      });

      await handleOpenclawRoutes(ctx);

      expect(urls).toEqual([
        'http://127.0.0.1:9301/health',
        'http://127.0.0.1:9301/inbound/stream',
      ]);
      expect(res.statusCode).toBe(504);
      expect(JSON.parse(res.body)).toMatchObject({
        error: 'OpenClaw gateway response timeout',
        code: 'OPENCLAW_GATEWAY_RESPONSE_TIMEOUT',
        source: 'openclaw-channel',
        target: 'gateway',
        details: 'Nested OpenClaw gateway stream did not produce an agent response',
        correlationId: 'corr-stream',
        timeoutMs: 5678,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('forwards context-only requests through channel stream', async () => {
    const contextEntries = [{
      key: 'target_context_graph',
      label: 'Target context graph',
      value: 'Project One (cg1)',
    }];
    const forwardedBodies: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      forwardedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'stream context reply', correlationId: 'corr-stream-context' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        correlationId: 'corr-stream-context',
        contextEntries,
        contextGraphId: 'cg1',
      }, '/api/openclaw-channel/stream');

      await handleOpenclawRoutes(ctx);

      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toContain('text/event-stream');
      expect(res.body).toContain('"text":"stream context reply"');
      expect(forwardedBodies).toHaveLength(1);
      expect(forwardedBodies[0]).toMatchObject({
        text: '',
        correlationId: 'corr-stream-context',
        identity: 'owner',
        contextEntries,
        uiContextGraphId: 'cg1',
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('forwards skipped import context through channel stream when text is omitted', async () => {
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:cg1/assertion/skipped-stream-only',
      fileHash: 'sha256:skip-stream-only',
      contextGraphId: 'cg1',
      fileName: 'skipped-stream-only.epub',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
    };
    const forwardedBodies: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      forwardedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'stream import reply', correlationId: 'corr-stream-import-only' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        correlationId: 'corr-stream-import-only',
        persistUserMessage: 'Attachment import result: skipped-stream-only.epub.',
        attachmentImportResults: [attachmentImportResult],
        contextGraphId: 'cg1',
      }, '/api/openclaw-channel/stream');
      ctx.extractionStatus.set(attachmentImportResult.assertionUri, {
        status: 'skipped',
        fileHash: attachmentImportResult.fileHash,
        fileName: attachmentImportResult.fileName,
        detectedContentType: attachmentImportResult.detectedContentType,
        pipelineUsed: null,
        tripleCount: 0,
        ...freshExtractionStatusTimes(),
      });

      await handleOpenclawRoutes(ctx);

      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toContain('text/event-stream');
      expect(res.body).toContain('"text":"stream import reply"');
      expect(forwardedBodies).toHaveLength(1);
      expect(forwardedBodies[0]).toMatchObject({
        text: '',
        correlationId: 'corr-stream-import-only',
        identity: 'owner',
        persistUserMessage: 'Attachment import result: skipped-stream-only.epub.',
        uiContextGraphId: 'cg1',
      });
      expect(forwardedBodies[0]).not.toHaveProperty('attachmentRefs');
      expect(forwardedBodies[0].contextEntries[0]).toMatchObject({
        key: expect.stringMatching(/^attachment_import_result_/),
        label: 'Attachment import result: skipped-stream-only.epub',
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

});
