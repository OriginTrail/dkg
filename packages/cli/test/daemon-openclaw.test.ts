import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenClawChannelHeaders,
  cancelPendingLocalAgentAttachJob,
  connectLocalAgentIntegrationFromUi,
  connectLocalAgentIntegration,
  getLocalAgentIntegration,
  getOpenClawChannelTargets,
  hasConfiguredLocalAgentChat,
  hasOpenClawChatTurnContent,
  isLoopbackClientIp,
  isSafeBridgeTokenWakeUrl,
  isOpenClawMemorySlotElected,
  normalizeOpenClawAttachmentRefs,
  isValidOpenClawPersistTurnPayload,
  listLocalAgentIntegrations,
  notifyLocalAgentIntegrationWake,
  canQueueLocalAgentSemanticEnrichment,
  queueLocalAgentSemanticEnrichmentBestEffort,
  reconcileOpenClawSemanticAvailability,
  saveConfigAndReconcileOpenClawSemanticAvailability,
  getHydratedExtractionStatusRecord,
  handleSemanticEnrichmentRoutes,
  fileImportSourceIdentityMatchesCurrentState,
  normalizeQueriedLiteralValue,
  normalizeOntologyQuadObjectInput,
  parseRequiredSignatures,
  pipeOpenClawStream,
  probeOpenClawChannelHealth,
  isAuthorizedLocalAgentSemanticWorkerRequest,
  requestAdvertisesLocalAgentSemanticEnrichment,
  requestLocalAgentWakeTransport,
  refreshLocalAgentIntegrationFromUi,
  reverseLocalAgentSetupForUi,
  runOpenClawUiSetup,
  verifyOpenClawAttachmentRefsProvenance,
  normalizeExplicitLocalAgentDisconnectBody,
  readSemanticTripleCountForEvent,
  buildSemanticAppendQuads,
  buildFileSemanticEventPayload,
  semanticWorkerDidFromLeaseOwner,
  resolveChatTurnsAssertionAgentAddress,
  shouldBypassRateLimitForLoopbackTraffic,
  updateLocalAgentIntegration,
  inferSafeLocalAgentWakeAuthFromUrl,
} from '../src/daemon.js';
import { mergeOpenClawConfig, type AdapterEntryConfig } from '@origintrail-official/dkg-adapter-openclaw';
import type { DkgConfig } from '../src/config.js';

// Default entryConfig fixture matching the shape `runSetup` builds at
// Step 5 — same values setup writes into plugins.entries.adapter-openclaw.config.
const testEntryConfig: AdapterEntryConfig = {
  daemonUrl: 'http://127.0.0.1:9200',
  memory: { enabled: true },
  channel: { enabled: true },
};

