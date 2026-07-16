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



describe('OpenClaw persist-turn validation', () => {


  it('accepts empty-string user and assistant messages when sessionId is present', () => {
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: '',
      assistantReply: '',
    })).toBe(true);
  });

  it('rejects missing or blank session ids', () => {
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: '',
      userMessage: '',
      assistantReply: '',
    })).toBe(false);
    expect(isValidOpenClawPersistTurnPayload({
      userMessage: '',
      assistantReply: '',
    })).toBe(false);
  });

  it('accepts node-owned attachment refs without reclassifying them as assistant tool calls', () => {
    const attachmentRefs = [
      {
        assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
        fileHash: 'sha256:abc123',
        contextGraphId: 'cg1',
        fileName: 'chat-doc.pdf',
        detectedContentType: 'application/pdf',
        extractionStatus: 'completed' as const,
        tripleCount: 42,
      },
    ];

    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'Summarize the attached doc.',
      assistantReply: '',
      attachmentRefs,
    })).toBe(true);
    expect(normalizeOpenClawAttachmentRefs(attachmentRefs)).toEqual(attachmentRefs);
  });

  it('allows attachment-only chat turns only when at least one attachment ref is present', () => {
    const attachmentRefs = [
      {
        assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
        fileHash: 'sha256:abc123',
        contextGraphId: 'cg1',
        fileName: 'chat-doc.pdf',
      },
    ];

    expect(hasOpenClawChatTurnContent('', attachmentRefs)).toBe(true);
    expect(hasOpenClawChatTurnContent('Summarize this.', undefined)).toBe(true);
    expect(hasOpenClawChatTurnContent('', [])).toBe(false);
    expect(hasOpenClawChatTurnContent(undefined, attachmentRefs)).toBe(false);
  });

  it('rejects non-completed extraction statuses on sendable attachment refs', () => {
    expect(normalizeOpenClawAttachmentRefs([{
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      extractionStatus: 'skipped',
    }])).toBeUndefined();

    expect(normalizeOpenClawAttachmentRefs([{
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      extractionStatus: 'failed',
    }])).toBeUndefined();
  });

  it('rejects malformed attachment refs in persist-turn payloads', () => {
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'hi',
      assistantReply: '',
      attachmentRefs: [{ assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc' }],
    })).toBe(false);
  });

  it('rejects attachment ref arrays when any entry is malformed', () => {
    const validRef = {
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
    };
    expect(normalizeOpenClawAttachmentRefs([validRef, { assertionUri: 'did:dkg:context-graph:cg1/assertion/missing' }]))
      .toBeUndefined();
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'hi',
      assistantReply: '',
      attachmentRefs: [validRef, { assertionUri: 'did:dkg:context-graph:cg1/assertion/missing' }],
    })).toBe(false);
  });

  it('accepts completed attachment refs backed by extraction status records', async () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 1000).toISOString();
    const completedAt = now.toISOString();
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      detectedContentType: 'application/pdf',
      extractionStatus: 'completed' as const,
      tripleCount: 42,
      rootEntity: 'did:dkg:context-graph:cg1/assertion/chat-doc',
    }];
    const queryCalls: unknown[][] = [];
    const store = { query: async (...args: unknown[]) => { queryCalls.push(args); return { bindings: [] }; } };
    const extractionStatus = new Map([
      ['did:dkg:context-graph:cg1/assertion/chat-doc', {
        status: 'completed',
        fileHash: 'sha256:abc123',
        fileName: 'chat-doc.pdf',
        detectedContentType: 'application/pdf',
        pipelineUsed: 'application/pdf',
        tripleCount: 42,
        rootEntity: 'did:dkg:context-graph:cg1/assertion/chat-doc',
        startedAt,
        completedAt,
      }],
    ]);

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, extractionStatus as any, attachmentRefs),
    ).resolves.toEqual(attachmentRefs);
    expect(queryCalls).toHaveLength(0);
  });

  it('does not let extraction status authorize Markdown metadata without durable _meta verification', async () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 1000).toISOString();
    const completedAt = now.toISOString();
    const fileHash = `sha256:${'a'.repeat(64)}`;
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash,
      contextGraphId: 'cg1',
      fileName: 'chat-doc.md',
      detectedContentType: 'text/markdown',
      extractionStatus: 'completed' as const,
      markdownHash: fileHash,
      markdownForm: `urn:dkg:file:${fileHash}`,
    }];
    const queryCalls: unknown[][] = [];
    const store = {
      query: async (...args: unknown[]) => {
        queryCalls.push(args);
        const sparql = String(args[0]);
        if (sparql.includes('SELECT ?fileHash')) {
          return {
            bindings: [{
              fileHash: `"${fileHash}"`,
              sourceFileName: '"chat-doc.md"',
            }],
          };
        }
        if (sparql.includes('SELECT ?markdownForm')) {
          return {
            bindings: [{ markdownForm: `urn:dkg:file:${fileHash}` }],
          };
        }
        return { bindings: [] };
      },
    };
    const extractionStatus = new Map([
      ['did:dkg:context-graph:cg1/assertion/chat-doc', {
        status: 'completed',
        fileHash,
        fileName: 'chat-doc.md',
        detectedContentType: 'text/markdown',
        pipelineUsed: 'text/markdown',
        tripleCount: 42,
        rootEntity: 'did:dkg:context-graph:cg1/assertion/chat-doc',
        startedAt,
        completedAt,
      }],
    ]);

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, extractionStatus as any, attachmentRefs),
    ).resolves.toBeUndefined();
    expect(queryCalls).toHaveLength(2);
  });

  it('accepts sub-graph attachment refs backed by extraction status records without querying the store', async () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 1000).toISOString();
    const completedAt = now.toISOString();
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/decisions/assertion/0xAgent/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      extractionStatus: 'completed' as const,
    }];
    const queryCalls: unknown[][] = [];
    const store = { query: async (...args: unknown[]) => { queryCalls.push(args); return { bindings: [] }; } };
    const extractionStatus = new Map([
      ['did:dkg:context-graph:cg1/decisions/assertion/0xAgent/chat-doc', {
        status: 'completed',
        fileHash: 'sha256:abc123',
        fileName: 'chat-doc.pdf',
        detectedContentType: 'application/pdf',
        pipelineUsed: 'application/pdf',
        tripleCount: 42,
        rootEntity: 'did:dkg:context-graph:cg1/decisions/assertion/0xAgent/chat-doc',
        startedAt,
        completedAt,
      }],
    ]);

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, extractionStatus as any, attachmentRefs),
    ).resolves.toEqual(attachmentRefs);
    expect(queryCalls).toHaveLength(0);
  });

  it('accepts sub-graph attachment refs and verifies them against the root meta graph', async () => {
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/decisions/assertion/0xAgent/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      extractionStatus: 'completed' as const,
    }];
    const queryCalls: unknown[][] = [];
    const store = {
      query: async (...args: unknown[]) => {
        queryCalls.push(args);
        return {
          bindings: [{
            fileHash: '"sha256:abc123"',
            contentType: '"application/pdf"',
            sourceFileName: '"chat-doc.pdf"',
          }],
        };
      },
    };

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, new Map(), attachmentRefs),
    ).resolves.toEqual(attachmentRefs);
    expect(String(queryCalls[0][0])).toContain('GRAPH <did:dkg:context-graph:cg1/_meta>');
    expect(String(queryCalls[0][0])).not.toContain('did:dkg:context-graph:cg1/decisions/_meta');
    expect(String(queryCalls[0][0])).toContain('<did:dkg:context-graph:cg1/decisions/assertion/0xAgent/chat-doc>');
  });

  it('rejects completed attachment refs backed by skipped durable metadata after cache expiry', async () => {
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.bin',
      detectedContentType: 'application/octet-stream',
      extractionStatus: 'completed' as const,
    }];
    const queryCalls: unknown[][] = [];
    const store = {
      query: async (...args: unknown[]) => {
        queryCalls.push(args);
        return {
          bindings: [{
            fileHash: '"sha256:abc123"',
            contentType: '"application/octet-stream"',
            sourceFileName: '"chat-doc.bin"',
            extractionStatus: '"skipped"',
          }],
        };
      },
    };

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, new Map(), attachmentRefs),
    ).resolves.toBeUndefined();
    expect(queryCalls).toHaveLength(1);
    expect(String(queryCalls[0][0])).toContain('dkg.io/ontology/extractionStatus');
  });

  it('unescapes RDF string literals before comparing stored source file names', async () => {
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'report "final".pdf',
      extractionStatus: 'completed' as const,
    }];
    const store = {
      query: async () => ({
        bindings: [{
          fileHash: '"sha256:abc123"',
          sourceFileName: '"report \\"final\\".pdf"',
        }],
      }),
    };

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, new Map(), attachmentRefs),
    ).resolves.toEqual(attachmentRefs);
  });

  it('accepts attachment refs when older metadata does not include sourceFileName', async () => {
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      extractionStatus: 'completed' as const,
    }];
    const store = {
      query: async () => ({
        bindings: [{
          fileHash: '"sha256:abc123"',
          contentType: '"application/pdf"',
        }],
      }),
    };

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, new Map(), attachmentRefs),
    ).resolves.toEqual(attachmentRefs);
  });

});
