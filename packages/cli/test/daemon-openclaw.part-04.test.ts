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



  it('migrates verified legacy attachment import context entries through channel send', async () => {
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:cg1/assertion/legacy-skipped',
      fileHash: 'sha256:legacy-skip',
      contextGraphId: 'cg1',
      fileName: 'a; assertionName=not-a-field; assertionUri=not-a-field; fileHash=still-name.epub',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
      error: 'No extractor; fileHash=not-real; reason=unsupported',
    };
    const normalContextEntry = {
      key: 'target_context_graph',
      label: 'Target context graph',
      value: 'Project One (cg1)',
    };
    const forwardedBodies: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      forwardedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'legacy import reply', correlationId: 'corr-legacy-import' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        correlationId: 'corr-legacy-import',
        contextEntries: [
          normalContextEntry,
          {
            key: 'attachment_import_result_legacy',
            label: `Attachment import result: ${attachmentImportResult.fileName}`,
            value: [
              `fileName=${attachmentImportResult.fileName}`,
              'assertionName=legacy-skipped',
              `assertionUri=${attachmentImportResult.assertionUri}`,
              `contextGraphId=${attachmentImportResult.contextGraphId}`,
              `fileHash=${attachmentImportResult.fileHash}`,
              `contentType=${attachmentImportResult.detectedContentType}`,
              'extractionStatus=skipped',
              'pipelineUsed=none',
              'tripleCount=0',
              `error=${attachmentImportResult.error}`,
            ].join('; '),
          },
        ],
        attachmentImportResults: [attachmentImportResult],
        contextGraphId: 'cg1',
      });
      const query = vi.fn(async () => ({
        bindings: [{
          fileHash: '"sha256:legacy-skip"',
          extractionStatus: '"skipped"',
          sourceFileName: `"${attachmentImportResult.fileName}"`,
        }],
      }));
      ctx.agent.store = { query } as any;
      ctx.extractionStatus.set(attachmentImportResult.assertionUri, {
        status: 'skipped',
        fileHash: attachmentImportResult.fileHash,
        detectedContentType: attachmentImportResult.detectedContentType,
        pipelineUsed: null,
        tripleCount: 0,
        error: attachmentImportResult.error,
        ...freshExtractionStatusTimes(),
      });

      await handleOpenclawRoutes(ctx);

      expect(res.statusCode).toBe(200);
      expect(query).toHaveBeenCalled();
      expect(forwardedBodies).toHaveLength(1);
      expect(forwardedBodies[0]).toMatchObject({
        text: '',
        correlationId: 'corr-legacy-import',
        identity: 'owner',
        uiContextGraphId: 'cg1',
      });
      expect(forwardedBodies[0].contextEntries).toHaveLength(2);
      expect(forwardedBodies[0].contextEntries[0]).toEqual(normalContextEntry);
      expect(forwardedBodies[0].contextEntries[1]).toMatchObject({
        key: expect.stringMatching(/^attachment_import_result_/),
        label: `Attachment import result: ${attachmentImportResult.fileName}`,
      });
      expect(forwardedBodies[0].contextEntries[1].key).not.toBe('attachment_import_result_legacy');
      expect(JSON.parse(forwardedBodies[0].contextEntries[1].value)).toMatchObject({
        fileName: attachmentImportResult.fileName,
        fileHash: 'sha256:legacy-skip',
        extractionStatus: 'skipped',
        pipelineUsed: 'none',
        error: attachmentImportResult.error,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('forwards context-only requests through channel send', async () => {
    const contextEntries = [{
      key: 'attachment_import_summary',
      label: 'Attachment import result summary',
      value: 'Two skipped attachment imports are available.',
    }];
    const forwardedBodies: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      forwardedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'context-only reply', correlationId: 'corr-context-only' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        correlationId: 'corr-context-only',
        contextEntries,
        contextGraphId: 'cg1',
      });

      await handleOpenclawRoutes(ctx);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ text: 'context-only reply', correlationId: 'corr-context-only' });
      expect(forwardedBodies).toHaveLength(1);
      expect(forwardedBodies[0]).toMatchObject({
        text: '',
        correlationId: 'corr-context-only',
        identity: 'owner',
        contextEntries,
        uiContextGraphId: 'cg1',
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('rejects non-string text instead of dropping it on context-only sends', async () => {
    const { ctx, res } = makeOpenClawRouteContext({
      text: 123,
      correlationId: 'corr-invalid-text',
      contextEntries: [{
        key: 'target_context_graph',
        label: 'Target context graph',
        value: 'Project One (project-1)',
      }],
    });

    await handleOpenclawRoutes(ctx);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Invalid "text"' });
  });

  it('forwards skipped import context verified from durable metadata after extraction status cache loss', async () => {
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:cg1/assertion/skipped-restart',
      fileHash: 'sha256:skip-restart',
      contextGraphId: 'cg1',
      fileName: 'skipped-restart.epub',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
      error: 'No extractor; reason=unsupported',
    };
    const forwardedBodies: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
      }
      forwardedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'durable reply', correlationId: 'corr-durable-skip' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        correlationId: 'corr-durable-skip',
        attachmentImportResults: [attachmentImportResult],
        contextGraphId: 'cg1',
      });
      const query = vi.fn(async () => ({
        bindings: [{
          fileHash: '"sha256:skip-restart"',
          contentType: '"application/epub+zip"',
          extractionStatus: '"skipped"',
          tripleCount: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>',
          sourceFileName: '"skipped-restart.epub"',
        }],
      }));
      ctx.agent.store = { query } as any;

      await handleOpenclawRoutes(ctx);

      expect(res.statusCode).toBe(200);
      expect(query).toHaveBeenCalled();
      expect(String(query.mock.calls[0]?.[0])).toContain('GRAPH <did:dkg:context-graph:cg1/_meta>');
      expect(forwardedBodies).toHaveLength(1);
      expect(forwardedBodies[0].contextEntries[0]).toMatchObject({
        key: expect.stringMatching(/^attachment_import_result_/),
        label: 'Attachment import result: skipped-restart.epub',
      });
      expect(JSON.parse(forwardedBodies[0].contextEntries[0].value)).toMatchObject({
        fileHash: 'sha256:skip-restart',
        extractionStatus: 'skipped',
        pipelineUsed: 'none',
      });
      expect(JSON.parse(forwardedBodies[0].contextEntries[0].value)).not.toHaveProperty('error');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('forwards verified attachment refs and import context through channel stream', async () => {
    const attachmentRef = {
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      extractionStatus: 'completed' as const,
    };
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:cg1/assertion/skipped',
      fileHash: 'sha256:skip',
      contextGraphId: 'cg1',
      fileName: 'skipped.epub',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
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
      return new Response(JSON.stringify({ text: 'stream reply', correlationId: 'corr-stream-attach' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { ctx, res } = makeOpenClawRouteContext({
        text: '',
        correlationId: 'corr-stream-attach',
        attachmentRefs: [attachmentRef],
        attachmentImportResults: [attachmentImportResult],
        contextEntries,
        contextGraphId: 'cg1',
      }, '/api/openclaw-channel/stream');
      ctx.extractionStatus.set(attachmentRef.assertionUri, {
        status: 'completed',
        fileHash: attachmentRef.fileHash,
        fileName: attachmentRef.fileName,
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
      expect(res.headers['Content-Type']).toContain('text/event-stream');
      expect(res.body).toContain('"text":"stream reply"');
      expect(forwardedBodies).toHaveLength(1);
      expect(forwardedBodies[0]).toMatchObject({
        text: '',
        correlationId: 'corr-stream-attach',
        attachmentRefs: [attachmentRef],
        uiContextGraphId: 'cg1',
      });
      expect(forwardedBodies[0].contextEntries[0]).toEqual(contextEntries[0]);
      expect(forwardedBodies[0].contextEntries[1]).toMatchObject({
        key: expect.stringMatching(/^attachment_import_result_/),
        label: 'Attachment import result: skipped.epub',
      });
      expect(JSON.parse(forwardedBodies[0].contextEntries[1].value)).toMatchObject({
        assertionUri: attachmentImportResult.assertionUri,
        fileHash: attachmentImportResult.fileHash,
        extractionStatus: 'skipped',
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

});
