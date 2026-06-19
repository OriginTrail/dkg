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



  it('does not retry OpenClaw chat send after a structured upstream agent timeout', async () => {
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
          error: 'Agent response timeout',
          code: 'AGENT_TIMEOUT',
          source: 'openclaw-agent',
          details: 'OpenClaw agent runtime did not produce a response before its deadline',
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
        error: 'Agent response timeout',
        code: 'AGENT_TIMEOUT',
        source: 'openclaw-agent',
        details: 'OpenClaw agent runtime did not produce a response before its deadline',
        correlationId: 'corr-timeout',
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not replay OpenClaw chat send when the bridge returns an unknown upstream 504', async () => {
    const urls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9301/inbound') {
        return new Response('Agent response timeout from proxy', { status: 504 });
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
        details: 'Agent response timeout from proxy',
        correlationId: 'corr-timeout',
        timeoutMs: OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns a target-aware timeout when the OpenClaw gateway is the final timed-out target', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout') as Error & { name: string };
    timeoutError.name = 'TimeoutError';
    const urls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9301/inbound') {
        return new Response('bridge unavailable', { status: 503 });
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
        'https://openclaw.example.com/api/dkg-channel/inbound',
      ]);
      expect(res.statusCode).toBe(504);
      expect(JSON.parse(res.body)).toMatchObject({
        error: 'OpenClaw gateway response timeout',
        code: 'OPENCLAW_GATEWAY_RESPONSE_TIMEOUT',
        source: 'openclaw-channel',
        target: 'gateway',
        correlationId: 'corr-timeout',
        timeoutMs: OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('normalizes OpenClaw health timeout messages before refresh can store them', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout') as Error & { name: string };
    timeoutError.name = 'TimeoutError';
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw timeoutError;
    }) as typeof fetch;
    try {
      const report = await probeOpenClawChannelHealth(makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            transport: { kind: 'openclaw-channel', bridgeUrl: 'http://127.0.0.1:9301' },
          },
        },
      }), 'bridge-token', { ignoreBridgeCache: true, timeoutMs: 50 });

      expect(report.ok).toBe(false);
      expect(report.error).toBe('OpenClaw bridge health probe timed out after 50ms');
      expect(report.error).not.toContain('aborted due to timeout');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('forwards verified import context as content when no text or attachment refs are present', async () => {
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:cg1/assertion/skipped-only',
      fileHash: 'sha256:skip-only',
      contextGraphId: 'cg1',
      fileName: 'skipped-only.epub',
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
      return new Response(JSON.stringify({ text: 'import-only reply', correlationId: 'corr-import-only' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        correlationId: 'corr-import-only',
        persistUserMessage: 'Attachment import result: skipped-only.epub.',
        attachmentImportResults: [attachmentImportResult],
        contextGraphId: 'cg1',
      });
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
      expect(JSON.parse(res.body)).toMatchObject({ text: 'import-only reply', correlationId: 'corr-import-only' });
      expect(forwardedBodies).toHaveLength(1);
      expect(forwardedBodies[0]).toMatchObject({
        text: '',
        correlationId: 'corr-import-only',
        identity: 'owner',
        persistUserMessage: 'Attachment import result: skipped-only.epub.',
        uiContextGraphId: 'cg1',
      });
      expect(forwardedBodies[0]).not.toHaveProperty('attachmentRefs');
      expect(forwardedBodies[0].contextEntries[0]).toMatchObject({
        key: expect.stringMatching(/^attachment_import_result_/),
        label: 'Attachment import result: skipped-only.epub',
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

});
