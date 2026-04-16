import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildOpenClawChannelHeaders,
  cancelPendingLocalAgentAttachJob,
  connectLocalAgentIntegrationFromUi,
  connectLocalAgentIntegration,
  getOpenClawUiSetupCommand,
  getLocalAgentIntegration,
  getOpenClawChannelTargets,
  hasConfiguredLocalAgentChat,
  hasOpenClawChatTurnContent,
  isLoopbackClientIp,
  normalizeOpenClawAttachmentRefs,
  isValidOpenClawPersistTurnPayload,
  listLocalAgentIntegrations,
  notifyLocalAgentIntegrationWake,
  canQueueLocalAgentSemanticEnrichment,
  queueLocalAgentSemanticEnrichmentBestEffort,
  reconcileOpenClawSemanticAvailability,
  fileImportSourceIdentityMatchesCurrentState,
  normalizeQueriedLiteralValue,
  normalizeOntologyQuadObjectInput,
  parseRequiredSignatures,
  pipeOpenClawStream,
  probeOpenClawChannelHealth,
  verifyOpenClawAttachmentRefsProvenance,
  normalizeExplicitLocalAgentDisconnectBody,
  readSemanticTripleCountForEvent,
  shouldBypassRateLimitForLoopbackTraffic,
  updateLocalAgentIntegration,
} from '../src/daemon.js';
import type { DkgConfig } from '../src/config.js';

function makeConfig(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return {
    name: 'test-node',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
    ...overrides,
  };
}

describe('OpenClaw channel routing helpers', () => {
  it('defaults to the standalone bridge when no gateway transport is configured', () => {
    expect(getOpenClawChannelTargets(makeConfig())).toEqual([
      {
        name: 'bridge',
        inboundUrl: 'http://127.0.0.1:9201/inbound',
        streamUrl: 'http://127.0.0.1:9201/inbound/stream',
        healthUrl: 'http://127.0.0.1:9201/health',
      },
    ]);
  });

  it('uses only the gateway route when gatewayUrl is configured without an explicit bridgeUrl', () => {
    expect(getOpenClawChannelTargets(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            gatewayUrl: 'http://gateway.local:3030',
          },
        },
      },
    }))).toEqual([
      {
        name: 'gateway',
        inboundUrl: 'http://gateway.local:3030/api/dkg-channel/inbound',
        healthUrl: 'http://gateway.local:3030/api/dkg-channel/health',
      },
    ]);
  });

  it('keeps both transports when bridgeUrl and gatewayUrl are both configured', () => {
    expect(getOpenClawChannelTargets(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9301',
            gatewayUrl: 'http://gateway.local:3030',
          },
        },
      },
    }))).toEqual([
      {
        name: 'bridge',
        inboundUrl: 'http://127.0.0.1:9301/inbound',
        streamUrl: 'http://127.0.0.1:9301/inbound/stream',
        healthUrl: 'http://127.0.0.1:9301/health',
      },
      {
        name: 'gateway',
        inboundUrl: 'http://gateway.local:3030/api/dkg-channel/inbound',
        healthUrl: 'http://gateway.local:3030/api/dkg-channel/health',
      },
    ]);
  });

  it('prefers the generic local agent integration transport when OpenClaw is connected through the registry', () => {
    expect(getOpenClawChannelTargets(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9401',
            gatewayUrl: 'http://gateway.local:4040',
          },
        },
      },
    }))).toEqual([
      {
        name: 'bridge',
        inboundUrl: 'http://127.0.0.1:9401/inbound',
        streamUrl: 'http://127.0.0.1:9401/inbound/stream',
        healthUrl: 'http://127.0.0.1:9401/health',
      },
      {
        name: 'gateway',
        inboundUrl: 'http://gateway.local:4040/api/dkg-channel/inbound',
        healthUrl: 'http://gateway.local:4040/api/dkg-channel/health',
      },
    ]);
  });

  it('returns no OpenClaw channel targets when the registry explicitly disables the integration', () => {
    expect(getOpenClawChannelTargets(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: false,
        },
      },
    }))).toEqual([]);
  });

  it('adds the bridge auth header only for standalone bridge requests', () => {
    const bridgeHeaders = buildOpenClawChannelHeaders(
      {
        name: 'bridge',
        inboundUrl: 'http://127.0.0.1:9201/inbound',
      },
      'secret-token',
      { 'Content-Type': 'application/json' },
    );
    expect(bridgeHeaders).toEqual({
      'Content-Type': 'application/json',
      'x-dkg-bridge-token': 'secret-token',
    });

    const gatewayHeaders = buildOpenClawChannelHeaders(
      {
        name: 'gateway',
        inboundUrl: 'http://gateway.local/api/dkg-channel/inbound',
      },
      'secret-token',
      { 'Content-Type': 'application/json' },
    );
    expect(gatewayHeaders).toEqual({ 'Content-Type': 'application/json' });
  });

  it('does not cancel the upstream stream on request close events after the body is consumed', async () => {
    const req = new EventEmitter() as any;
    const res = new EventEmitter() as any;
    const writes: string[] = [];
    res.writableEnded = false;
    res.write = (chunk: Uint8Array) => {
      writes.push(Buffer.from(chunk).toString('utf8'));
      return true;
    };
    res.end = () => { res.writableEnded = true; };

    const reader = {
      read: async () => {
        if (writes.length === 0) {
          req.emit('close');
          return { done: false, value: Buffer.from('data: {"type":"text_delta","delta":"pong"}\n\n') };
        }
        return { done: true, value: undefined };
      },
      cancel: async () => undefined,
      releaseLock: () => undefined,
    };

    const cancelSpy = vi.spyOn(reader, 'cancel');
    const releaseSpy = vi.spyOn(reader, 'releaseLock');

    await pipeOpenClawStream(req, res, reader);

    expect(cancelSpy).not.toHaveBeenCalled();
    expect(writes).toEqual(['data: {"type":"text_delta","delta":"pong"}\n\n']);
    expect(releaseSpy).toHaveBeenCalledOnce();
  });

  it('cancels the upstream stream when the downstream response closes before it finishes', async () => {
    const req = new EventEmitter() as any;
    const res = new EventEmitter() as any;
    let resolveRead!: (value: { done: boolean; value?: Uint8Array }) => void;

    res.writableEnded = false;
    res.write = () => true;
    res.end = () => { res.writableEnded = true; };

    const reader = {
      read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => { resolveRead = resolve; }),
      cancel: async () => undefined,
      releaseLock: () => undefined,
    };

    const cancelSpy = vi.spyOn(reader, 'cancel');
    const releaseSpy = vi.spyOn(reader, 'releaseLock');

    const proxyPromise = pipeOpenClawStream(req, res, reader);
    res.emit('close');
    resolveRead({ done: true });
    await proxyPromise;

    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledOnce();
  });

  it('waits for downstream drain before reading more stream data', async () => {
    const req = new EventEmitter() as any;
    const res = new EventEmitter() as any;
    const writes: string[] = [];
    let readCount = 0;
    let secondReadCalled = false;

    res.writableEnded = false;
    res.write = (chunk: Uint8Array) => {
      writes.push(Buffer.from(chunk).toString('utf8'));
      return writes.length > 1;
    };
    res.end = () => { res.writableEnded = true; };

    const reader = {
      read: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) {
          return { done: false, value: Buffer.from('data: first\n\n') };
        }
        secondReadCalled = true;
        return { done: true, value: undefined };
      }),
      cancel: async () => undefined,
      releaseLock: () => undefined,
    };

    const proxyPromise = pipeOpenClawStream(req, res, reader);
    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toEqual(['data: first\n\n']);
    expect(secondReadCalled).toBe(false);

    res.emit('drain');
    await proxyPromise;

    expect(secondReadCalled).toBe(true);
  });
});