function semanticPayloadHashForTest(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

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

  it('does not synthesize normal chat targets from a wake-only transport', () => {
    expect(getOpenClawChannelTargets(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            wakeUrl: 'http://wake-only.local:9301/semantic-enrichment/wake',
            wakeAuth: 'bridge-token',
          },
        },
      },
    }))).toEqual([
      {
        name: 'bridge',
        inboundUrl: 'http://127.0.0.1:9201/inbound',
        streamUrl: 'http://127.0.0.1:9201/inbound/stream',
        healthUrl: 'http://127.0.0.1:9201/health',
      },
    ]);
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

    let cancelCallCount = 0;
    let releaseCallCount = 0;
    const reader = {
      read: async () => {
        if (writes.length === 0) {
          req.emit('close');
          return { done: false, value: Buffer.from('data: {"type":"text_delta","delta":"pong"}\n\n') };
        }
        return { done: true, value: undefined };
      },
      cancel: async () => { cancelCallCount++; return undefined; },
      releaseLock: () => { releaseCallCount++; },
    };

    await pipeOpenClawStream(req, res, reader);

    expect(cancelCallCount).toBe(0);
    expect(writes).toEqual(['data: {"type":"text_delta","delta":"pong"}\n\n']);
    expect(releaseCallCount).toBe(1);
  });

  it('cancels the upstream stream when the downstream response closes before it finishes', async () => {
    const req = new EventEmitter() as any;
    const res = new EventEmitter() as any;
    let resolveRead!: (value: { done: boolean; value?: Uint8Array }) => void;

    res.writableEnded = false;
    res.write = () => true;
    res.end = () => { res.writableEnded = true; };

    let cancelCallCount = 0;
    let releaseCallCount = 0;
    const reader = {
      read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => { resolveRead = resolve; }),
      cancel: async () => { cancelCallCount++; return undefined; },
      releaseLock: () => { releaseCallCount++; },
    };

    const proxyPromise = pipeOpenClawStream(req, res, reader);
    res.emit('close');
    resolveRead({ done: true });
    await proxyPromise;

    expect(cancelCallCount).toBe(1);
    expect(releaseCallCount).toBe(1);
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
      read: async () => {
        readCount += 1;
        if (readCount === 1) {
          return { done: false, value: Buffer.from('data: first\n\n') };
        }
        secondReadCalled = true;
        return { done: true, value: undefined };
      },
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

  it('uses a safe request-scoped wake transport before the integration record is stored', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await notifyLocalAgentIntegrationWake(
      makeConfig(),
      'openclaw',
      wakePayload,
      'bridge-token',
      fetchSpy as any,
      {
        wakeUrl: 'http://127.0.0.1:9301/semantic-enrichment/wake',
        wakeAuth: 'bridge-token',
      },
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

  it('does not send bridge-token wake requests to non-loopback URLs', async () => {
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
              wakeUrl: 'https://example.com/semantic-enrichment/wake',
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

    expect(result).toEqual({ status: 'skipped', reason: 'wake_unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not send bridge-token wake requests to unexpected loopback paths', async () => {
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
              wakeUrl: 'http://127.0.0.1:9301/custom/wake',
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

    expect(result).toEqual({ status: 'skipped', reason: 'wake_unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not send unauthenticated wake requests to non-loopback URLs', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await notifyLocalAgentIntegrationWake(
      makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            transport: {
              kind: 'openclaw-channel',
              wakeUrl: 'https://example.com/semantic-enrichment/wake',
              wakeAuth: 'none',
            },
          },
        },
      }),
      'openclaw',
      { kind: 'semantic_enrichment', eventKind: 'chat_turn', eventId: 'evt-1' },
      undefined,
      fetchSpy as any,
    );

    expect(result).toEqual({ status: 'skipped', reason: 'wake_unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips gateway wake auth mode because the daemon has no OpenClaw gateway credentials', async () => {
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

    expect(result).toEqual({ status: 'skipped', reason: 'wake_unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('infers bridge-token wake auth from a preserved wakeUrl when wakeAuth is missing', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await notifyLocalAgentIntegrationWake(
      makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            transport: {
              kind: 'openclaw-channel',
              wakeUrl: 'http://127.0.0.1:9301/semantic-enrichment/wake/',
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
      'http://127.0.0.1:9301/semantic-enrichment/wake/',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-dkg-bridge-token': 'bridge-token',
        }),
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
    expect(canQueueLocalAgentSemanticEnrichment(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
          },
        },
      },
    }), 'openclaw', {
      liveSemanticEnrichmentSupported: true,
    })).toBe(true);

    expect(canQueueLocalAgentSemanticEnrichment(makeConfig(), 'openclaw', {
      liveSemanticEnrichmentSupported: true,
    })).toBe(false);

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
      config: makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            transport: {
              kind: 'openclaw-channel',
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

  it('allows queueing for an OpenClaw request while semantic support is still unknown on cold start', () => {
    expect(canQueueLocalAgentSemanticEnrichment(makeConfig(), 'openclaw', {
      requestFromIntegration: true,
    })).toBe(true);

    const dashDb = {
      getSemanticEnrichmentEventByIdempotencyKey: vi.fn().mockReturnValue(null),
      insertSemanticEnrichmentEvent: vi.fn(),
      getSemanticEnrichmentEvent: vi.fn().mockReturnValue({
        id: 'evt-cold-start',
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
        turnId: 'turn-cold-start',
        contextGraphId: 'agent-context',
        assertionName: 'chat-turns',
        assertionUri: 'did:dkg:context-graph:agent-context/assertion/peer/chat-turns',
        sessionUri: 'urn:dkg:chat:session:openclaw:dkg-ui',
        turnUri: 'urn:dkg:chat:turn:turn-cold-start',
        userMessage: 'remember this before sync',
        assistantReply: 'queued',
        persistenceState: 'stored',
      },
      skipWhenUnavailable: true,
      requestFromIntegration: true,
      logLabel: 'chat cold-start semantic hint',
    });

    expect(dashDb.insertSemanticEnrichmentEvent).toHaveBeenCalledOnce();
    expect(descriptor).toMatchObject({
      eventId: 'evt-cold-start',
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

  it('honors a live runtime downgrade when the stored integration still has stale semantic support', () => {
    expect(canQueueLocalAgentSemanticEnrichment(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          capabilities: {
            semanticEnrichment: true,
          },
        },
      },
    }), 'openclaw', {
      liveSemanticEnrichmentSupported: false,
    })).toBe(false);
  });

  it('treats missing live semantic-enrichment headers as absent so direct daemon routes fall back to stored capability', () => {
    const req = {
      headers: {
        'x-dkg-local-agent-integration': 'openclaw',
      },
    } as any;

    expect(requestAdvertisesLocalAgentSemanticEnrichment(req, 'openclaw')).toBeUndefined();
    expect(canQueueLocalAgentSemanticEnrichment(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          capabilities: {
            semanticEnrichment: true,
          },
        },
      },
    }), 'openclaw', {
      liveSemanticEnrichmentSupported: requestAdvertisesLocalAgentSemanticEnrichment(req, 'openclaw'),
    })).toBe(true);
  });

  it('treats explicit false live semantic-enrichment headers as a runtime downgrade', () => {
    const req = {
      headers: {
        'x-dkg-local-agent-integration': 'openclaw',
        'x-dkg-local-agent-semantic-enrichment': 'false',
      },
    } as any;

    expect(requestAdvertisesLocalAgentSemanticEnrichment(req, 'openclaw')).toBe(false);
    expect(canQueueLocalAgentSemanticEnrichment(makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          capabilities: {
            semanticEnrichment: true,
          },
        },
      },
    }), 'openclaw', {
      liveSemanticEnrichmentSupported: requestAdvertisesLocalAgentSemanticEnrichment(req, 'openclaw'),
    })).toBe(false);
  });

  it('ignores local-agent capability and wake hint headers unless bridge-auth trusted', () => {
    const spoofedReq = {
      headers: {
        'x-dkg-local-agent-integration': 'openclaw',
        'x-dkg-local-agent-semantic-enrichment': 'false',
        'x-dkg-local-agent-wake-url': 'http://127.0.0.1:9301/semantic-enrichment/wake',
        'x-dkg-local-agent-wake-auth': 'bridge-token',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as any;

    expect(requestAdvertisesLocalAgentSemanticEnrichment(spoofedReq, 'openclaw', {
      bridgeAuthToken: 'bridge-token',
      requireBridgeAuth: true,
    })).toBeUndefined();
    expect(requestLocalAgentWakeTransport(spoofedReq, 'openclaw', {
      bridgeAuthToken: 'bridge-token',
      requireBridgeAuth: true,
    })).toBeUndefined();

    const trustedReq = {
      headers: {
        ...spoofedReq.headers,
        'x-dkg-bridge-token': 'bridge-token',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as any;

    expect(requestAdvertisesLocalAgentSemanticEnrichment(trustedReq, 'openclaw', {
      bridgeAuthToken: 'bridge-token',
      requireBridgeAuth: true,
    })).toBe(false);
    expect(requestLocalAgentWakeTransport(trustedReq, 'openclaw', {
      bridgeAuthToken: 'bridge-token',
      requireBridgeAuth: true,
    })).toEqual({
      wakeUrl: 'http://127.0.0.1:9301/semantic-enrichment/wake',
      wakeAuth: 'bridge-token',
    });
  });

  it('restricts semantic worker routes to loopback OpenClaw integration requests', () => {
    const enabledConfig = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
        },
      },
    });

    const authOpts = {
      requestToken: 'node-token',
      bridgeAuthToken: 'node-token',
      resolveAgentByToken: () => undefined,
    };

    expect(isAuthorizedLocalAgentSemanticWorkerRequest(enabledConfig, {
      headers: {
        'x-dkg-local-agent-integration': 'openclaw',
        'x-dkg-bridge-token': 'node-token',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as any, 'openclaw', authOpts)).toBe(true);

    expect(isAuthorizedLocalAgentSemanticWorkerRequest(enabledConfig, {
      headers: {
        'x-dkg-local-agent-integration': 'openclaw',
        'x-dkg-bridge-token': 'node-token',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as any, 'openclaw', {
      bridgeAuthToken: 'node-token',
      resolveAgentByToken: () => undefined,
    })).toBe(true);

    expect(isAuthorizedLocalAgentSemanticWorkerRequest(enabledConfig, {
      headers: {
        'x-dkg-local-agent-integration': 'openclaw',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as any, 'openclaw', authOpts)).toBe(false);

    expect(isAuthorizedLocalAgentSemanticWorkerRequest(enabledConfig, {
      headers: {
        'x-dkg-local-agent-integration': 'openclaw',
        'x-dkg-bridge-token': 'agent-token',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as any, 'openclaw', {
      requestToken: 'agent-token',
      bridgeAuthToken: 'node-token',
      resolveAgentByToken: () => 'did:dkg:agent:0xagent',
    })).toBe(false);

    expect(isAuthorizedLocalAgentSemanticWorkerRequest(enabledConfig, {
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as any, 'openclaw', authOpts)).toBe(false);

    expect(isAuthorizedLocalAgentSemanticWorkerRequest(enabledConfig, {
      headers: {
        'x-dkg-local-agent-integration': 'openclaw',
        'x-dkg-bridge-token': 'node-token',
      },
      socket: { remoteAddress: '10.0.0.8' },
    } as any, 'openclaw', authOpts)).toBe(false);

    expect(isAuthorizedLocalAgentSemanticWorkerRequest(makeConfig(), {
      headers: {
        'x-dkg-local-agent-integration': 'openclaw',
        'x-dkg-bridge-token': 'node-token',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as any, 'openclaw', authOpts)).toBe(false);
  });

  it('uses the same resolved default agent address as assertion writes for chat-turn semantic URIs', () => {
    expect(resolveChatTurnsAssertionAgentAddress({
      peerId: 'peer-id',
      getDefaultAgentAddress: () => 'agent-address-1',
    })).toBe('agent-address-1');

    expect(resolveChatTurnsAssertionAgentAddress({
      peerId: 'peer-id',
      getDefaultAgentAddress: () => undefined,
    })).toBe('peer-id');
  });

  it('refreshes extraction-status semantic descriptors from the live outbox row', () => {
    const assertionUri = 'did:dkg:context-graph:cg1/assertion/peer/roadmap';
    const extractionStatus = new Map<string, any>();
    const now = Date.now();
    const startedAt = new Date(now - 2_000).toISOString();
    const completedAt = new Date(now - 1_000).toISOString();
    const staleSemanticUpdatedAt = new Date(now - 500).toISOString();
    const liveSemanticUpdatedAt = new Date(now).toISOString();
    const snapshotRecord = {
      status: 'completed',
      fileHash: 'sha256:file-1',
      detectedContentType: 'text/markdown',
      pipelineUsed: 'markdown-deterministic',
      tripleCount: 4,
      startedAt,
      completedAt,
      semanticEnrichment: {
        eventId: 'evt-1',
        status: 'pending',
        semanticTripleCount: 0,
        updatedAt: staleSemanticUpdatedAt,
      },
    };
    const dashDb = {
      getExtractionStatusSnapshot: vi.fn().mockReturnValue({
        assertion_uri: assertionUri,
        record_json: JSON.stringify(snapshotRecord),
        updated_at: Date.parse(completedAt),
      }),
      getSemanticEnrichmentEvent: vi.fn().mockReturnValue({
        id: 'evt-1',
        status: 'dead_letter',
        semantic_triple_count: 2,
        updated_at: Date.parse(liveSemanticUpdatedAt),
        last_error: 'worker unavailable',
      }),
      upsertExtractionStatusSnapshot: vi.fn(),
    };

    const record = getHydratedExtractionStatusRecord(extractionStatus as any, dashDb as any, assertionUri);

    expect(record?.semanticEnrichment).toEqual({
      eventId: 'evt-1',
      status: 'dead_letter',
      semanticTripleCount: 2,
      updatedAt: liveSemanticUpdatedAt,
      lastError: 'worker unavailable',
    });
    expect(extractionStatus.get(assertionUri)?.semanticEnrichment.status).toBe('dead_letter');
    expect(dashDb.upsertExtractionStatusSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      assertion_uri: assertionUri,
      record_json: expect.stringContaining('"status":"dead_letter"'),
    }));
  });

  it('attributes semantic provenance to the worker while preserving the source agent separately', () => {
    const workerDid = semanticWorkerDidFromLeaseOwner('host-a:123:boot-1');
    const quads = buildSemanticAppendQuads({
      extractedByDid: workerDid,
      sourceAgentDid: 'did:dkg:agent:0ximporter',
      eventId: 'evt-provenance',
      graph: 'did:dkg:context-graph:cg1/assertion/peer/roadmap',
      sourceRef: 'did:dkg:context-graph:cg1/assertion/peer/roadmap#file',
      triples: [{
        subject: 'urn:dkg:entity:acme',
        predicate: 'http://schema.org/name',
        object: '"Acme"',
      }],
      semanticTripleCount: 1,
      extractedAt: '2026-04-15T12:00:00.000Z',
    });

    expect(workerDid).toMatch(/^urn:dkg:semantic-worker:/);
    expect(quads).toContainEqual(expect.objectContaining({
      subject: 'urn:dkg:semantic-enrichment:evt-provenance',
      predicate: 'http://dkg.io/ontology/extractedBy',
      object: workerDid,
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: 'urn:dkg:semantic-enrichment:evt-provenance',
      predicate: 'http://dkg.io/ontology/sourceAgent',
      object: 'did:dkg:agent:0ximporter',
    }));
  });

  it('accepts semantic append payloads larger than the shared small-body limit', async () => {
    const req = new PassThrough() as any;
    req.method = 'POST';
    req.headers = {
      'x-dkg-local-agent-integration': 'openclaw',
      'x-dkg-bridge-token': 'bridge-token',
    };
    req.socket = { remoteAddress: '127.0.0.1' };
    const res = {
      statusCode: 0,
      body: '',
      writeHead(status: number) {
        this.statusCode = status;
      },
      end(body: string) {
        this.body = body;
      },
    };
    const body = JSON.stringify({
      eventId: 'evt-large-body',
      leaseOwner: 'host-a:123:boot-1',
      payloadHash: semanticPayloadHashForTest({ eventId: 'evt-large-body' }),
      triples: [],
      padding: 'x'.repeat(300_000),
    });

    const responsePromise = handleSemanticEnrichmentRoutes({
      req,
      res: res as any,
      path: '/api/semantic-enrichment/events/append',
      config: makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
          },
        },
      }),
      dashDb: {
        getSemanticEnrichmentEvent: vi.fn().mockReturnValue(undefined),
      },
      agent: {
        resolveAgentByToken: () => undefined,
      },
      extractionStatus: new Map(),
      requestToken: 'bridge-token',
      bridgeAuthToken: 'bridge-token',
    } as any);
    req.end(body);
    await responsePromise;

    expect(body.length).toBeGreaterThan(256 * 1024);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Semantic enrichment event not found: evt-large-body',
    });
  });

  it('rejects stale chat semantic appends after the queued payload is refreshed', async () => {
    const req = new PassThrough() as any;
    req.method = 'POST';
    req.headers = {
      'x-dkg-local-agent-integration': 'openclaw',
      'x-dkg-bridge-token': 'bridge-token',
    };
    req.socket = { remoteAddress: '127.0.0.1' };
    const res = {
      statusCode: 0,
      body: '',
      writeHead(status: number) {
        this.statusCode = status;
      },
      end(body: string) {
        this.body = body;
      },
    };
    const stalePayload = {
      kind: 'chat_turn',
      sessionId: 'openclaw:dkg-ui',
      turnId: 'turn-stale',
      contextGraphId: 'agent-context',
      assertionName: 'chat-turns',
      assertionUri: 'did:dkg:context-graph:agent-context/assertion/peer/chat-turns',
      sessionUri: 'urn:dkg:chat:session:openclaw:dkg-ui',
      turnUri: 'urn:dkg:chat:turn:turn-stale',
      userMessage: 'draft question',
      assistantReply: 'draft answer',
      persistenceState: 'pending',
    };
    const currentPayload = {
      ...stalePayload,
      assistantReply: 'final grounded answer',
      persistenceState: 'stored',
    };
    const insert = vi.fn();
    const releaseSemanticEnrichmentLease = vi.fn().mockReturnValue(true);
    const body = JSON.stringify({
      eventId: 'evt-stale-chat',
      leaseOwner: 'host-a:123:boot-1',
      payloadHash: semanticPayloadHashForTest(stalePayload),
      triples: [{
        subject: 'urn:dkg:chat:turn:turn-stale',
        predicate: 'http://schema.org/about',
        object: 'urn:dkg:entity:stale',
      }],
    });

    const responsePromise = handleSemanticEnrichmentRoutes({
      req,
      res: res as any,
      path: '/api/semantic-enrichment/events/append',
      config: makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
          },
        },
      }),
      dashDb: {
        getSemanticEnrichmentEvent: vi.fn().mockReturnValue({
          id: 'evt-stale-chat',
          kind: 'chat_turn',
          idempotency_key: 'chat-turn:turn-stale',
          payload_json: JSON.stringify(currentPayload),
          status: 'leased',
          attempts: 1,
          max_attempts: 5,
          lease_owner: 'host-a:123:boot-1',
          lease_expires_at: Date.now() + 60_000,
          next_attempt_at: Date.now(),
          semantic_triple_count: 0,
          last_error: null,
          created_at: Date.now(),
          updated_at: Date.now(),
        }),
        releaseSemanticEnrichmentLease,
      },
      agent: {
        resolveAgentByToken: () => undefined,
        store: { insert },
      },
      extractionStatus: new Map(),
      requestToken: 'bridge-token',
      bridgeAuthToken: 'bridge-token',
    } as any);
    req.end(body);

    await responsePromise;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Semantic enrichment lease is no longer owned by this worker',
    });
    expect(insert).not.toHaveBeenCalled();
    expect(releaseSemanticEnrichmentLease).toHaveBeenCalledWith(
      'evt-stale-chat',
      'host-a:123:boot-1',
      expect.any(Number),
    );
  });

  it('cleans the semantic quad batch and semantic count when semantic append insert fails', async () => {
    const req = new PassThrough() as any;
    req.method = 'POST';
    req.headers = {
      'x-dkg-local-agent-integration': 'openclaw',
      'x-dkg-bridge-token': 'bridge-token',
    };
    req.socket = { remoteAddress: '127.0.0.1' };
    const res = {
      statusCode: 0,
      body: '',
      writeHead(status: number) {
        this.statusCode = status;
      },
      end(body: string) {
        this.body = body;
      },
    };
    const assertionUri = 'did:dkg:context-graph:cg1/assertion/peer/doc';
    const payload = buildFileSemanticEventPayload({
      assertionUri,
      contextGraphId: 'cg1',
      fileHash: 'sha256:file',
      importStartedAt: '2026-04-15T12:00:00.000Z',
      filename: 'doc.md',
    });
    const deleteByPattern = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockRejectedValue(new Error('insert failed'));
    const query = vi.fn(async (sparql: string) => {
      if (sparql.includes('sourceFileHash')) {
        return {
          bindings: [{
            fileHash: '"sha256:file"',
            importStartedAt: '"2026-04-15T12:00:00.000Z"',
          }],
        };
      }
      if (sparql.includes('ASK')) return { value: false };
      if (sparql.includes('semanticTripleCount')) return { bindings: [] };
      return { bindings: [] };
    });
    const body = JSON.stringify({
      eventId: 'evt-partial',
      leaseOwner: 'host-a:123:boot-1',
      payloadHash: semanticPayloadHashForTest(payload),
      triples: [{
        subject: 'urn:dkg:entity:acme',
        predicate: 'http://schema.org/name',
        object: '"Acme"',
      }],
    });

    const responsePromise = handleSemanticEnrichmentRoutes({
      req,
      res: res as any,
      path: '/api/semantic-enrichment/events/append',
      config: makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
          },
        },
      }),
      dashDb: {
        getSemanticEnrichmentEvent: vi.fn().mockReturnValue({
          id: 'evt-partial',
          kind: 'file_import',
          idempotency_key: 'file',
          payload_json: JSON.stringify(payload),
          status: 'leased',
          attempts: 1,
          max_attempts: 5,
          lease_owner: 'host-a:123:boot-1',
          lease_expires_at: Date.now() + 60_000,
          next_attempt_at: Date.now(),
          semantic_triple_count: 0,
          last_error: null,
          created_at: Date.now(),
          updated_at: Date.now(),
        }),
      },
      agent: {
        resolveAgentByToken: () => undefined,
        store: { query, insert, deleteByPattern },
      },
      extractionStatus: new Map(),
      requestToken: 'bridge-token',
      bridgeAuthToken: 'bridge-token',
    } as any);
    req.end(body);

    await expect(responsePromise).rejects.toThrow('insert failed');
    expect(deleteByPattern).toHaveBeenCalledWith({
      subject: 'urn:dkg:semantic-enrichment:evt-partial',
      predicate: 'http://dkg.io/ontology/semanticEnrichmentEventId',
      object: '"evt-partial"',
      graph: assertionUri,
    });
    expect(deleteByPattern).toHaveBeenCalledWith({
      subject: 'urn:dkg:entity:acme',
      predicate: 'http://schema.org/name',
      object: '"Acme"',
      graph: assertionUri,
    });
    expect(deleteByPattern).toHaveBeenCalledWith({
      subject: 'urn:dkg:entity:acme',
      predicate: 'http://dkg.io/ontology/extractedFrom',
      object: 'urn:dkg:file:sha256:file',
      graph: assertionUri,
    });
    expect(deleteByPattern).toHaveBeenCalledWith({
      subject: assertionUri,
      predicate: 'http://dkg.io/ontology/semanticTripleCount',
      graph: 'did:dkg:context-graph:cg1/_meta',
    });
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

  it('dead-letters queued semantic events at reconciliation time when OpenClaw is explicitly disconnected', () => {
    const extractionStatus = new Map<string, any>();
    const dashDb = {
      deadLetterActiveSemanticEnrichmentEvents: vi.fn().mockReturnValue([]),
    };

    const count = reconcileOpenClawSemanticAvailability(
      makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: false,
            connectedAt: '2026-04-15T12:00:00.000Z',
            runtime: {
              status: 'disconnected',
              ready: false,
            },
            metadata: {
              userDisabled: true,
            },
          },
        },
      }),
      extractionStatus as any,
      dashDb as any,
    );

    expect(count).toBe(0);
    expect(dashDb.deadLetterActiveSemanticEnrichmentEvents).toHaveBeenCalledOnce();
  });

  it('leaves queued semantic events pending when the stored OpenClaw integration is missing', () => {
    const extractionStatus = new Map<string, any>();
    const dashDb = {
      deadLetterActiveSemanticEnrichmentEvents: vi.fn().mockReturnValue([]),
    };

    const count = reconcileOpenClawSemanticAvailability(
      makeConfig(),
      extractionStatus as any,
      dashDb as any,
    );

    expect(count).toBe(0);
    expect(dashDb.deadLetterActiveSemanticEnrichmentEvents).not.toHaveBeenCalled();
  });

  it('dead-letters queued semantic events when OpenClaw semantic capability is downgraded', () => {
    const extractionStatus = new Map<string, any>();
    const dashDb = {
      deadLetterActiveSemanticEnrichmentEvents: vi.fn().mockReturnValue([{
        id: 'evt-downgraded',
        payload_json: JSON.stringify({ kind: 'chat_turn' }),
        status: 'dead_letter',
      }]),
    };

    const count = reconcileOpenClawSemanticAvailability(
      makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            capabilities: {
              semanticEnrichment: false,
            },
            runtime: {
              status: 'degraded',
              ready: false,
              lastError: 'runtime.subagent unavailable',
            },
          },
        },
      }),
      extractionStatus as any,
      dashDb as any,
    );

    expect(count).toBe(1);
    expect(dashDb.deadLetterActiveSemanticEnrichmentEvents).toHaveBeenCalledOnce();
  });

  it('saves config before reconciling OpenClaw semantic availability', async () => {
    const extractionStatus = new Map<string, any>();
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    const dashDb = {
      deadLetterActiveSemanticEnrichmentEvents: vi.fn().mockReturnValue([]),
    };

    await saveConfigAndReconcileOpenClawSemanticAvailability({
      config: makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: false,
            connectedAt: '2026-04-15T12:00:00.000Z',
            runtime: {
              status: 'disconnected',
              ready: false,
            },
            metadata: {
              userDisabled: true,
            },
          },
        },
      }),
      extractionStatus: extractionStatus as any,
      dashDb: dashDb as any,
      saveConfig,
    });

    expect(saveConfig).toHaveBeenCalledOnce();
    expect(dashDb.deadLetterActiveSemanticEnrichmentEvents).toHaveBeenCalledOnce();
    expect(saveConfig.mock.invocationCallOrder[0]).toBeLessThan(
      dashDb.deadLetterActiveSemanticEnrichmentEvents.mock.invocationCallOrder[0],
    );
  });

  it('does not reconcile OpenClaw semantic availability when saving config fails', async () => {
    const extractionStatus = new Map<string, any>();
    const saveConfig = vi.fn().mockRejectedValue(new Error('disk full'));
    const dashDb = {
      deadLetterActiveSemanticEnrichmentEvents: vi.fn(),
    };

    await expect(saveConfigAndReconcileOpenClawSemanticAvailability({
      config: makeConfig(),
      extractionStatus: extractionStatus as any,
      dashDb: dashDb as any,
      saveConfig,
    })).rejects.toThrow('disk full');

    expect(dashDb.deadLetterActiveSemanticEnrichmentEvents).not.toHaveBeenCalled();
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

  it('omits file-import rootEntity from semantic payloads when extraction did not produce one', () => {
    const payload = buildFileSemanticEventPayload({
      contextGraphId: 'project-1',
      assertionName: 'roadmap',
      assertionUri: 'did:dkg:context-graph:project-1/assertion/peer/roadmap',
      importStartedAt: '2026-04-15T12:00:00.000Z',
      sourceAgentAddress: 'did:dkg:agent:0xabc',
      rootEntity: undefined,
      fileHash: 'sha256:file-1',
      mdIntermediateHash: 'sha256:md-1',
      detectedContentType: 'text/markdown',
    });

    expect(payload.assertionUri).toBe('did:dkg:context-graph:project-1/assertion/peer/roadmap');
    expect(payload.rootEntity).toBeUndefined();
    expect(payload).not.toHaveProperty('rootEntity');
  });

  it('refreshes pending chat-turn payloads before reusing an existing semantic event', () => {
    const oldPayload = {
      kind: 'chat_turn' as const,
      sessionId: 'openclaw:dkg-ui',
      turnId: 'turn-refresh',
      contextGraphId: 'agent-context',
      assertionName: 'chat-turns',
      assertionUri: 'did:dkg:context-graph:agent-context/assertion/peer/chat-turns',
      sessionUri: 'urn:dkg:chat:session:openclaw:dkg-ui',
      turnUri: 'urn:dkg:chat:turn:turn-refresh',
      userMessage: 'summarize the roadmap',
      assistantReply: 'draft answer',
      persistenceState: 'pending' as const,
    };
    const newPayload = {
      ...oldPayload,
      assistantReply: 'final answer with more grounded detail',
      persistenceState: 'stored' as const,
    };
    let row: any = {
      id: 'evt-chat-refresh',
      kind: 'chat_turn',
      idempotency_key: 'chat-turn:turn-refresh',
      payload_json: JSON.stringify(oldPayload),
      status: 'pending',
      semantic_triple_count: 5,
      attempts: 0,
      max_attempts: 5,
      next_attempt_at: 1_000,
      lease_owner: null,
      lease_expires_at: null,
      last_error: 'old failure',
      created_at: 900,
      updated_at: 1_000,
    };
    const dashDb = {
      getSemanticEnrichmentEventByIdempotencyKey: vi.fn(() => row),
      refreshActiveSemanticEnrichmentEventPayload: vi.fn((
        id: string,
        payloadJson: string,
        semanticTripleCount: number,
        updatedAt: number,
      ) => {
        row = {
          ...row,
          payload_json: payloadJson,
          status: 'pending',
          semantic_triple_count: semanticTripleCount,
          attempts: 0,
          next_attempt_at: updatedAt,
          lease_owner: null,
          lease_expires_at: null,
          last_error: null,
          updated_at: updatedAt,
        };
        return id === 'evt-chat-refresh';
      }),
      insertSemanticEnrichmentEvent: vi.fn(),
      getSemanticEnrichmentEvent: vi.fn(() => row),
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
      payload: newPayload,
      skipWhenUnavailable: true,
      logLabel: 'chat turn refresh',
    });

    expect(dashDb.insertSemanticEnrichmentEvent).not.toHaveBeenCalled();
    expect(dashDb.refreshActiveSemanticEnrichmentEventPayload).toHaveBeenCalledWith(
      'evt-chat-refresh',
      JSON.stringify(newPayload),
      0,
      expect.any(Number),
    );
    expect(JSON.parse(row.payload_json)).toMatchObject({
      assistantReply: 'final answer with more grounded detail',
      persistenceState: 'stored',
    });
    expect(row).toMatchObject({
      status: 'pending',
      semantic_triple_count: 0,
      attempts: 0,
      lease_owner: null,
      lease_expires_at: null,
      last_error: null,
    });
    expect(descriptor).toMatchObject({
      eventId: 'evt-chat-refresh',
      status: 'pending',
      semanticTripleCount: 0,
    });
    expect(descriptor?.lastError).toBeUndefined();
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

  it('rejects non-string or invalid projectContextGraphId values in persist-turn payloads', () => {
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'hi',
      assistantReply: '',
      projectContextGraphId: 42,
    })).toBe(false);

    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'hi',
      assistantReply: '',
      projectContextGraphId: 'bad graph id',
    })).toBe(false);

    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: 'hi',
      assistantReply: '',
      projectContextGraphId: 'project-alpha',
    })).toBe(true);
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
    expect(queryCalls).toHaveLength(0);
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

  it('rejects completed attachment refs after the extraction cache entry is gone and the meta graph no longer has the assertion', async () => {
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
      fileHash: 'sha256:abc123',
      contextGraphId: 'cg1',
      fileName: 'chat-doc.pdf',
      extractionStatus: 'completed' as const,
    }];
    const queryCalls: unknown[][] = [];
    const store = {
      query: async (...args: unknown[]) => { queryCalls.push(args); return { bindings: [] }; },
    };

    await expect(
      verifyOpenClawAttachmentRefsProvenance({ store } as any, new Map(), attachmentRefs),
    ).resolves.toBeUndefined();
    expect(queryCalls).toHaveLength(1);
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
      query: async () => ({
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
      query: async () => ({
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
    const runSetupCalls: unknown[][] = [];
    const runSetup = (...args: unknown[]) => { runSetupCalls.push(args); };
    const restartGatewayCalls: unknown[][] = [];
    const restartGateway = (...args: unknown[]) => { restartGatewayCalls.push(args); };
    const waitForReadyCalls: unknown[][] = [];
    const waitForReady = (...args: unknown[]) => { waitForReadyCalls.push(args); };
    const probeHealth = async () => ({ ok: true as const, target: 'bridge' });

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      { runSetup, restartGateway, waitForReady, probeHealth },
    );

    expect(runSetupCalls.length).toBe(0);
    expect(restartGatewayCalls.length).toBe(0);
    expect(waitForReadyCalls.length).toBe(0);
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
    const runSetupCalls: unknown[][] = [];
    const runSetup = (...args: unknown[]) => { runSetupCalls.push(args); };
    const restartGatewayCalls: unknown[][] = [];
    const restartGateway = (...args: unknown[]) => { restartGatewayCalls.push(args); };
    const waitForReadyCalls: unknown[][] = [];
    const waitForReady = (...args: unknown[]) => { waitForReadyCalls.push(args); };
    const probeHealth = async () => ({ ok: true as const, target: 'bridge' });

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'openclaw',
        metadata: { source: 'node-ui' },
      },
      'bridge-token',
      { runSetup, restartGateway, waitForReady, probeHealth },
    );

    expect(runSetupCalls.length).toBe(0);
    expect(restartGatewayCalls.length).toBe(0);
    expect(waitForReadyCalls.length).toBe(0);
    expect(result.integration.status).toBe('ready');
    expect(result.integration.runtime.ready).toBe(true);
    expect(result.integration.metadata?.userDisabled).toBe(false);
    expect(result.integration.transport.wakeUrl).toBe('http://127.0.0.1:9201/semantic-enrichment/wake');
    expect(result.integration.transport.wakeAuth).toBe('bridge-token');
    expect(result.notice).toBe('OpenClaw is connected and chat-ready.');
  });

  it('does not persist a gateway wake URL from UI health patches because daemon wake auth is bridge-only', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            gatewayUrl: 'http://gateway.local:3030',
          },
        },
      },
    });
    const probeHealth = async () => ({ ok: true as const, target: 'gateway' });

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'openclaw', metadata: { source: 'node-ui' } },
      'bridge-token',
      { probeHealth },
    );

    expect(result.integration.status).toBe('ready');
    expect(result.integration.transport.gatewayUrl).toBe('http://gateway.local:3030');
    expect(result.integration.transport.wakeUrl).toBeUndefined();
    expect(result.integration.transport.wakeAuth).toBeUndefined();
    expect(result.notice).toBe('OpenClaw is connected and chat-ready.');
  });

  it('does not treat a stored wake-only OpenClaw transport as a chat-ready bridge fast path', async () => {
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
    const waitForReady = vi.fn().mockResolvedValue({ ok: true as const, target: 'bridge' });
    const probeHealth = vi.fn().mockResolvedValue({
      ok: true,
      target: 'bridge',
    });
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
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    expect(runSetup).toHaveBeenCalledTimes(1);
    expect(result.integration.transport.bridgeUrl).toBeUndefined();
    expect(result.integration.transport.wakeUrl).toBe('http://bridge.remote:9305/semantic-enrichment/wake');
    expect(result.integration.transport.wakeAuth).toBe('bridge-token');
    if (!attachJob) throw new Error('Expected wake-only OpenClaw attach job to be scheduled');
    await attachJob;
    expect(restartGateway).not.toHaveBeenCalled();
    expect(waitForReady).not.toHaveBeenCalled();
  });

  it('UI connect does not trust a healthy bridge fast-path for a first-time attach', async () => {
    const config = makeConfig();
    const runSetupCalls: unknown[][] = [];
    const runSetup = async (...args: unknown[]) => { runSetupCalls.push(args); };
    const restartGatewayCalls: unknown[][] = [];
    const restartGateway = async (...args: unknown[]) => { restartGatewayCalls.push(args); };
    const waitForReady = async () => ({ ok: true as const, target: 'bridge' });
    let probeIdx = 0;
    const probeResults = [
      { ok: true as const, target: 'bridge' },
      { ok: false as const, error: 'bridge still starting' },
    ];
    const probeHealth = async () => probeResults[probeIdx++];
    const saveConfigCalls: unknown[][] = [];
    const saveConfig = async (...args: unknown[]) => { saveConfigCalls.push(args); };
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
        verifyMemorySlot: () => true,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    expect(runSetupCalls.length).toBe(1);
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;
    expect(restartGatewayCalls.length).toBe(1);
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.status).toBe('ready');
    expect(integration?.runtime.ready).toBe(true);
  });

  it('does not leave a failed first-time OpenClaw attach marked as connected', async () => {
    const config = makeConfig();
    const runSetup = async () => { throw new Error('setup failed'); };
    const restartGateway = () => {};
    const waitForReady = () => {};
    const probeHealth = async () => ({ ok: false as const, error: 'bridge offline' });
    const saveConfigCalls: unknown[][] = [];
    const saveConfig = async (...args: unknown[]) => { saveConfigCalls.push(args); };
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
        verifyMemorySlot: () => true,
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
    expect(saveConfigCalls.length).toBeGreaterThanOrEqual(1);
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
    const runSetup = async () => { throw new Error('setup failed'); };
    const restartGateway = () => {};
    const waitForReady = () => {};
    const probeHealth = async () => ({ ok: false as const, error: 'bridge offline' });
    const saveConfigCalls: unknown[][] = [];
    const saveConfig = async (...args: unknown[]) => { saveConfigCalls.push(args); };
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
        verifyMemorySlot: () => true,
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
    expect(saveConfigCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('UI connect runs OpenClaw setup, restarts the gateway, and leaves the integration in connecting state while the gateway is still coming up', async () => {
    const config = makeConfig();
    const runSetupCalls: unknown[][] = [];
    const runSetup = async (...args: unknown[]) => { runSetupCalls.push(args); };
    const restartGatewayCalls: unknown[][] = [];
    const restartGateway = async (...args: unknown[]) => { restartGatewayCalls.push(args); };
    const waitForReadyCalls: unknown[][] = [];
    const waitForReady = async (...args: unknown[]) => { waitForReadyCalls.push(args); return { ok: false as const, error: 'bridge still starting' }; };
    const probeHealthCalls: unknown[][] = [];
    let probeIdx = 0;
    const probeResults = [
      { ok: false as const, error: 'bridge offline' },
      { ok: false as const, error: 'bridge still starting' },
    ];
    const probeHealth = async (...args: unknown[]) => { probeHealthCalls.push(args); return probeResults[probeIdx++]; };
    const saveConfigCalls: unknown[][] = [];
    const saveConfig = async (...args: unknown[]) => { saveConfigCalls.push(args); };
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
        verifyMemorySlot: () => true,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    expect(result.integration.runtime.ready).toBe(false);
    expect(result.notice).toContain('come online automatically');
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;

    expect(runSetupCalls.length).toBe(1);
    expect(runSetupCalls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(restartGatewayCalls.length).toBe(1);
    expect(waitForReadyCalls.length).toBe(1);
    expect(probeHealthCalls.length).toBe(2);
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.status).toBe('connecting');
    expect(integration?.runtime.ready).toBe(false);
    expect(integration?.runtime.lastError).toBe('bridge still starting');
    expect(saveConfigCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('UI connect retries OpenClaw readiness after a gateway restart and reports chat-ready when the bridge comes up', async () => {
    const config = makeConfig();
    const runSetupCalls: unknown[][] = [];
    const runSetup = async (...args: unknown[]) => { runSetupCalls.push(args); };
    const restartGatewayCalls: unknown[][] = [];
    const restartGateway = async (...args: unknown[]) => { restartGatewayCalls.push(args); };
    const waitForReadyCalls: unknown[][] = [];
    const waitForReady = async (...args: unknown[]) => { waitForReadyCalls.push(args); return { ok: true as const, target: 'bridge' }; };
    let probeIdx = 0;
    const probeResults = [
      { ok: false as const, error: 'bridge offline' },
      { ok: false as const, error: 'bridge still starting' },
    ];
    const probeHealth = async () => probeResults[probeIdx++];
    const saveConfigCalls: unknown[][] = [];
    const saveConfig = async (...args: unknown[]) => { saveConfigCalls.push(args); };
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
        verifyMemorySlot: () => true,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;

    expect(runSetupCalls.length).toBe(1);
    expect(runSetupCalls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(restartGatewayCalls.length).toBe(1);
    expect(waitForReadyCalls.length).toBe(1);
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.status).toBe('ready');
    expect(integration?.runtime.ready).toBe(true);
    expect(integration?.transport.bridgeUrl).toBe('http://127.0.0.1:9201');
    expect(integration?.transport.wakeUrl).toBe('http://127.0.0.1:9201/semantic-enrichment/wake');
    expect(integration?.transport.wakeAuth).toBe('bridge-token');
    expect(saveConfigCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('cancels a pending OpenClaw attach job when the integration is disconnected before attach finishes', async () => {
    const config = makeConfig();
    let releaseSetup!: () => void;
    const runSetup = () => new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const restartGatewayCalls: unknown[][] = [];
    const restartGateway = async (...args: unknown[]) => { restartGatewayCalls.push(args); };
    const waitForReadyCalls: unknown[][] = [];
    const waitForReady = (...args: unknown[]) => { waitForReadyCalls.push(args); };
    const probeHealth = async () => ({ ok: false as const, error: 'bridge offline' });
    const saveConfig = async () => {};
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
        verifyMemorySlot: () => true,
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

    expect(restartGatewayCalls.length).toBe(0);
    expect(waitForReadyCalls.length).toBe(0);
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.enabled).toBe(false);
    expect(integration?.status).toBe('disconnected');
    expect(integration?.runtime.lastError).toBeNull();
  });

  it('cancels readiness polling when the integration is disconnected mid-attach', async () => {
    const config = makeConfig();
    const runSetupCalls: unknown[][] = [];
    const runSetup = async (...args: unknown[]) => { runSetupCalls.push(args); };
    const restartGatewayCalls: unknown[][] = [];
    const restartGateway = async (...args: unknown[]) => { restartGatewayCalls.push(args); };
    let markWaitForReadyStarted!: () => void;
    const waitForReadyStarted = new Promise<void>((resolve) => {
      markWaitForReadyStarted = resolve;
    });
    const waitForReadyCalls: unknown[][] = [];
    const waitForReady = (_cfg: unknown, _token: unknown, signal?: AbortSignal) => {
      waitForReadyCalls.push([_cfg, _token, signal]);
      return new Promise<never>((_resolve, reject) => {
        markWaitForReadyStarted();
        const onAbort = () => reject(new Error('OpenClaw attach cancelled'));
        if (!signal) return;
        if (signal.aborted) {
          reject(new Error('OpenClaw attach cancelled'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    };
    let probeIdx = 0;
    const probeResults = [
      { ok: false as const, error: 'bridge offline' },
      { ok: false as const, error: 'still starting' },
    ];
    const probeHealth = async () => probeResults[probeIdx++];
    const saveConfig = async () => {};
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
        verifyMemorySlot: () => true,
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

    expect(runSetupCalls.length).toBe(1);
    expect(runSetupCalls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(restartGatewayCalls.length).toBe(1);
    expect(waitForReadyCalls.length).toBe(1);
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.enabled).toBe(false);
    expect(integration?.status).toBe('disconnected');
    expect(integration?.runtime.lastError).toBeNull();
  });

  it('rechecks OpenClaw bridge health quickly after a cached failure so recovery is not sticky', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:00:00.000Z'));
    const origFetch = globalThis.fetch;
    let fetchCallCount = 0;
    const fetchResponses = [
      new Response(
        JSON.stringify({ ok: false, error: 'offline' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
      new Response(
        JSON.stringify({ ok: true, channel: 'dkg-ui' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ];
    globalThis.fetch = (async () => fetchResponses[fetchCallCount++]) as typeof fetch;

    try {
      const config = makeConfig();
      const first = await probeOpenClawChannelHealth(config, 'bridge-token', { ignoreBridgeCache: true });
      expect(first.ok).toBe(false);

      vi.setSystemTime(new Date('2026-04-13T12:00:01.500Z'));
      const second = await probeOpenClawChannelHealth(config, 'bridge-token');

      expect(second.ok).toBe(true);
      expect(fetchCallCount).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
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

  it('restricts wake transport metadata to known endpoint and auth-mode combinations', () => {
    const config = makeConfig();

    expect(isSafeBridgeTokenWakeUrl('http://127.0.0.1:9301/custom/wake')).toBe(false);
    expect(inferSafeLocalAgentWakeAuthFromUrl('http://127.0.0.1:9301/semantic-enrichment/wake')).toBe('bridge-token');
    expect(inferSafeLocalAgentWakeAuthFromUrl('http://127.0.0.1:9301/api/dkg-channel/semantic-enrichment/wake')).toBe('gateway');

    const customPath = updateLocalAgentIntegration(config, 'openclaw', {
      transport: {
        kind: 'openclaw-channel',
        wakeUrl: 'http://127.0.0.1:9301/custom/wake',
        wakeAuth: 'bridge-token',
      },
    });
    expect(customPath.transport.wakeUrl).toBeUndefined();
    expect(customPath.transport.wakeAuth).toBeUndefined();

    const mismatchedAuth = updateLocalAgentIntegration(config, 'openclaw', {
      transport: {
        kind: 'openclaw-channel',
        wakeUrl: 'http://127.0.0.1:9301/api/dkg-channel/semantic-enrichment/wake',
        wakeAuth: 'bridge-token',
      },
    });
    expect(mismatchedAuth.transport.wakeUrl).toBeUndefined();
    expect(mismatchedAuth.transport.wakeAuth).toBeUndefined();

    const gatewayAuth = updateLocalAgentIntegration(config, 'openclaw', {
      transport: {
        kind: 'openclaw-channel',
        wakeUrl: 'http://127.0.0.1:9301/api/dkg-channel/semantic-enrichment/wake',
        wakeAuth: 'gateway',
      },
    });
    expect(gatewayAuth.transport.wakeUrl).toBe('http://127.0.0.1:9301/api/dkg-channel/semantic-enrichment/wake');
    expect(gatewayAuth.transport.wakeAuth).toBe('gateway');
  });

  it('drops custom non-loopback wake metadata from integration updates', () => {
    const config = makeConfig();

    const integration = updateLocalAgentIntegration(config, 'openclaw', {
      transport: {
        kind: 'openclaw-channel',
        wakeUrl: 'https://example.com/semantic-enrichment/wake',
        wakeAuth: 'bridge-token',
      },
      runtime: {
        status: 'ready',
        ready: true,
      },
    }, new Date('2026-04-13T10:55:00.000Z'));

    expect(integration.transport.kind).toBe('openclaw-channel');
    expect(integration.transport.wakeUrl).toBeUndefined();
    expect(integration.transport.wakeAuth).toBeUndefined();

    const unauthenticated = updateLocalAgentIntegration(config, 'openclaw', {
      transport: {
        kind: 'openclaw-channel',
        wakeUrl: 'https://example.com/semantic-enrichment/wake',
        wakeAuth: 'none',
      },
    });
    expect(unauthenticated.transport.wakeUrl).toBeUndefined();
    expect(unauthenticated.transport.wakeAuth).toBeUndefined();
  });
});

describe('runOpenClawUiSetup AbortSignal forwarding (Codex #1)', () => {
  // Regression test for https://github.com/OriginTrail/dkg-v9/pull/228#discussion_r3117710809
  // The child-process path used to SIGKILL setup on abort; the in-process path must
  // refuse to start on a pre-aborted signal and (via the adapter's step-boundary
  // throwIfAborted helper) also stop cleanly if the signal fires mid-flow.
  it('pre-aborted signal throws before importing the adapter (no config writes)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runOpenClawUiSetup(controller.signal)).rejects.toThrow(/OpenClaw attach cancelled/);
  });
});

describe('isOpenClawMemorySlotElected honors OPENCLAW_HOME (Codex #6)', () => {
  // Regression test for https://github.com/OriginTrail/dkg-v9/pull/228#discussion_r3117931371
  // The previous implementation hardcoded `join(homedir(), '.openclaw', 'openclaw.json')`,
  // so with a non-default OpenClaw home the post-setup invariant read the wrong file and
  // reported false slot-election failures. The check now delegates to the adapter's
  // `openclawConfigPath()` helper, which honors `process.env.OPENCLAW_HOME`.
  let tempRoot: string;
  const origOpenclawHome = process.env.OPENCLAW_HOME;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dkg-openclaw-home-'));
    process.env.OPENCLAW_HOME = tempRoot;
  });

  afterEach(() => {
    if (origOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = origOpenclawHome;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reads openclaw.json from OPENCLAW_HOME and returns true when the slot is elected', () => {
    const configPath = join(tempRoot, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'adapter-openclaw' } },
    }));
    expect(isOpenClawMemorySlotElected()).toBe(true);
  });

  it('returns false when OPENCLAW_HOME points at a config with a different slot owner', () => {
    const configPath = join(tempRoot, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'some-other-plugin' } },
    }));
    expect(isOpenClawMemorySlotElected()).toBe(false);
  });

  it('returns false when OPENCLAW_HOME has no openclaw.json (fresh home)', () => {
    // no file written
    expect(isOpenClawMemorySlotElected()).toBe(false);
  });
});

describe('OpenClaw UI Connect/Disconnect/Refresh fresh-HOME integration (issue #198)', () => {
  let tempRoot: string;
  let openclawDir: string;
  let openclawConfigPath: string;
  let workspaceDir: string;
  let adapterPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dkg-fresh-home-'));
    openclawDir = join(tempRoot, '.openclaw');
    workspaceDir = join(tempRoot, 'workspace');
    openclawConfigPath = join(openclawDir, 'openclaw.json');
    mkdirSync(openclawDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    // Simulate an installed adapter path under workspace node_modules.
    // The merge routine uses isAdapterLoadPath() (matches .../@origintrail-official/dkg-adapter-openclaw
    // or .../packages/adapter-openclaw/). Use a packages/ path so both forms work on Windows & POSIX.
    adapterPath = join(tempRoot, 'packages', 'adapter-openclaw');
    writeFileSync(openclawConfigPath, JSON.stringify({
      plugins: {},
      agents: { defaults: { workspace: workspaceDir } },
    }, null, 2));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function seedOpenClawConfig(data: Record<string, unknown>): void {
    writeFileSync(openclawConfigPath, JSON.stringify(data, null, 2) + '\n');
  }

  it('scenario 1: fresh-HOME UI Connect merges adapter-openclaw into plugins.slots.memory and marks integration ready', async () => {
    // Fresh openclaw.json (no adapter wiring yet).
    seedOpenClawConfig({ plugins: {}, agents: { defaults: { workspace: workspaceDir } } });

    const config = makeConfig();
    // DI stub: simulates runSetup by running the REAL mergeOpenClawConfig against
    // the temp-HOME openclaw.json. This is the highest-fidelity stand-in we can
    // get without spinning up a real daemon in the test.
    const runSetup = async () => {
      mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    };
    const restartGateway = async () => {};
    const waitForReady = async () => ({ ok: true as const, target: 'bridge' });
    const probeResults: Array<{ ok: boolean; target?: string; error?: string }> = [
      { ok: false, error: 'bridge offline' },
      { ok: true, target: 'bridge' },
    ];
    let probeIdx = 0;
    const probeHealth = async () => probeResults[probeIdx++] as any;
    const saveConfig = async () => {};
    // Real verifyMemorySlot reads the temp openclaw.json to confirm election.
    const verifyMemorySlot = () => {
      const raw = readFileSync(openclawConfigPath, 'utf-8');
      return JSON.parse(raw)?.plugins?.slots?.memory === 'adapter-openclaw';
    };
    let attachJob: Promise<void> | null = null;

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'openclaw', metadata: { source: 'node-ui' } },
      'bridge-token',
      {
        runSetup,
        restartGateway,
        waitForReady,
        probeHealth,
        saveConfig,
        verifyMemorySlot,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;

    // Real openclaw.json on the temp filesystem now reflects the merge.
    const mergedRaw = readFileSync(openclawConfigPath, 'utf-8');
    const merged = JSON.parse(mergedRaw);
    expect(merged.plugins.slots.memory).toBe('adapter-openclaw');
    expect(merged.plugins.allow).toContain('adapter-openclaw');
    const mergedEntry = merged.plugins.entries['adapter-openclaw'];
    expect(mergedEntry.enabled).toBe(true);
    // D2: adapter runtime config lives in the plugin entry now (was
    // $WORKSPACE_DIR/config.json before PR #232). Full shape — daemonUrl,
    // memory.enabled, channel.enabled — is what openclaw-entry.mjs reads.
    expect(mergedEntry.config).toBeDefined();
    expect(typeof mergedEntry.config.daemonUrl).toBe('string');
    expect(mergedEntry.config.daemonUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(mergedEntry.config.memory.enabled).toBe(true);
    expect(mergedEntry.config.channel.enabled).toBe(true);
    // Windows-path normalization assertion: mergeOpenClawConfig normalizes backslashes to
    // forward slashes before storing the path.
    const storedPaths = merged.plugins.load.paths as string[];
    expect(storedPaths.length).toBeGreaterThan(0);
    for (const p of storedPaths) {
      expect(p).not.toContain('\\');
    }
    expect(storedPaths.some((p) => /packages\/adapter-openclaw/.test(p))).toBe(true);

    // Integration record reflects ready state with no lastError.
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.status).toBe('ready');
    expect(integration?.runtime.ready).toBe(true);
    expect(integration?.runtime.lastError).toBeFalsy();
  });

  it('scenario 2: post-Connect Disconnect reverse-merges adapter wiring, writes .bak.<ts>, and removes SKILL.md from the authoritative installedWorkspace', async () => {
    // Seed a pre-merged openclaw.json (as if Connect already ran).
    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);

    // Codex R2-1: Disconnect MUST target `entry.config.installedWorkspace`, not the
    // openclaw.json workspace keys. To prove that, mutate `installedWorkspace`
    // to a DIFFERENT directory than `agents.defaults.workspace` — the two
    // typically agree in production, but any drift (override flag used, or
    // openclaw.json edited between Connect and Disconnect) must be resolved
    // in favor of the authoritative install path setup actually wrote to.
    const authoritativeInstallDir = join(tempRoot, 'authoritative-install');
    mkdirSync(authoritativeInstallDir, { recursive: true });
    const afterMerge = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    afterMerge.plugins.entries['adapter-openclaw'].config.installedWorkspace = authoritativeInstallDir;
    writeFileSync(openclawConfigPath, JSON.stringify(afterMerge, null, 2));

    // Seed SKILL.md + a sibling `custom-note.md` at the AUTHORITATIVE path —
    // where setup actually installed. Also seed a distinct SKILL.md at the
    // config-derived workspaceDir to show Disconnect does NOT touch it when
    // installedWorkspace is authoritative.
    const installedSkillDir = join(authoritativeInstallDir, 'skills', 'dkg-node');
    const installedSkillPath = join(installedSkillDir, 'SKILL.md');
    const installedSiblingPath = join(installedSkillDir, 'custom-note.md');
    mkdirSync(installedSkillDir, { recursive: true });
    writeFileSync(installedSkillPath, '# Canonical DKG Node Skill (authoritative)\n');
    writeFileSync(installedSiblingPath, '# User note alongside the adapter skill\n');

    const driftSkillDir = join(workspaceDir, 'skills', 'dkg-node');
    const driftSkillPath = join(driftSkillDir, 'SKILL.md');
    mkdirSync(driftSkillDir, { recursive: true });
    writeFileSync(driftSkillPath, '# Stale SKILL.md that Disconnect must NOT touch\n');

    // Sanity: adapter is fully wired before disconnect.
    const before = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(before.plugins.slots.memory).toBe('adapter-openclaw');
    expect(before.plugins.allow).toContain('adapter-openclaw');
    expect(before.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(authoritativeInstallDir);

    const config = makeConfig();
    await reverseLocalAgentSetupForUi(config, openclawConfigPath);

    const after = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(after.plugins.slots.memory).toBeUndefined();
    expect(after.plugins.allow).not.toContain('adapter-openclaw');
    // D1: adapter entry is removed entirely on unmerge (not just disabled).
    expect(after.plugins.entries['adapter-openclaw']).toBeUndefined();
    const remainingPaths = (after.plugins.load.paths ?? []) as string[];
    expect(remainingPaths.some((p) => /packages[\\/]adapter-openclaw/.test(p))).toBe(false);
    // tools.alsoAllow is intentionally NOT reverted (shared with other plugins per D1 decision).
    expect(after.tools.alsoAllow).toContain('group:plugins');

    // A .bak.<ts> snapshot sits next to the config.
    const siblings = readdirSync(openclawDir);
    expect(siblings.some((name) => /^openclaw\.json\.bak\.\d+$/.test(name))).toBe(true);

    // Authoritative install: SKILL.md retired, sibling custom-note.md survives,
    // outer skills/ parent untouched (other skills may live there).
    expect(existsSync(installedSkillPath)).toBe(false);
    expect(existsSync(installedSiblingPath)).toBe(true);
    expect(existsSync(join(authoritativeInstallDir, 'skills'))).toBe(true);
    // Drift directory: Disconnect did NOT target the config-derived path once
    // installedWorkspace was populated — the stale SKILL.md stays where it is.
    expect(existsSync(driftSkillPath)).toBe(true);
  });

  it('scenario 2b: bare { enabled: false } PUT payload still routes through the reverse-setup path (Codex #2)', async () => {
    // Regression test for https://github.com/OriginTrail/dkg-v9/pull/228#discussion_r3117710814
    // Background: an earlier draft of the PUT handler gated the reverse-merge on
    // `parsed.enabled === false && parsed.runtime?.status === 'disconnected'`, which skipped
    // bare `{ enabled: false }` payloads. Those clients still disabled the integration but left
    // openclaw.json fully wired to adapter-openclaw. The handler now normalizes via
    // `normalizeExplicitLocalAgentDisconnectBody` BEFORE computing `explicitDisconnect`.

    // Seed a pre-merged openclaw.json (as if Connect already ran).
    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const before = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(before.plugins.slots.memory).toBe('adapter-openclaw');

    // Mirror the exact sequence the PUT handler uses (packages/cli/src/daemon.ts ~6362).
    const parsed: Record<string, unknown> = { enabled: false };
    const normalizedPatch = normalizeExplicitLocalAgentDisconnectBody(parsed);
    const explicitDisconnect = normalizedPatch.enabled === false
      && !!normalizedPatch.runtime
      && (normalizedPatch.runtime as Record<string, unknown>).status === 'disconnected';
    expect(explicitDisconnect).toBe(true);

    // Same SKILL.md + sibling seeding as scenario 2 — the bare-body path must
    // also retire the canonical skill and spare unrelated neighbors.
    const skillDir = join(workspaceDir, 'skills', 'dkg-node');
    const skillPath = join(skillDir, 'SKILL.md');
    const siblingPath = join(skillDir, 'custom-note.md');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, '# Canonical DKG Node Skill\n');
    writeFileSync(siblingPath, '# User note alongside the adapter skill\n');

    const config = makeConfig();
    await reverseLocalAgentSetupForUi(config, openclawConfigPath);

    const after = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(after.plugins.slots.memory).toBeUndefined();
    expect(after.plugins.allow).not.toContain('adapter-openclaw');
    // D1: adapter entry is removed entirely on unmerge.
    expect(after.plugins.entries['adapter-openclaw']).toBeUndefined();

    expect(existsSync(skillPath)).toBe(false);
    expect(existsSync(siblingPath)).toBe(true);
  });

  it('scenario 2c: reverse-setup surfaces non-slot invariant failures via verifyUnmergeInvariants (Codex N3)', async () => {
    // Regression test for https://github.com/OriginTrail/dkg-v9/pull/228#discussion_r3118294850
    // Earlier versions of reverseLocalAgentSetupForUi only post-checked
    // `plugins.slots.memory !== 'adapter-openclaw'`. If a future regression in
    // unmergeOpenClawConfig left the adapter in `plugins.allow`, `plugins.load.paths`, or
    // `plugins.entries[...].enabled === true`, the daemon would still report a successful
    // disconnect while the gateway kept loading the adapter on restart. The helper now
    // defers to the adapter's `verifyUnmergeInvariants`, which covers all four invariants.

    // Seed a pre-merged openclaw.json (as if Connect already ran).
    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const before = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(before.plugins.slots.memory).toBe('adapter-openclaw');
    expect(before.plugins.allow).toContain('adapter-openclaw');

    // Stub unmergeOpenClawConfig to do a PARTIAL cleanup — clears the slot and the load
    // path (so the old single-check invariant would pass) but leaves the adapter listed
    // in plugins.allow. verifyUnmergeInvariants should flag the latter.
    const partialUnmerge = (configPath: string) => {
      const raw = readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      if (cfg?.plugins?.slots?.memory === 'adapter-openclaw') {
        delete cfg.plugins.slots.memory;
      }
      if (Array.isArray(cfg?.plugins?.load?.paths)) {
        cfg.plugins.load.paths = cfg.plugins.load.paths.filter(
          (p: string) => !/adapter-openclaw/.test(p),
        );
      }
      if (cfg?.plugins?.entries?.['adapter-openclaw']) {
        cfg.plugins.entries['adapter-openclaw'].enabled = false;
      }
      // Intentionally does NOT remove 'adapter-openclaw' from plugins.allow.
      writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    };

    // Load the real verifier from the adapter barrel so we exercise the actual invariant.
    const { verifyUnmergeInvariants } = await import('@origintrail-official/dkg-adapter-openclaw');

    // Seed a SKILL.md at the workspace `mergeOpenClawConfig` recorded above.
    // Post-R3-2 the skill cleanup runs BEFORE the config-level unmerge; we
    // stub the skill steps with passing no-ops so the flow reaches the
    // partial-unmerge + invariant-failure path the test is actually about.
    const skillDir = join(workspaceDir, 'skills', 'dkg-node');
    const skillPath = join(skillDir, 'SKILL.md');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, '# Canonical DKG Node Skill\n');

    const removeSkillStub = vi.fn();
    const verifySkillRemovedStub = vi.fn(() => null);

    const config = makeConfig();
    await expect(
      reverseLocalAgentSetupForUi(config, openclawConfigPath, {
        unmergeOpenClawConfig: partialUnmerge,
        verifyUnmergeInvariants,
        removeCanonicalNodeSkill: removeSkillStub,
        verifySkillRemoved: verifySkillRemovedStub,
      }),
    ).rejects.toThrow(/plugins\.allow still contains/);

    // The partial cleanup did happen on disk — this asserts the invariant check fired
    // specifically on the allow-list regression.
    const after = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(after.plugins.slots.memory).toBeUndefined();
    expect(after.plugins.allow).toContain('adapter-openclaw');

    // Post-R3-2 ordering: skill cleanup ran BEFORE the unmerge, against the
    // same workspaceDir `mergeOpenClawConfig` persisted on the entry.
    expect(removeSkillStub).toHaveBeenCalledTimes(1);
    expect(removeSkillStub.mock.calls[0][0]).toBe(workspaceDir);
    expect(verifySkillRemovedStub).toHaveBeenCalledTimes(1);
  });

  it('scenario 2d: legacy (pre-R2) openclaw.json without installedWorkspace SKIPS skill cleanup but still unmerges the config (R11-2)', async () => {
    // Per R11-2: Disconnect no longer falls back to a config-derived
    // workspace when `entry.config.installedWorkspace` is missing. That
    // fallback would have let Disconnect delete a SKILL.md at a
    // `--workspace`-incongruent path. Instead, legacy entries simply skip
    // the skill-cleanup step; the config-level unmerge still completes,
    // and any pre-R2 SKILL.md the adapter owned stays on disk for the
    // user to clean manually.

    // Seed a legacy adapter entry (no `entry.config.installedWorkspace`).
    writeFileSync(openclawConfigPath, JSON.stringify({
      plugins: {},
      agents: { defaults: { workspace: workspaceDir } },
    }, null, 2));
    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const mergedPre = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    delete mergedPre.plugins.entries['adapter-openclaw'].config.installedWorkspace;
    writeFileSync(openclawConfigPath, JSON.stringify(mergedPre, null, 2));

    const removeSkillSpy = vi.fn();
    const verifySkillRemovedStub = vi.fn(() => null);

    const config = makeConfig();
    await reverseLocalAgentSetupForUi(config, openclawConfigPath, {
      removeCanonicalNodeSkill: removeSkillSpy,
      verifySkillRemoved: verifySkillRemovedStub,
    });

    // No legacy-fallback guessing → skill cleanup is skipped entirely.
    expect(removeSkillSpy).not.toHaveBeenCalled();
    expect(verifySkillRemovedStub).not.toHaveBeenCalled();

    // Config-level unmerge still completed — the adapter wiring is gone.
    const after = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(after.plugins?.entries?.['adapter-openclaw']).toBeUndefined();
    expect(after.plugins?.allow ?? []).not.toContain('adapter-openclaw');
  });

  it('scenario 2e: skill-removal failure propagates to runtime.lastError AND leaves openclaw.json untouched for retry (Codex R2-2 + R3-2)', async () => {
    // Regression for https://github.com/OriginTrail/dkg-v9/pull/234#discussion_r3120159512
    // (R2-2) and #discussion_r3120241631 (R3-2). R2-2 stopped swallowing skill-
    // removal errors; R3-2 reordered the flow so skill cleanup runs BEFORE
    // the config-level unmerge — a failure at the skill step must leave
    // `entry.config.installedWorkspace` and the adapter wiring intact so the user
    // can retry Disconnect and we still know which file to target.

    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const beforeDisconnect = readFileSync(openclawConfigPath, 'utf-8');

    // Stub removal to succeed (no-op) but have verifySkillRemoved claim the
    // file is still present — as if the unlink raced with another writer, or
    // a permission issue prevented the delete. The injected verifier mirrors
    // the real contract: non-null string → failure.
    const removeSkillNoop = vi.fn();
    const verifySkillRemovedFail = vi.fn(
      (ws: string) => `canonical node skill still present at ${join(ws, 'skills', 'dkg-node', 'SKILL.md')}`,
    );
    // Spies on the config-level ops — must NOT be invoked when the skill
    // step fails. Provide passing stubs so the default dynamic-import path
    // would still work if the code accidentally reached them, but the spy
    // counts prove the reorder held.
    const unmergeSpy = vi.fn();
    const verifyInvariantsSpy = vi.fn(() => null);

    const config = makeConfig();
    await expect(
      reverseLocalAgentSetupForUi(config, openclawConfigPath, {
        removeCanonicalNodeSkill: removeSkillNoop,
        verifySkillRemoved: verifySkillRemovedFail,
        unmergeOpenClawConfig: unmergeSpy,
        verifyUnmergeInvariants: verifyInvariantsSpy,
      }),
    ).rejects.toThrow(/SKILL\.md|still present/);

    // Skill-step deps were exercised against the installedWorkspace
    // recorded at merge time (workspaceDir is what the merge above passed).
    expect(removeSkillNoop).toHaveBeenCalledTimes(1);
    expect(removeSkillNoop.mock.calls[0][0]).toBe(workspaceDir);
    expect(verifySkillRemovedFail).toHaveBeenCalledTimes(1);
    expect(verifySkillRemovedFail.mock.calls[0][0]).toBe(workspaceDir);

    // R3-2: the config-level unmerge + invariant check were never reached,
    // so openclaw.json is byte-identical to its pre-Disconnect state. The
    // adapter entry — including `installedWorkspace` — is still present,
    // which is exactly what a retry needs.
    expect(unmergeSpy).not.toHaveBeenCalled();
    expect(verifyInvariantsSpy).not.toHaveBeenCalled();
    expect(readFileSync(openclawConfigPath, 'utf-8')).toBe(beforeDisconnect);
    const after = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(after.plugins.entries['adapter-openclaw']).toBeDefined();
    expect(after.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(workspaceDir);
  });

  it('scenario 2f: retry after a failed skill cleanup succeeds (Codex R3-2 recovery)', async () => {
    // First Disconnect: skill cleanup fails, openclaw.json is untouched.
    // Second Disconnect: real skill cleanup + real verify succeed, entry is removed.
    // Proves `entry.config.installedWorkspace` is still readable on retry — the whole
    // point of the R3-2 reorder.

    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const skillDir = join(workspaceDir, 'skills', 'dkg-node');
    const skillPath = join(skillDir, 'SKILL.md');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, '# Canonical DKG Node Skill\n');

    // Attempt 1: removal fails (stubbed no-op that never actually unlinks).
    // Real verifySkillRemoved then sees SKILL.md still on disk and throws.
    const removeSkillNoop = vi.fn();
    const config = makeConfig();
    await expect(
      reverseLocalAgentSetupForUi(config, openclawConfigPath, {
        removeCanonicalNodeSkill: removeSkillNoop,
        // verifySkillRemoved left as the real adapter helper — it observes
        // the still-present SKILL.md and returns a failure string.
      }),
    ).rejects.toThrow(/still present/);

    // Post-failure state: the adapter entry AND installedWorkspace survived.
    const afterAttempt1 = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(afterAttempt1.plugins.entries['adapter-openclaw']).toBeDefined();
    expect(afterAttempt1.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(workspaceDir);
    expect(afterAttempt1.plugins.slots.memory).toBe('adapter-openclaw');
    expect(existsSync(skillPath)).toBe(true);

    // Attempt 2: no stubs — run the real flow end-to-end. The
    // `entry.config.installedWorkspace` left in place is what the real
    // `reverseLocalAgentSetupForUi` reads to target SKILL.md.
    await expect(reverseLocalAgentSetupForUi(config, openclawConfigPath)).resolves.toBeUndefined();

    const afterAttempt2 = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(afterAttempt2.plugins.entries['adapter-openclaw']).toBeUndefined();
    expect(afterAttempt2.plugins.slots.memory).toBeUndefined();
    expect(existsSync(skillPath)).toBe(false);
  });

  it('scenario 2g: second Disconnect after a clean first Disconnect does NOT touch user-placed files at the config-derived workspace (Codex R5-4)', async () => {
    // Regression for https://github.com/OriginTrail/dkg-v9/pull/234#discussion_r3120437829
    // After a clean first Disconnect, the adapter entry is fully removed from
    // openclaw.json. The old code still fell through to
    // `resolveWorkspaceDirFromConfig` and would target SKILL.md at the
    // config-derived workspace — clobbering any user-placed file there.
    // Post-R5-4, an absent adapter entry gates skill cleanup entirely.

    // Seed openclaw.json WITHOUT a `plugins.entries['adapter-openclaw']`
    // entry (simulates the post-clean-Disconnect state) but with an
    // `agents.defaults.workspace` the old fallback would have targeted.
    writeFileSync(openclawConfigPath, JSON.stringify({
      plugins: { allow: [], load: { paths: [] }, entries: {}, slots: {} },
      agents: { defaults: { workspace: workspaceDir } },
    }, null, 2));

    // Seed a user-placed SKILL.md at the config-derived workspace. After a
    // clean first Disconnect this could be something the user restored
    // manually, or an unrelated file they placed under the same name.
    const userSkillDir = join(workspaceDir, 'skills', 'dkg-node');
    const userSkillPath = join(userSkillDir, 'SKILL.md');
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(userSkillPath, '# User-placed SKILL.md — NOT adapter-owned\n');
    const userBytes = readFileSync(userSkillPath, 'utf-8');

    const removeSkillSpy = vi.fn();
    const verifySkillRemovedSpy = vi.fn(() => null);

    const config = makeConfig();
    await expect(
      reverseLocalAgentSetupForUi(config, openclawConfigPath, {
        removeCanonicalNodeSkill: removeSkillSpy,
        verifySkillRemoved: verifySkillRemovedSpy,
      }),
    ).resolves.toBeUndefined();

    // R5-4: entry absent → skill cleanup path is never entered. Spies
    // prove neither helper was invoked.
    expect(removeSkillSpy).not.toHaveBeenCalled();
    expect(verifySkillRemovedSpy).not.toHaveBeenCalled();

    // User's SKILL.md is intact — byte-identical.
    expect(existsSync(userSkillPath)).toBe(true);
    expect(readFileSync(userSkillPath, 'utf-8')).toBe(userBytes);
  });

  it('scenario 2h: whitespace-padded entry.config.installedWorkspace is trimmed before skill cleanup (Codex R12-1)', async () => {
    // Regression for https://github.com/OriginTrail/dkg-v9/pull/234#discussion_r3123147766
    // Prior to the fix, the daemon's installedWorkspace read returned the
    // raw JSON value after a truthy `.trim()` check — whitespace-padded
    // strings passed validation but were then handed to
    // `removeCanonicalNodeSkill` / `verifySkillRemoved` verbatim, producing
    // a wrong (non-existent) path. Disconnect silently succeeded, the real
    // SKILL.md stayed orphaned. Now we trim at the read site.

    const paddedInstalledWorkspace = `  ${workspaceDir}  `;
    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const merged = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    // Inject whitespace around the authoritative pointer to simulate a
    // hand-edited or externally-written config value.
    merged.plugins.entries['adapter-openclaw'].config.installedWorkspace = paddedInstalledWorkspace;
    writeFileSync(openclawConfigPath, JSON.stringify(merged, null, 2));

    const removeSkillSpy = vi.fn();
    const verifySkillRemovedSpy = vi.fn(() => null);

    const config = makeConfig();
    await reverseLocalAgentSetupForUi(config, openclawConfigPath, {
      removeCanonicalNodeSkill: removeSkillSpy,
      verifySkillRemoved: verifySkillRemovedSpy,
    });

    // Both skill helpers must receive the TRIMMED path, not the raw
    // whitespace-padded value — otherwise the resolved SKILL.md path
    // (`<padded>/skills/dkg-node/SKILL.md`) wouldn't exist on disk and the
    // cleanup would silently no-op against the wrong location.
    expect(removeSkillSpy).toHaveBeenCalledTimes(1);
    expect(removeSkillSpy.mock.calls[0][0]).toBe(workspaceDir);
    expect(removeSkillSpy.mock.calls[0][0]).not.toBe(paddedInstalledWorkspace);
    expect(verifySkillRemovedSpy).toHaveBeenCalledTimes(1);
    expect(verifySkillRemovedSpy.mock.calls[0][0]).toBe(workspaceDir);
  });

  it('scenario 3a: refresh endpoint moves a bridge-ok integration to ready', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9201',
          },
          runtime: {
            status: 'error',
            ready: false,
            lastError: 'bridge offline (stale)',
          },
        },
      },
    });

    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const integration = await refreshLocalAgentIntegrationFromUi(config, 'openclaw', 'bridge-token');
      expect(fetchCalls).toBeGreaterThan(0);
      expect(integration.status).toBe('ready');
      expect(integration.runtime.ready).toBe(true);
      expect(integration.runtime.lastError).toBeFalsy();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('scenario 3b: refresh endpoint surfaces a 503 as runtime.status=error with lastError populated', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9201',
          },
          runtime: {
            status: 'ready',
            ready: true,
          },
        },
      },
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('bridge offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    })) as typeof fetch;

    try {
      const integration = await refreshLocalAgentIntegrationFromUi(config, 'openclaw', 'bridge-token');
      expect(integration.status).toBe('error');
      expect(integration.runtime.ready).toBe(false);
      expect(integration.runtime.lastError).toBeTruthy();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('scenario 3c: refresh on a non-openclaw known integration (hermes) returns the record without probing bridge health (Codex #3)', async () => {
    // Regression test for https://github.com/OriginTrail/dkg-v9/pull/228#discussion_r3117710821
    // The refresh route accepts any known integration id, not just openclaw. For non-openclaw
    // ids the helper short-circuits and returns the existing record without a health probe.
    const config = makeConfig();

    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response('should not be reached', { status: 500 });
    }) as typeof fetch;

    try {
      const integration = await refreshLocalAgentIntegrationFromUi(config, 'hermes', 'bridge-token');
      expect(integration).toBeTruthy();
      expect(integration.id).toBe('hermes');
      expect(fetchCalls).toBe(0); // no bridge probe for non-openclaw
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('scenario 3d: refresh on an unknown integration id throws (route maps to 404)', async () => {
    const config = makeConfig();
    await expect(
      refreshLocalAgentIntegrationFromUi(config, 'does-not-exist', 'bridge-token'),
    ).rejects.toThrow(/Unknown integration/);
  });

  it('scenario 4: post-setup invariant surfaces error when slot election silently fails', async () => {
    // Stub runSetup so it does NOT write plugins.slots.memory — simulates the
    // silent-no-op class of bug where mergeOpenClawConfig runs but leaves a
    // conflicting slot in place.
    seedOpenClawConfig({
      plugins: {
        slots: { memory: 'some-other-plugin' },
        allow: ['adapter-openclaw'],
        load: { paths: [] },
        entries: { 'adapter-openclaw': { enabled: true } },
      },
    });

    const config = makeConfig();
    const runSetup = async () => {
      // Intentionally no-op on the slot — the invariant check must catch this.
    };
    const restartGateway = async () => {};
    const waitForReady = async () => ({ ok: true as const, target: 'bridge' });
    const probeHealth = async () => ({ ok: false as const, error: 'bridge offline' });
    const saveConfig = async () => {};
    const verifyMemorySlot = () => {
      const raw = readFileSync(openclawConfigPath, 'utf-8');
      return JSON.parse(raw)?.plugins?.slots?.memory === 'adapter-openclaw';
    };
    let attachJob: Promise<void> | null = null;

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'openclaw', metadata: { source: 'node-ui' } },
      'bridge-token',
      {
        runSetup,
        restartGateway,
        waitForReady,
        probeHealth,
        saveConfig,
        verifyMemorySlot,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;

    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.status).toBe('error');
    expect(integration?.runtime.ready).toBe(false);
    expect(integration?.runtime.lastError).toMatch(/slot election/i);
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
