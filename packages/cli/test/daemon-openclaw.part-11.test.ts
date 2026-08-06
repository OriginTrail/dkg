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

    // Sorted by display name, so Prime Agent lands after OpenClaw.
    expect(integrations.map((integration) => integration.id)).toEqual(['hermes', 'openclaw', 'prime-agent']);
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
    expect(result.notice).toBe('OpenClaw is connected and chat-ready.');
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

});