describe('local agent semantic wake helper', () => {
  const wakePayload = {
    kind: 'semantic_enrichment' as const,
    eventKind: 'chat_turn' as const,
    eventId: 'evt-wake-1',
  };

  it('skips when the target integration is disabled or has no wake url', async () => {
    await expect(
      notifyLocalAgentIntegrationWake(makeConfig(), 'openclaw', wakePayload, 'bridge-token', vi.fn() as any),
    ).resolves.toEqual({ status: 'skipped', reason: 'integration_disabled' });

    await expect(
      notifyLocalAgentIntegrationWake(
        makeConfig({
          localAgentIntegrations: {
            openclaw: {
              enabled: true,
              transport: {
                kind: 'openclaw-channel',
              },
            },
          },
        }),
        'openclaw',
        wakePayload,
        'bridge-token',
        vi.fn() as any,
      ),
    ).resolves.toEqual({ status: 'skipped', reason: 'wake_unavailable' });
  });

  it('applies bridge-token auth when the wake transport requires it', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await notifyLocalAgentIntegrationWake(
      makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            capabilities: {
              semanticEnrichment: true,
            },
            transport: {
              kind: 'openclaw-channel',
              wakeUrl: 'http://127.0.0.1:9301/semantic-enrichment/wake',
              wakeAuth: 'bridge-token',
            },
          },
        },
      }),
      'openclaw',
      wakePayload,
      'bridge-token',
      fetchSpy as any,
    );

    expect(result).toEqual({ status: 'delivered' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:9301/semantic-enrichment/wake',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-dkg-bridge-token': 'bridge-token',
        }),
      }),
    );
  });

  it('uses gateway wake auth mode without sending the bridge token header', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await notifyLocalAgentIntegrationWake(
      makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            transport: {
              kind: 'openclaw-channel',
              wakeUrl: 'http://127.0.0.1:18789/api/dkg-channel/semantic-enrichment/wake',
              wakeAuth: 'gateway',
            },
          },
        },
      }),
      'openclaw',
      wakePayload,
      'bridge-token',
      fetchSpy as any,
    );

    expect(result).toEqual({ status: 'delivered' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:18789/api/dkg-channel/semantic-enrichment/wake',
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('returns a failed wake result on fetch errors or non-2xx responses without throwing', async () => {
    await expect(
      notifyLocalAgentIntegrationWake(
        makeConfig({
          localAgentIntegrations: {
            openclaw: {
              enabled: true,
              transport: {
                kind: 'openclaw-channel',
                wakeUrl: 'http://127.0.0.1:9301/semantic-enrichment/wake',
                wakeAuth: 'bridge-token',
              },
            },
          },
        }),
        'openclaw',
        wakePayload,
        'bridge-token',
        vi.fn().mockResolvedValue(new Response('nope', { status: 503, statusText: 'Service Unavailable' })) as any,
      ),
    ).resolves.toEqual({ status: 'failed', reason: 'HTTP 503 Service Unavailable' });

    await expect(
      notifyLocalAgentIntegrationWake(
        makeConfig({
          localAgentIntegrations: {
            openclaw: {
              enabled: true,
              transport: {
                kind: 'openclaw-channel',
                wakeUrl: 'http://127.0.0.1:9301/semantic-enrichment/wake',
                wakeAuth: 'bridge-token',
              },
            },
          },
        }),
        'openclaw',
        wakePayload,
        'bridge-token',
        vi.fn().mockRejectedValue(new Error('wake offline')) as any,
      ),
    ).resolves.toEqual({ status: 'failed', reason: 'wake offline' });
  });
});

