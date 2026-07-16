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
