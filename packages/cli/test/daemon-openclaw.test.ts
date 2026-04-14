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
  isLoopbackClientIp,
  isValidOpenClawPersistTurnPayload,
  listLocalAgentIntegrations,
  parseRequiredSignatures,
  pipeOpenClawStream,
  probeOpenClawChannelHealth,
  normalizeExplicitLocalAgentDisconnectBody,
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

describe('OpenClaw UI setup command resolution', () => {
  const runtimeModuleUrl = 'file:///C:/Projects/dkg-v9/packages/cli/dist/daemon.js';

  it('prefers the local workspace adapter setup CLI when it exists', () => {
    const command = getOpenClawUiSetupCommand(
      '@origintrail-official/dkg-adapter-openclaw',
      runtimeModuleUrl,
      (path) => path.endsWith('packages\\adapter-openclaw\\dist\\setup-cli.js'),
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

  it('lists built-in local integrations even before they are connected', () => {
    const integrations = listLocalAgentIntegrations(makeConfig());

    expect(integrations.map((integration) => integration.id)).toEqual(['hermes', 'openclaw']);
    expect(integrations.every((integration) => integration.enabled === false)).toBe(true);
    expect(integrations.every((integration) => integration.status === 'disconnected')).toBe(true);
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
    expect((config as Record<string, unknown>).openclawAdapter).toBeUndefined();
    expect((config as Record<string, unknown>).openclawChannel).toBeUndefined();
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
    expect(result.notice).toBe('OpenClaw is connected and chat-ready.');
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
    expect((config as Record<string, unknown>).openclawAdapter).toBeUndefined();
    expect((config as Record<string, unknown>).openclawChannel).toBeUndefined();
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