describe('best-effort semantic enqueue helper', () => {
  it('skips semantic event creation when the integration is unavailable and skipWhenUnavailable is enabled', () => {
    expect(canQueueLocalAgentSemanticEnrichment(makeConfig(), 'openclaw')).toBe(false);

    const dashDb = {
      getSemanticEnrichmentEventByIdempotencyKey: vi.fn(),
      insertSemanticEnrichmentEvent: vi.fn(),
      getSemanticEnrichmentEvent: vi.fn(),
    };

    const descriptor = queueLocalAgentSemanticEnrichmentBestEffort({
      config: makeConfig(),
      dashDb: dashDb as any,
      integrationId: 'openclaw',
      kind: 'file_import',
      payload: {
        kind: 'file_import',
        contextGraphId: 'cg1',
        assertionName: 'roadmap',
        assertionUri: 'did:dkg:context-graph:cg1/assertion/peer/roadmap',
        importStartedAt: '2026-04-15T12:00:00.000Z',
        fileHash: 'sha256:file-1',
        mdIntermediateHash: 'sha256:md-1',
        detectedContentType: 'text/markdown',
      },
      skipWhenUnavailable: true,
      logLabel: 'file import test',
    });

    expect(descriptor).toBeUndefined();
    expect(dashDb.insertSemanticEnrichmentEvent).not.toHaveBeenCalled();
  });

  it('allows queueing when the live adapter request advertises semantic enrichment support before stored capability sync lands', () => {
    expect(canQueueLocalAgentSemanticEnrichment(makeConfig(), 'openclaw', {
      liveSemanticEnrichmentSupported: true,
    })).toBe(true);

    const dashDb = {
      getSemanticEnrichmentEventByIdempotencyKey: vi.fn().mockReturnValue(null),
      insertSemanticEnrichmentEvent: vi.fn(),
      getSemanticEnrichmentEvent: vi.fn().mockReturnValue({
        id: 'evt-live-hint',
        status: 'pending',
        updated_at: Date.now(),
        last_error: null,
      }),
    };

    const descriptor = queueLocalAgentSemanticEnrichmentBestEffort({
      config: makeConfig(),
      dashDb: dashDb as any,
      integrationId: 'openclaw',
      kind: 'chat_turn',
      payload: {
        kind: 'chat_turn',
        sessionId: 'openclaw:dkg-ui',
        turnId: 'turn-live-hint',
        contextGraphId: 'agent-context',
        assertionName: 'chat-turns',
        assertionUri: 'did:dkg:context-graph:agent-context/assertion/peer/chat-turns',
        sessionUri: 'urn:dkg:chat:session:openclaw:dkg-ui',
        turnUri: 'urn:dkg:chat:turn:turn-live-hint',
        userMessage: 'remember this',
        assistantReply: 'noted',
        persistenceState: 'stored',
      },
      skipWhenUnavailable: true,
      liveSemanticEnrichmentSupported: true,
      logLabel: 'chat live semantic hint',
    });

    expect(dashDb.insertSemanticEnrichmentEvent).toHaveBeenCalledOnce();
    expect(descriptor).toMatchObject({
      eventId: 'evt-live-hint',
      status: 'pending',
    });
  });

  it('does not queue semantic jobs from stale ready OpenClaw state when explicit capability support is missing', () => {
    expect(canQueueLocalAgentSemanticEnrichment(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          metadata: {
            registrationMode: 'full',
          },
          runtime: {
            status: 'ready',
            ready: true,
          },
        },
      },
    }), 'openclaw')).toBe(false);
  });

  it('does not queue semantic jobs during first-attach connecting state without explicit capability support', () => {
    expect(canQueueLocalAgentSemanticEnrichment(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          runtime: {
            status: 'connecting',
            ready: false,
          },
        },
      },
    }), 'openclaw')).toBe(false);
  });

  it('does not queue semantic jobs for setup-runtime OpenClaw registrations without explicit capability support', () => {
    expect(canQueueLocalAgentSemanticEnrichment(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          metadata: {
            registrationMode: 'setup-runtime',
          },
          runtime: {
            status: 'ready',
            ready: true,
          },
        },
      },
    }), 'openclaw')).toBe(false);
  });

  it('stops queueing when the adapter explicitly disables semantic enrichment support', () => {
    expect(canQueueLocalAgentSemanticEnrichment(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          capabilities: {
            semanticEnrichment: false,
          },
        },
      },
    }), 'openclaw')).toBe(false);
  });

  it('dead-letters queued semantic events at reconciliation time when stored OpenClaw support is disabled', () => {
    const extractionStatus = new Map<string, any>();
    const dashDb = {
      deadLetterActiveSemanticEnrichmentEvents: vi.fn().mockReturnValue([]),
    };

    const count = reconcileOpenClawSemanticAvailability(
      makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: false,
          },
        },
      }),
      extractionStatus as any,
      dashDb as any,
    );

    expect(count).toBe(0);
    expect(dashDb.deadLetterActiveSemanticEnrichmentEvents).toHaveBeenCalledOnce();
  });

  it('does not dead-letter queued semantic events at reconciliation time when support is merely unknown', () => {
    const extractionStatus = new Map<string, any>();
    const dashDb = {
      deadLetterActiveSemanticEnrichmentEvents: vi.fn(),
    };

    const count = reconcileOpenClawSemanticAvailability(
      makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            runtime: {
              status: 'ready',
              ready: true,
            },
          },
        },
      }),
      extractionStatus as any,
      dashDb as any,
    );

    expect(count).toBe(0);
    expect(dashDb.deadLetterActiveSemanticEnrichmentEvents).not.toHaveBeenCalled();
  });

  it('still persists the semantic event when OpenClaw is enabled but wake transport metadata is temporarily unavailable', () => {
    const dashDb = {
      getSemanticEnrichmentEventByIdempotencyKey: vi.fn().mockReturnValue(null),
      insertSemanticEnrichmentEvent: vi.fn(),
      getSemanticEnrichmentEvent: vi.fn().mockReturnValue({
        id: 'evt-chat-queued',
        status: 'pending',
        updated_at: Date.now(),
        last_error: null,
      }),
    };

    const descriptor = queueLocalAgentSemanticEnrichmentBestEffort({
      config: makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            capabilities: {
              semanticEnrichment: true,
            },
          },
        },
      }),
      dashDb: dashDb as any,
      integrationId: 'openclaw',
      kind: 'chat_turn',
      payload: {
        kind: 'chat_turn',
        sessionId: 'openclaw:dkg-ui',
        turnId: 'turn-outage-window',
        contextGraphId: 'agent-context',
        assertionName: 'chat-turns',
        assertionUri: 'did:dkg:context-graph:agent-context/assertion/peer/chat-turns',
        sessionUri: 'urn:dkg:chat:session:openclaw:dkg-ui',
        turnUri: 'urn:dkg:chat:turn:turn-outage-window',
        userMessage: 'remember this',
        assistantReply: 'noted',
        persistenceState: 'stored',
      },
      skipWhenUnavailable: true,
      logLabel: 'chat outage window',
    });

    expect(canQueueLocalAgentSemanticEnrichment(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          capabilities: {
            semanticEnrichment: true,
          },
        },
      },
    }), 'openclaw')).toBe(true);
    expect(dashDb.insertSemanticEnrichmentEvent).toHaveBeenCalledOnce();
    expect(descriptor).toMatchObject({
      eventId: 'evt-chat-queued',
      status: 'pending',
    });
  });

  it('reuses the stored semantic triple count when an idempotent semantic event already exists', () => {
    const dashDb = {
      getSemanticEnrichmentEventByIdempotencyKey: vi.fn().mockReturnValue({
        id: 'evt-existing',
        status: 'completed',
        semantic_triple_count: 7,
        updated_at: Date.now(),
        last_error: null,
      }),
      insertSemanticEnrichmentEvent: vi.fn(),
      getSemanticEnrichmentEvent: vi.fn(),
    };

    const descriptor = queueLocalAgentSemanticEnrichmentBestEffort({
      config: makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            capabilities: {
              semanticEnrichment: true,
            },
          },
        },
      }),
      dashDb: dashDb as any,
      integrationId: 'openclaw',
      kind: 'file_import',
      payload: {
        kind: 'file_import',
        contextGraphId: 'project-1',
        assertionName: 'roadmap',
        assertionUri: 'did:dkg:context-graph:project-1/assertion/peer/roadmap',
        importStartedAt: '2026-04-15T12:00:00.000Z',
        fileHash: 'sha256:file-1',
        mdIntermediateHash: 'sha256:md-1',
        detectedContentType: 'text/markdown',
      },
      skipWhenUnavailable: true,
      logLabel: 'existing semantic event',
      semanticTripleCount: 0,
    });

    expect(dashDb.insertSemanticEnrichmentEvent).not.toHaveBeenCalled();
    expect(descriptor).toMatchObject({
      eventId: 'evt-existing',
      status: 'completed',
      semanticTripleCount: 7,
    });
  });

  it('swallows enqueue failures so the primary route can still succeed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dashDb = {
      getSemanticEnrichmentEventByIdempotencyKey: vi.fn().mockReturnValue(null),
      insertSemanticEnrichmentEvent: vi.fn(() => {
        throw new Error('sqlite busy');
      }),
      getSemanticEnrichmentEvent: vi.fn(),
    };

    const descriptor = queueLocalAgentSemanticEnrichmentBestEffort({
      config: makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            capabilities: {
              semanticEnrichment: true,
            },
            transport: {
              kind: 'openclaw-channel',
              wakeUrl: 'http://127.0.0.1:9301/semantic-enrichment/wake',
              wakeAuth: 'bridge-token',
            },
          },
        },
      }),
      dashDb: dashDb as any,
      integrationId: 'openclaw',
      kind: 'chat_turn',
      payload: {
        kind: 'chat_turn',
        sessionId: 'openclaw:dkg-ui',
        turnId: 'turn-1',
        contextGraphId: 'agent-context',
        assertionName: 'chat-turns',
        assertionUri: 'did:dkg:context-graph:agent-context/assertion/peer/chat-turns',
        sessionUri: 'urn:dkg:chat:session:openclaw:dkg-ui',
        turnUri: 'urn:dkg:chat:turn:turn-1',
        userMessage: 'hi',
        assistantReply: 'hello',
        persistenceState: 'stored',
      },
      bridgeAuthToken: 'bridge-token',
      skipWhenUnavailable: true,
      logLabel: 'chat turn test',
    });

    expect(descriptor).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enqueue chat turn test'),
    );
  });
});

