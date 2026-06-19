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

});
