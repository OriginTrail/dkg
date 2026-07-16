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



  it('forwards verified attachment refs and import context through channel send', async () => {
    const attachmentRef = {
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      detectedContentType: 'application/pdf',
      extractionStatus: 'completed' as const,
      tripleCount: 42,
      rootEntity: 'did:dkg:context-graph:cg1/assertion/chat-doc',
    };
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:cg1/assertion/skipped',
      fileHash: 'sha256:skip',
      contextGraphId: 'cg1',
      fileName: 'a;b=1.epub',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
      error: 'No extractor; reason=unsupported',
    };
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
      return new Response(JSON.stringify({ text: 'attached reply', correlationId: 'corr-attach' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        text: '',
        correlationId: 'corr-attach',
        attachmentRefs: [attachmentRef],
        attachmentImportResults: [attachmentImportResult],
        contextEntries,
        contextGraphId: 'cg1',
      });
      ctx.extractionStatus.set(attachmentRef.assertionUri, {
        status: 'completed',
        fileHash: attachmentRef.fileHash,
        fileName: attachmentRef.fileName,
        detectedContentType: attachmentRef.detectedContentType,
        tripleCount: attachmentRef.tripleCount,
        rootEntity: attachmentRef.rootEntity,
      });
      ctx.extractionStatus.set(attachmentImportResult.assertionUri, {
        status: 'skipped',
        fileHash: attachmentImportResult.fileHash,
        fileName: attachmentImportResult.fileName,
        detectedContentType: attachmentImportResult.detectedContentType,
        pipelineUsed: null,
        tripleCount: 0,
        error: attachmentImportResult.error,
        ...freshExtractionStatusTimes(),
      });

      await handleOpenclawRoutes(ctx);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ text: 'attached reply', correlationId: 'corr-attach' });
      expect(forwardedBodies).toHaveLength(1);
      expect(forwardedBodies[0]).toMatchObject({
        text: '',
        correlationId: 'corr-attach',
        identity: 'owner',
        attachmentRefs: [attachmentRef],
        uiContextGraphId: 'cg1',
      });
      expect(forwardedBodies[0].contextEntries[0]).toEqual(contextEntries[0]);
      expect(forwardedBodies[0].contextEntries[1]).toMatchObject({
        key: expect.stringMatching(/^attachment_import_result_/),
        label: 'Attachment import result: a;b=1.epub',
      });
      expect(JSON.parse(forwardedBodies[0].contextEntries[1].value)).toMatchObject({
        fileName: 'a;b=1.epub',
        fileHash: 'sha256:skip',
        extractionStatus: 'skipped',
        pipelineUsed: 'none',
        error: 'No extractor; reason=unsupported',
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not replay OpenClaw chat send when the local bridge fetch times out', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout') as Error & { name: string };
    timeoutError.name = 'TimeoutError';
    const urls: string[] = [];
    let bridgeInboundCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9301/inbound') {
        bridgeInboundCalls += 1;
        if (bridgeInboundCalls === 1) {
          throw timeoutError;
        }
        return new Response(JSON.stringify({
          text: 'bridge recovered',
          correlationId: 'corr-timeout-next',
        }), { status: 200 });
      }
      if (requestUrl === 'https://openclaw.example.com/api/dkg-channel/inbound') {
        return new Response(JSON.stringify({ text: 'gateway reply' }), { status: 200 });
      }
      throw timeoutError;
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        text: 'slow task',
        correlationId: 'corr-timeout',
      }, '/api/openclaw-channel/send', {
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
        'http://127.0.0.1:9301/inbound',
      ]);
      expect(res.statusCode).toBe(504);
      expect(JSON.parse(res.body)).toMatchObject({
        error: 'OpenClaw bridge response timeout',
        code: 'OPENCLAW_BRIDGE_RESPONSE_TIMEOUT',
        source: 'openclaw-channel',
        target: 'bridge',
        correlationId: 'corr-timeout',
        timeoutMs: OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
      });

      const { ctx: nextCtx, res: nextRes } = makeOpenClawRouteContext({
        text: 'next task',
        correlationId: 'corr-timeout-next',
      }, '/api/openclaw-channel/send', {
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
        'http://127.0.0.1:9301/inbound',
        'http://127.0.0.1:9301/inbound',
      ]);
      expect(nextRes.statusCode).toBe(200);
      expect(JSON.parse(nextRes.body)).toMatchObject({
        text: 'bridge recovered',
        correlationId: 'corr-timeout-next',
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not retry OpenClaw chat send after a structured upstream bridge timeout', async () => {
    const urls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9301/inbound') {
        return new Response(JSON.stringify({
          error: 'OpenClaw bridge response timeout',
          code: 'OPENCLAW_BRIDGE_RESPONSE_TIMEOUT',
          source: 'openclaw-channel',
          target: 'bridge',
          details: 'OpenClaw bridge did not produce an agent response',
          timeoutMs: OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
        }), { status: 504 });
      }
      return new Response(JSON.stringify({ text: 'gateway reply' }), { status: 200 });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        text: 'slow task',
        correlationId: 'corr-timeout',
      }, '/api/openclaw-channel/send', {
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
        'http://127.0.0.1:9301/inbound',
      ]);
      expect(res.statusCode).toBe(504);
      expect(JSON.parse(res.body)).toMatchObject({
        error: 'OpenClaw bridge response timeout',
        code: 'OPENCLAW_BRIDGE_RESPONSE_TIMEOUT',
        source: 'openclaw-channel',
        target: 'bridge',
        details: 'OpenClaw bridge did not produce an agent response',
        correlationId: 'corr-timeout',
        timeoutMs: OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('preserves structured OpenClaw timeout metadata returned through a bridge proxy', async () => {
    const urls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9301/inbound') {
        return new Response(JSON.stringify({
          error: 'OpenClaw gateway response timeout',
          code: 'OPENCLAW_GATEWAY_RESPONSE_TIMEOUT',
          source: 'openclaw-channel',
          target: 'gateway',
          details: 'Nested OpenClaw gateway did not produce an agent response',
          correlationId: 'upstream-corr',
          timeoutMs: 1234,
        }), { status: 504 });
      }
      return new Response(JSON.stringify({ text: 'gateway reply' }), { status: 200 });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        text: 'slow task',
        correlationId: 'corr-timeout',
      }, '/api/openclaw-channel/send', {
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
        'http://127.0.0.1:9301/inbound',
      ]);
      expect(res.statusCode).toBe(504);
      expect(JSON.parse(res.body)).toMatchObject({
        error: 'OpenClaw gateway response timeout',
        code: 'OPENCLAW_GATEWAY_RESPONSE_TIMEOUT',
        source: 'openclaw-channel',
        target: 'gateway',
        details: 'Nested OpenClaw gateway did not produce an agent response',
        correlationId: 'corr-timeout',
        timeoutMs: 1234,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

});