describe('file import semantic source identity matching', () => {
  const payload = {
    kind: 'file_import' as const,
    contextGraphId: 'cg1',
    assertionName: 'roadmap',
    assertionUri: 'did:dkg:context-graph:cg1/assertion/peer/roadmap',
    importStartedAt: '2026-04-15T12:00:00.000Z',
    fileHash: 'sha256:file-1',
    mdIntermediateHash: 'sha256:md-1',
    detectedContentType: 'text/markdown',
  };

  it('accepts the current assertion only when file and markdown hashes still match the queued job', () => {
    expect(fileImportSourceIdentityMatchesCurrentState(payload, {
      fileHash: 'sha256:file-1',
      mdIntermediateHash: 'sha256:md-1',
      importStartedAt: '2026-04-15T12:00:00.000Z',
    })).toBe(true);
  });

  it('rejects replaced or discarded assertion state when the source identity no longer matches', () => {
    expect(fileImportSourceIdentityMatchesCurrentState(payload, null)).toBe(false);
    expect(fileImportSourceIdentityMatchesCurrentState(payload, {
      fileHash: 'sha256:file-2',
      mdIntermediateHash: 'sha256:md-1',
      importStartedAt: '2026-04-15T12:00:00.000Z',
    })).toBe(false);
    expect(fileImportSourceIdentityMatchesCurrentState(payload, {
      fileHash: 'sha256:file-1',
      mdIntermediateHash: 'sha256:md-2',
      importStartedAt: '2026-04-15T12:00:00.000Z',
    })).toBe(false);
    expect(fileImportSourceIdentityMatchesCurrentState(payload, {
      fileHash: 'sha256:file-1',
      mdIntermediateHash: 'sha256:md-1',
      importStartedAt: '2026-04-15T12:05:00.000Z',
    })).toBe(false);
  });

  it('decodes queried RDF literals back to plain string values before identity matching', () => {
    expect(normalizeQueriedLiteralValue('"sha256:file-1"')).toBe('sha256:file-1');
    expect(normalizeQueriedLiteralValue('"sha256:md-1"')).toBe('sha256:md-1');
    expect(normalizeQueriedLiteralValue('"2026-04-15T12:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>'))
      .toBe('2026-04-15T12:00:00.000Z');
    expect(normalizeQueriedLiteralValue('<did:dkg:context-graph:cg1/assertion/peer/roadmap>'))
      .toBe('did:dkg:context-graph:cg1/assertion/peer/roadmap');
  });
});

describe('semantic enrichment triple count readers', () => {
  it('reuses semantic provenance counts for replayed chat-turn events', async () => {
    const agent = {
      store: {
        query: vi.fn().mockResolvedValue({
          bindings: [{ count: '"4"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
        }),
      },
    };

    await expect(readSemanticTripleCountForEvent(
      agent as any,
      {
        kind: 'chat_turn',
        sessionId: 'openclaw:dkg-ui',
        turnId: 'turn-1',
        contextGraphId: 'agent-context',
        assertionName: 'chat-turns',
        assertionUri: 'did:dkg:context-graph:agent-context/assertion/peer/chat-turns',
        sessionUri: 'urn:dkg:chat:session:openclaw:dkg-ui',
        turnUri: 'urn:dkg:chat:turn:turn-1',
        userMessage: 'hello',
        assistantReply: 'hi',
        persistenceState: 'stored',
      },
      'evt-chat-replay',
    )).resolves.toBe(4);

    expect(agent.store.query).toHaveBeenCalledWith(expect.stringContaining('urn:dkg:semantic-enrichment:evt-chat-replay'));
  });
});

describe('ontology write object normalization', () => {
  it('rejects malformed quoted RDF literals', () => {
    expect(normalizeOntologyQuadObjectInput('\"unterminated')).toBeUndefined();
    expect(normalizeOntologyQuadObjectInput('\"value\"^^<not a valid iri>')).toBeUndefined();
  });

  it('preserves valid RDF terms and quotes plain text values', () => {
    expect(normalizeOntologyQuadObjectInput('https://schema.org/Person')).toBe('https://schema.org/Person');
    expect(normalizeOntologyQuadObjectInput('\"Alice\"@en')).toBe('\"Alice\"@en');
    expect(normalizeOntologyQuadObjectInput('schema.org')).toBe('\"schema.org\"');
  });
});

describe('OpenClaw UI setup command resolution', () => {
  const runtimeModuleUrl = 'file:///C:/Projects/dkg-v9/packages/cli/dist/daemon.js';

  it('prefers the local workspace adapter setup CLI when it exists', () => {
    const command = getOpenClawUiSetupCommand(
      '@origintrail-official/dkg-adapter-openclaw',
      runtimeModuleUrl,
      (path) => /packages[\\/]adapter-openclaw[\\/]dist[\\/]setup-cli\.js$/.test(path),
    );

    expect(command.source).toBe('workspace');
    expect(command.command).toBe(process.execPath);
    expect(command.args[0]).toMatch(/packages[\\/]adapter-openclaw[\\/]dist[\\/]setup-cli\.js$/);
    expect(command.args.slice(1)).toEqual(['setup', '--no-fund', '--no-start', '--no-verify']);
  });

  it('falls back to npx when the local adapter build is unavailable', () => {
    const command = getOpenClawUiSetupCommand(
      '@origintrail-official/dkg-adapter-openclaw',
      runtimeModuleUrl,
      () => false,
    );

    expect(command).toEqual({
      command: 'npx',
      args: ['--yes', '@origintrail-official/dkg-adapter-openclaw', 'setup', '--no-fund', '--no-start', '--no-verify'],
      source: 'npx',
    });
  });

  it('resolves workspace package bins from the repo root instead of packages/packages', () => {
    const command = getOpenClawUiSetupCommand(
      '@origintrail-official/dkg-adapter-hermes',
      runtimeModuleUrl,
      () => true,
      {
        readDirNames: (path) => {
          expect(path).toMatch(/dkg-v9[\\/]packages$/);
          return ['adapter-hermes'];
        },
        readFileText: (path) => {
          expect(path).toMatch(/packages[\\/]adapter-hermes[\\/]package\.json$/);
          return JSON.stringify({
            name: '@origintrail-official/dkg-adapter-hermes',
            bin: 'dist/setup-cli.js',
          });
        },
      },
    );

    expect(command.source).toBe('workspace');
    expect(command.command).toBe(process.execPath);
    expect(command.args[0]).toMatch(/packages[\\/]adapter-hermes[\\/]dist[\\/]setup-cli\.js$/);
  });
});

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
    const store = { query: vi.fn() };
    const extractionStatus = new Map([
      ['did:dkg:context-graph:cg1/assertion/chat-doc', {
        status: 'completed',
        fileHash: 'sha256:abc123',
        fileName: 'chat-doc.pdf',
        detectedContentType: 'application/pdf',
        pipelineUsed: 'application/pdf',
        tripleCount: 42,
        semanticEnrichment: {
          eventId: 'evt-semantic-1',
          status: 'completed',
          semanticTripleCount: 9,
          updatedAt: completedAt,
        },
        rootEntity: 'did:dkg:context-graph:cg1/assertion/chat-doc',
        startedAt,
        completedAt,
      }],
    ]);

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, extractionStatus as any, attachmentRefs),
    ).resolves.toEqual(attachmentRefs);
    expect(store.query).not.toHaveBeenCalled();
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
    const store = { query: vi.fn() };
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
    expect(store.query).not.toHaveBeenCalled();
  });

  it('accepts sub-graph attachment refs and verifies them against the root meta graph', async () => {
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/decisions/assertion/0xAgent/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      extractionStatus: 'completed' as const,
    }];
    const store = {
      query: vi.fn().mockResolvedValue({
        bindings: [{
          fileHash: '"sha256:abc123"',
          contentType: '"application/pdf"',
          sourceFileName: '"chat-doc.pdf"',
        }],
      }),
    };

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, new Map(), attachmentRefs),
    ).resolves.toEqual(attachmentRefs);
    expect(String(store.query.mock.calls[0][0])).toContain('GRAPH <did:dkg:context-graph:cg1/_meta>');
    expect(String(store.query.mock.calls[0][0])).not.toContain('did:dkg:context-graph:cg1/decisions/_meta');
    expect(String(store.query.mock.calls[0][0])).toContain('<did:dkg:context-graph:cg1/decisions/assertion/0xAgent/chat-doc>');
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
      query: vi.fn().mockResolvedValue({
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
      query: vi.fn().mockResolvedValue({
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

  it('rejects completed attachment refs after the extraction cache entry is gone and the meta graph no longer has the assertion', async () => {
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      extractionStatus: 'completed' as const,
    }];
    const store = {
      query: vi.fn().mockResolvedValue({ bindings: [] }),
    };

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, new Map(), attachmentRefs),
    ).resolves.toBeUndefined();
    expect(store.query).toHaveBeenCalledOnce();
  });

  it('rejects attachment refs when the stored source file name does not match', async () => {
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'spoofed.pdf',
      extractionStatus: 'completed' as const,
    }];
    const store = {
      query: vi.fn().mockResolvedValue({
        bindings: [{
          fileHash: '"sha256:abc123"',
          sourceFileName: '"chat-doc.pdf"',
        }],
      }),
    };

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, new Map(), attachmentRefs),
    ).resolves.toBeUndefined();
  });

  it('rejects forged attachment refs when graph metadata does not match', async () => {
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:forged',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      extractionStatus: 'completed' as const,
    }];
    const store = {
      query: vi.fn().mockResolvedValue({
        bindings: [{
          fileHash: '"sha256:real"',
          contentType: '"application/pdf"',
          tripleCount: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        }],
      }),
    };

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, new Map(), attachmentRefs),
    ).resolves.toBeUndefined();
  });

  it('accepts explicit failed and pending persistence states', () => {
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'hi',
      assistantReply: '',
      persistenceState: 'failed',
    })).toBe(true);
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'hi',
      assistantReply: '',
      persistenceState: 'pending',
    })).toBe(true);
  });

  it('rejects unknown persistence states', () => {
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'hi',
      assistantReply: '',
      persistenceState: 'cancelled',
    })).toBe(false);
  });

  it('accepts string/null failure reasons and rejects invalid ones', () => {
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'hi',
      assistantReply: '',
      persistenceState: 'failed',
      failureReason: 'timeout',
    })).toBe(true);
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'hi',
      assistantReply: '',
      persistenceState: 'failed',
      failureReason: null,
    })).toBe(true);
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'hi',
      assistantReply: '',
      persistenceState: 'failed',
      failureReason: { code: 'timeout' },
    })).toBe(false);
  });
});

describe('daemon loopback request handling', () => {
  it('treats local IPv4 and IPv6 addresses as loopback clients', () => {
    expect(isLoopbackClientIp('127.0.0.1')).toBe(true);
    expect(isLoopbackClientIp('127.0.0.42')).toBe(true);
    expect(isLoopbackClientIp('::1')).toBe(true);
    expect(isLoopbackClientIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('does not treat non-loopback addresses as local clients', () => {
    expect(isLoopbackClientIp('192.168.1.10')).toBe(false);
    expect(isLoopbackClientIp('10.0.0.5')).toBe(false);
    expect(isLoopbackClientIp('::ffff:192.168.1.10')).toBe(false);
  });

  it('bypasses rate limiting for loopback node-ui and local-agent traffic, but not remote clients', () => {
    expect(shouldBypassRateLimitForLoopbackTraffic('127.0.0.1', '/ui')).toBe(true);
    expect(shouldBypassRateLimitForLoopbackTraffic('127.0.0.1', '/ui/assets/index.js')).toBe(true);
    expect(shouldBypassRateLimitForLoopbackTraffic('127.0.0.1', '/api/paranet/list')).toBe(true);
    expect(shouldBypassRateLimitForLoopbackTraffic('127.0.0.1', '/api/query')).toBe(true);
    expect(shouldBypassRateLimitForLoopbackTraffic('127.0.0.1', '/api/openclaw-channel/persist-turn')).toBe(true);
    expect(shouldBypassRateLimitForLoopbackTraffic('::1', '/api/local-agent-integrations')).toBe(true);
    expect(shouldBypassRateLimitForLoopbackTraffic('127.0.0.1', '/.well-known/skill.md')).toBe(true);
    expect(shouldBypassRateLimitForLoopbackTraffic('127.0.0.1', '/network/testnet.json')).toBe(false);
    expect(shouldBypassRateLimitForLoopbackTraffic('192.168.1.10', '/api/query')).toBe(false);
  });
});

describe('local agent integration registry helpers', () => {
  it('normalizes plain enabled:false local-agent updates into explicit disconnect patches', () => {
    const normalized = normalizeExplicitLocalAgentDisconnectBody({
      enabled: false,
      metadata: { source: 'node-ui' },
    });

    expect(normalized).toEqual({
      enabled: false,
      metadata: { source: 'node-ui' },
      runtime: {
        status: 'disconnected',
        ready: false,
        lastError: null,
      },
    });
  });

  it('normalizes runtime-only disconnect patches into disabled local-agent updates', () => {
    const normalized = normalizeExplicitLocalAgentDisconnectBody({
      runtime: {
        status: 'disconnected',
        ready: true,
        lastError: 'stale error',
      },
      metadata: { source: 'node-ui' },
    });

    expect(normalized).toEqual({
      enabled: false,
      metadata: { source: 'node-ui' },
      runtime: {
        status: 'disconnected',
        ready: false,
        lastError: 'stale error',
      },
    });
  });

  it('lists built-in local integrations even before they are connected', () => {
    const integrations = listLocalAgentIntegrations(makeConfig());
    const openclaw = integrations.find((integration) => integration.id === 'openclaw');

    expect(integrations.map((integration) => integration.id)).toEqual(['hermes', 'openclaw']);
    expect(integrations.every((integration) => integration.enabled === false)).toBe(true);
    expect(integrations.every((integration) => integration.status === 'disconnected')).toBe(true);
    expect(openclaw?.capabilities.chatAttachments).toBeUndefined();
  });

  it('ignores stale legacy OpenClaw config flags when no local-agent registry record exists', () => {
    const config = makeConfig() as DkgConfig & {
      openclawAdapter?: boolean;
      openclawChannel?: { bridgeUrl?: string };
    };
    config.openclawAdapter = true;
    config.openclawChannel = {
      bridgeUrl: 'http://127.0.0.1:9301',
    };

    expect(hasConfiguredLocalAgentChat(config, 'openclaw')).toBe(false);
    expect(getLocalAgentIntegration(config, 'openclaw')?.enabled).toBe(false);
  });

  it('connects OpenClaw through the generic registry without backfilling legacy top-level config', () => {
    const config = makeConfig();

    const integration = connectLocalAgentIntegration(config, {
      id: 'openclaw',
      manifest: {
        packageName: '@dkg/openclaw-adapter',
        version: '2026.4.12',
        setupEntry: './setup-entry.js',
      },
      transport: {
        kind: 'openclaw-channel',
        gatewayUrl: 'http://gateway.local:3030',
      },
      runtime: {
        status: 'ready',
        ready: true,
      },
      metadata: {
        runtimeMode: 'deferred',
      },
    }, new Date('2026-04-13T09:00:00.000Z'));

    expect(integration.id).toBe('openclaw');
    expect(integration.enabled).toBe(true);
    expect(integration.status).toBe('ready');
    expect(integration.manifest?.version).toBe('2026.4.12');
    expect(integration.capabilities.chatAttachments).toBeUndefined();
    expect((config as Record<string, unknown>).openclawAdapter).toBeUndefined();
    expect((config as Record<string, unknown>).openclawChannel).toBeUndefined();
  });

  it('preserves adapter-advertised OpenClaw attachment capability when it is explicitly provided', () => {
    const config = makeConfig();

    const integration = connectLocalAgentIntegration(config, {
      id: 'openclaw',
      capabilities: {
        localChat: true,
        chatAttachments: true,
      },
    });

    expect(integration.capabilities.chatAttachments).toBe(true);
  });

  it('marks explicit OpenClaw disconnects as user-disabled and clears that flag on reconnect', () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          metadata: {
            source: 'node-ui',
          },
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9201',
          },
        },
      },
    });

    const disconnected = updateLocalAgentIntegration(config, 'openclaw', {
      enabled: false,
      runtime: {
        status: 'disconnected',
        ready: false,
        lastError: null,
      },
    });

    expect(disconnected.enabled).toBe(false);
    expect(disconnected.metadata?.userDisabled).toBe(true);

    const reconnected = connectLocalAgentIntegration(config, {
      id: 'openclaw',
      metadata: {
        source: 'node-ui',
      },
    });

    expect(reconnected.enabled).toBe(true);
    expect(reconnected.metadata?.userDisabled).toBe(false);
  });

  it('forces runtime-status disconnect updates into a disabled stored integration', () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          capabilities: {
            localChat: true,
          },
          metadata: {
            source: 'node-ui',
          },
          runtime: {
            status: 'ready',
            ready: true,
          },
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9201',
          },
        },
      },
    });

    const disconnected = updateLocalAgentIntegration(config, 'openclaw', {
      runtime: {
        status: 'disconnected',
        ready: true,
      },
    });

    expect(disconnected.enabled).toBe(false);
    expect(disconnected.status).toBe('disconnected');
    expect(disconnected.runtime.ready).toBe(false);
    expect(disconnected.metadata?.userDisabled).toBe(true);
    expect(hasConfiguredLocalAgentChat(config, 'openclaw')).toBe(false);
    expect(getOpenClawChannelTargets(config)).toEqual([]);
  });

  it('UI connect marks OpenClaw ready immediately when the local bridge is already healthy for an already attached integration', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9201',
            wakeUrl: 'http://127.0.0.1:9201/semantic-enrichment/wake',
            wakeAuth: 'bridge-token',
          },
        },
      },
    });
    const runSetup = vi.fn();
    const restartGateway = vi.fn();
    const waitForReady = vi.fn();
    const probeHealth = vi.fn().mockResolvedValue({
      ok: true,
      target: 'bridge',
    });

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      { runSetup, restartGateway, waitForReady, probeHealth },
    );

    expect(runSetup).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
    expect(waitForReady).not.toHaveBeenCalled();
    expect(result.integration.status).toBe('ready');
    expect(result.integration.runtime.ready).toBe(true);
    expect(result.integration.transport.bridgeUrl).toBe('http://127.0.0.1:9201');
    expect(result.integration.transport.wakeUrl).toBe('http://127.0.0.1:9201/semantic-enrichment/wake');
    expect(result.integration.transport.wakeAuth).toBe('bridge-token');
    expect(result.notice).toBe('OpenClaw is connected and chat-ready.');
  });

  it('UI reconnect keeps the healthy-bridge fast path after a manual OpenClaw disconnect', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: false,
          metadata: {
            source: 'node-ui',
            userDisabled: true,
          },
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9201',
          },
          runtime: {
            status: 'disconnected',
            ready: false,
          },
        },
      },
    });
    const runSetup = vi.fn();
    const restartGateway = vi.fn();
    const waitForReady = vi.fn();
    const probeHealth = vi.fn().mockResolvedValue({
      ok: true,
      target: 'bridge',
    });

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      { runSetup, restartGateway, waitForReady, probeHealth },
    );

    expect(runSetup).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
    expect(waitForReady).not.toHaveBeenCalled();
    expect(result.integration.status).toBe('ready');
    expect(result.integration.runtime.ready).toBe(true);
    expect(result.integration.metadata?.userDisabled).toBe(false);
    expect(result.integration.transport.wakeUrl).toBe('http://127.0.0.1:9201/semantic-enrichment/wake');
    expect(result.integration.transport.wakeAuth).toBe('bridge-token');
    expect(result.notice).toBe('OpenClaw is connected and chat-ready.');
  });

  it('treats a stored wake-only OpenClaw transport as enough to reuse the healthy-bridge fast path', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            wakeUrl: 'http://bridge.remote:9305/semantic-enrichment/wake',
            wakeAuth: 'bridge-token',
          },
        },
      },
    });
    const runSetup = vi.fn();
    const restartGateway = vi.fn();
    const waitForReady = vi.fn();
    const probeHealth = vi.fn().mockResolvedValue({
      ok: true,
      target: 'bridge',
    });

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      { runSetup, restartGateway, waitForReady, probeHealth },
    );

    expect(runSetup).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
    expect(waitForReady).not.toHaveBeenCalled();
    expect(result.integration.status).toBe('ready');
    expect(result.integration.transport.bridgeUrl).toBe('http://bridge.remote:9305');
    expect(result.integration.transport.wakeUrl).toBe('http://bridge.remote:9305/semantic-enrichment/wake');
    expect(result.integration.transport.wakeAuth).toBe('bridge-token');
  });

  it('UI connect does not trust a healthy bridge fast-path for a first-time attach', async () => {
    const config = makeConfig();
    const runSetup = vi.fn().mockResolvedValue(undefined);
    const restartGateway = vi.fn().mockResolvedValue(undefined);
    const waitForReady = vi.fn().mockResolvedValue({
      ok: true,
      target: 'bridge',
    });
    const probeHealth = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        target: 'bridge',
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'bridge still starting',
      });
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    let attachJob: Promise<void> | null = null;

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      {
        runSetup,
        restartGateway,
        waitForReady,
        probeHealth,
        saveConfig,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    expect(runSetup).toHaveBeenCalledTimes(1);
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;
    expect(restartGateway).toHaveBeenCalledTimes(1);
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.status).toBe('ready');
    expect(integration?.runtime.ready).toBe(true);
  });

  it('does not leave a failed first-time OpenClaw attach marked as connected', async () => {
    const config = makeConfig();
    const runSetup = vi.fn().mockRejectedValue(new Error('setup failed'));
    const restartGateway = vi.fn();
    const waitForReady = vi.fn();
    const probeHealth = vi.fn().mockResolvedValue({
      ok: false,
      error: 'bridge offline',
    });
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    let attachJob: Promise<void> | null = null;

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      {
        runSetup,
        restartGateway,
        waitForReady,
        probeHealth,
        saveConfig,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;

    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.enabled).toBe(false);
    expect(integration?.status).toBe('error');
    expect(integration?.runtime.ready).toBe(false);
    expect(integration?.runtime.lastError).toBe('setup failed');
    expect(integration?.metadata?.userDisabled).not.toBe(true);
    expect(saveConfig).toHaveBeenCalled();
  });

  it('keeps an already attached OpenClaw integration enabled when a UI reconnect attempt fails', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9201',
            wakeUrl: 'http://127.0.0.1:9201/semantic-enrichment/wake',
            wakeAuth: 'bridge-token',
          },
        },
      },
    });
    const runSetup = vi.fn().mockRejectedValue(new Error('setup failed'));
    const restartGateway = vi.fn();
    const waitForReady = vi.fn();
    const probeHealth = vi.fn().mockResolvedValue({
      ok: false,
      error: 'bridge offline',
    });
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    let attachJob: Promise<void> | null = null;

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      {
        runSetup,
        restartGateway,
        waitForReady,
        probeHealth,
        saveConfig,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;

    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.enabled).toBe(true);
    expect(integration?.status).toBe('error');
    expect(integration?.transport.bridgeUrl).toBe('http://127.0.0.1:9201');
    expect(integration?.transport.wakeUrl).toBe('http://127.0.0.1:9201/semantic-enrichment/wake');
    expect(integration?.transport.wakeAuth).toBe('bridge-token');
    expect(saveConfig).toHaveBeenCalled();
  });

  it('UI connect runs OpenClaw setup, restarts the gateway, and leaves the integration in connecting state while the gateway is still coming up', async () => {
    const config = makeConfig();
    const runSetup = vi.fn().mockResolvedValue(undefined);
    const restartGateway = vi.fn().mockResolvedValue(undefined);
    const waitForReady = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        error: 'bridge still starting',
      });
    const probeHealth = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'bridge offline',
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'bridge still starting',
      });
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    let attachJob: Promise<void> | null = null;

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      {
        runSetup,
        restartGateway,
        waitForReady,
        probeHealth,
        saveConfig,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    expect(result.integration.runtime.ready).toBe(false);
    expect(result.notice).toContain('come online automatically');
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;

    expect(runSetup).toHaveBeenCalledWith('@origintrail-official/dkg-adapter-openclaw', expect.anything());
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(waitForReady).toHaveBeenCalledTimes(1);
    expect(probeHealth).toHaveBeenCalledTimes(2);
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.status).toBe('connecting');
    expect(integration?.runtime.ready).toBe(false);
    expect(integration?.runtime.lastError).toBe('bridge still starting');
    expect(saveConfig).toHaveBeenCalled();
  });

  it('UI connect retries OpenClaw readiness after a gateway restart and reports chat-ready when the bridge comes up', async () => {
    const config = makeConfig();
    const runSetup = vi.fn().mockResolvedValue(undefined);
    const restartGateway = vi.fn().mockResolvedValue(undefined);
    const waitForReady = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        target: 'bridge',
      });
    const probeHealth = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'bridge offline',
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'bridge still starting',
      });
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    let attachJob: Promise<void> | null = null;

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      {
        runSetup,
        restartGateway,
        waitForReady,
        probeHealth,
        saveConfig,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;

    expect(runSetup).toHaveBeenCalledWith('@origintrail-official/dkg-adapter-openclaw', expect.anything());
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(waitForReady).toHaveBeenCalledTimes(1);
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.status).toBe('ready');
    expect(integration?.runtime.ready).toBe(true);
    expect(integration?.transport.bridgeUrl).toBe('http://127.0.0.1:9201');
    expect(integration?.transport.wakeUrl).toBe('http://127.0.0.1:9201/semantic-enrichment/wake');
    expect(integration?.transport.wakeAuth).toBe('bridge-token');
    expect(saveConfig).toHaveBeenCalled();
  });

  it('cancels a pending OpenClaw attach job when the integration is disconnected before attach finishes', async () => {
    const config = makeConfig();
    let releaseSetup!: () => void;
    const runSetup = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      releaseSetup = resolve;
    }));
    const restartGateway = vi.fn().mockResolvedValue(undefined);
    const waitForReady = vi.fn();
    const probeHealth = vi.fn().mockResolvedValue({
      ok: false,
      error: 'bridge offline',
    });
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    let attachJob: Promise<void> | null = null;

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      {
        runSetup,
        restartGateway,
        waitForReady,
        probeHealth,
        saveConfig,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    cancelPendingLocalAgentAttachJob('openclaw');
    updateLocalAgentIntegration(config, 'openclaw', {
      enabled: false,
      runtime: {
        status: 'disconnected',
        ready: false,
        lastError: null,
      },
    });
    releaseSetup();
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;

    expect(restartGateway).not.toHaveBeenCalled();
    expect(waitForReady).not.toHaveBeenCalled();
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.enabled).toBe(false);
    expect(integration?.status).toBe('disconnected');
    expect(integration?.runtime.lastError).toBeNull();
  });

  it('cancels readiness polling when the integration is disconnected mid-attach', async () => {
    const config = makeConfig();
    const runSetup = vi.fn().mockResolvedValue(undefined);
    const restartGateway = vi.fn().mockResolvedValue(undefined);
    let markWaitForReadyStarted!: () => void;
    const waitForReadyStarted = new Promise<void>((resolve) => {
      markWaitForReadyStarted = resolve;
    });
    const waitForReady = vi.fn().mockImplementation((_cfg, _token, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      markWaitForReadyStarted();
      const onAbort = () => reject(new Error('OpenClaw attach cancelled'));
      if (!signal) return;
      if (signal.aborted) {
        reject(new Error('OpenClaw attach cancelled'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }));
    const probeHealth = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'bridge offline',
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'still starting',
      });
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    let attachJob: Promise<void> | null = null;

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      {
        runSetup,
        restartGateway,
        waitForReady,
        probeHealth,
        saveConfig,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    await waitForReadyStarted;
    cancelPendingLocalAgentAttachJob('openclaw');
    updateLocalAgentIntegration(config, 'openclaw', {
      enabled: false,
      runtime: {
        status: 'disconnected',
        ready: false,
        lastError: null,
      },
    });
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;

    expect(runSetup).toHaveBeenCalledWith('@origintrail-official/dkg-adapter-openclaw', expect.anything());
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(waitForReady).toHaveBeenCalledTimes(1);
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.enabled).toBe(false);
    expect(integration?.status).toBe('disconnected');
    expect(integration?.runtime.lastError).toBeNull();
  });

  it('rechecks OpenClaw bridge health quickly after a cached failure so recovery is not sticky', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:00:00.000Z'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: false, error: 'offline' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: true, channel: 'dkg-ui' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));

    try {
      const config = makeConfig();
      const first = await probeOpenClawChannelHealth(config, 'bridge-token', { ignoreBridgeCache: true });
      expect(first.ok).toBe(false);

      vi.setSystemTime(new Date('2026-04-13T12:00:01.500Z'));
      const second = await probeOpenClawChannelHealth(config, 'bridge-token');

      expect(second.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('updates a stored integration without dropping nested metadata', () => {
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          metadata: {
            source: 'ui',
            manifestMode: 'setup-entry',
          },
          runtime: {
            status: 'connecting',
          },
        },
      },
    });

    const integration = updateLocalAgentIntegration(config, 'hermes', {
      runtime: {
        status: 'ready',
        ready: true,
      },
      metadata: {
        manifestVersion: '1.2.3',
      },
    }, new Date('2026-04-13T10:15:00.000Z'));

    expect(integration.status).toBe('ready');
    expect(integration.runtime.ready).toBe(true);
    expect(integration.metadata).toEqual({
      source: 'ui',
      manifestMode: 'setup-entry',
      manifestVersion: '1.2.3',
    });
  });

  it('replaces stored transport hints so stale OpenClaw gateway URLs do not linger', () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            gatewayUrl: 'http://gateway.local:3030',
          },
          runtime: {
            status: 'ready',
            ready: true,
          },
        },
      },
    }) as DkgConfig & {
      openclawAdapter?: boolean;
      openclawChannel?: { gatewayUrl?: string };
    };
    config.openclawAdapter = true;
    config.openclawChannel = {
      gatewayUrl: 'http://gateway.local:3030',
    };

    const integration = updateLocalAgentIntegration(config, 'openclaw', {
      transport: {
        kind: 'openclaw-channel',
        bridgeUrl: 'http://127.0.0.1:9301',
        healthUrl: 'http://127.0.0.1:9301/health',
      },
      runtime: {
        status: 'ready',
        ready: true,
      },
    }, new Date('2026-04-13T10:45:00.000Z'));

    expect(integration.transport.bridgeUrl).toBe('http://127.0.0.1:9301');
    expect(integration.transport.gatewayUrl).toBeUndefined();
    expect(integration.transport.wakeUrl).toBeUndefined();
    expect((config as Record<string, unknown>).openclawAdapter).toBeUndefined();
    expect((config as Record<string, unknown>).openclawChannel).toBeUndefined();
  });

  it('preserves wake transport metadata when OpenClaw updates still use the legacy top-level transport shim', () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9201',
          },
        },
      },
    });

    const integration = updateLocalAgentIntegration(config, 'openclaw', {
      bridgeUrl: 'http://127.0.0.1:9301',
      healthUrl: 'http://127.0.0.1:9301/health',
      wakeUrl: 'http://127.0.0.1:9301/semantic-enrichment/wake',
      wakeAuth: 'bridge-token',
      runtime: {
        status: 'ready',
        ready: true,
      },
    }, new Date('2026-04-13T10:50:00.000Z'));

    expect(integration.transport.bridgeUrl).toBe('http://127.0.0.1:9301');
    expect(integration.transport.healthUrl).toBe('http://127.0.0.1:9301/health');
    expect(integration.transport.wakeUrl).toBe('http://127.0.0.1:9301/semantic-enrichment/wake');
    expect(integration.transport.wakeAuth).toBe('bridge-token');
  });
});

describe('parseRequiredSignatures', () => {
  it('returns 0 (omitted) for undefined', () => {
    expect(parseRequiredSignatures(undefined)).toEqual({ value: 0 });
  });

  it('rejects explicit null (serialized NaN/Infinity)', () => {
    expect(parseRequiredSignatures(null)).toEqual({ error: 'requiredSignatures must be a number' });
  });

  it('accepts valid positive integers', () => {
    expect(parseRequiredSignatures(1)).toEqual({ value: 1 });
    expect(parseRequiredSignatures(3)).toEqual({ value: 3 });
    expect(parseRequiredSignatures(100)).toEqual({ value: 100 });
  });

  it('rejects non-number types (boolean, string, array)', () => {
    expect(parseRequiredSignatures(true)).toEqual({ error: 'requiredSignatures must be a number' });
    expect(parseRequiredSignatures('3')).toEqual({ error: 'requiredSignatures must be a number' });
    expect(parseRequiredSignatures([2])).toEqual({ error: 'requiredSignatures must be a number' });
  });

  it('rejects zero, negative, and fractional numbers', () => {
    expect(parseRequiredSignatures(0)).toEqual({ error: 'requiredSignatures must be a positive integer (>= 1)' });
    expect(parseRequiredSignatures(-1)).toEqual({ error: 'requiredSignatures must be a positive integer (>= 1)' });
    expect(parseRequiredSignatures(1.5)).toEqual({ error: 'requiredSignatures must be a positive integer (>= 1)' });
    expect(parseRequiredSignatures(NaN)).toEqual({ error: 'requiredSignatures must be a positive integer (>= 1)' });
  });
});
