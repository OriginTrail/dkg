import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DkgConfig } from '../src/config.js';
import { connectLocalAgentIntegration, persistLocalAgentIntegration } from '../src/daemon/local-agents.js';
import { handleLocalAgentsRoutes } from '../src/daemon/routes/local-agents.js';
import { handleStatusRoutes } from '../src/daemon/routes/status.js';
import {
  applySharedMemoryTtl,
  createDaemonTelemetryRuntime,
  createLlmSettings,
} from '../src/daemon/runtime-settings.js';

// The daemon keeps the config it loaded at boot in memory. Each of its writes
// patches only the keys that setting or integration owns, so an edit another
// process (the CLI) made to the file after boot survives the daemon's write.
const previousDkgHome = process.env.DKG_HOME;
let home = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dkg-daemon-config-'));
  process.env.DKG_HOME = home;
});

afterEach(async () => {
  if (previousDkgHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = previousDkgHome;
  await rm(home, { recursive: true, force: true });
});

/** The daemon's in-memory config, loaded before the file was edited. */
function bootConfig(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return { name: 'node', apiPort: 9200, listenPort: 0, nodeRole: 'edge', ...overrides };
}

/** The file as another process left it after the daemon booted. */
async function fileEditedAfterBoot(config: Record<string, unknown>): Promise<string> {
  const content = JSON.stringify(config, null, 2);
  await writeFile(join(home, 'config.json'), content);
  return content;
}

async function readRaw(): Promise<string> {
  return readFile(join(home, 'config.json'), 'utf-8');
}

async function readFileConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readRaw());
}

function jsonRequest(method: string, path: string, payload: unknown) {
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

function jsonResponse() {
  const res = new EventEmitter() as any;
  res.statusCode = 0;
  res.body = '';
  res.writableEnded = false;
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.write = (chunk: string | Buffer) => { res.body += chunk.toString(); return true; };
  res.end = (chunk?: string | Buffer) => {
    if (chunk) res.write(chunk);
    res.writableEnded = true;
  };
  return res;
}

describe('daemon runtime settings', () => {
  it('switches telemetry on and persists only the master gate', async () => {
    await fileEditedAfterBoot({
      name: 'node',
      contextGraphs: ['saved-by-cli'],
      telemetry: { enabled: false, logs: { exporter: 'otlp', endpoint: 'http://localhost:4318/v1/logs' } },
    });
    const signals = { start: vi.fn(async () => ({ ok: true as const })), stop: vi.fn(async () => {}) };
    const runtime = createDaemonTelemetryRuntime({ config: bootConfig(), signals });

    await expect(runtime.setEnabled(true)).resolves.toEqual({ ok: true });

    expect(signals.start).toHaveBeenCalledTimes(1);
    expect(runtime.isEnabled()).toBe(true);
    expect(await readFileConfig()).toEqual({
      name: 'node',
      contextGraphs: ['saved-by-cli'],
      telemetry: { enabled: true, logs: { exporter: 'otlp', endpoint: 'http://localhost:4318/v1/logs' } },
    });
  });

  it('applies the LLM settings, persists them, and removes them when cleared', async () => {
    const config = bootConfig();
    await fileEditedAfterBoot({ name: 'node', contextGraphs: ['saved-by-cli'] });
    const memoryManager = { updateConfig: vi.fn() };
    const settings = createLlmSettings({ config, memoryManager, log: () => {} });
    const llm = { apiKey: 'key', model: 'model' };

    await settings.setLlm(llm);
    expect(settings.getLlm()).toEqual(llm);
    expect(memoryManager.updateConfig).toHaveBeenLastCalledWith(llm);
    expect(await readFileConfig()).toEqual({ name: 'node', contextGraphs: ['saved-by-cli'], llm });

    await settings.setLlm(null);
    expect(settings.getLlm()).toBeUndefined();
    expect(memoryManager.updateConfig).toHaveBeenLastCalledWith({ apiKey: '' });
    expect(await readFileConfig()).toEqual({ name: 'node', contextGraphs: ['saved-by-cli'] });
  });

  it('applies the shared memory TTL to the agent and persists it under its current and legacy keys', async () => {
    const config = bootConfig();
    await fileEditedAfterBoot({ name: 'node', contextGraphs: ['saved-by-cli'] });
    const agent = { setSharedMemoryTtlMs: vi.fn() };

    await applySharedMemoryTtl({ config, agent }, 86_400_000);

    expect(agent.setSharedMemoryTtlMs).toHaveBeenCalledWith(86_400_000);
    expect(config).toMatchObject({ sharedMemoryTtlMs: 86_400_000, workspaceTtlMs: 86_400_000 });
    expect(await readFileConfig()).toEqual({
      name: 'node',
      contextGraphs: ['saved-by-cli'],
      sharedMemoryTtlMs: 86_400_000,
      workspaceTtlMs: 86_400_000,
    });
  });
});

describe('daemon local agent integration writes', () => {
  it('writes one integration entry and keeps the others as the file has them', async () => {
    const config = bootConfig({ localAgentIntegrations: { hermes: { id: 'hermes', enabled: true } } });
    await fileEditedAfterBoot({
      name: 'node',
      contextGraphs: ['saved-by-cli'],
      localAgentIntegrations: { hermes: { id: 'hermes', enabled: false, metadata: { changedBy: 'cli' } } },
    });
    connectLocalAgentIntegration(config, { id: 'custom-agent', name: 'Custom agent' });

    await persistLocalAgentIntegration(config, 'custom-agent');

    const file = await readFileConfig();
    expect(file.contextGraphs).toEqual(['saved-by-cli']);
    expect(file.localAgentIntegrations.hermes).toEqual({ id: 'hermes', enabled: false, metadata: { changedBy: 'cli' } });
    expect(file.localAgentIntegrations['custom-agent'])
      .toEqual(JSON.parse(JSON.stringify(config.localAgentIntegrations!['custom-agent'])));
  });

  it('drops the legacy OpenClaw keys when it writes the OpenClaw entry', async () => {
    const config = bootConfig();
    await fileEditedAfterBoot({
      name: 'node',
      openclawAdapter: true,
      openclawChannel: { bridgeUrl: 'http://127.0.0.1:9201' },
    });
    connectLocalAgentIntegration(config, { id: 'openclaw' });

    await persistLocalAgentIntegration(config, 'openclaw');

    const file = await readFileConfig();
    expect(file).not.toHaveProperty('openclawAdapter');
    expect(file).not.toHaveProperty('openclawChannel');
    expect(file.localAgentIntegrations.openclaw.enabled).toBe(true);
  });

  it('writes nothing for an integration the daemon holds no record of', async () => {
    const before = await fileEditedAfterBoot({ name: 'node' });

    await persistLocalAgentIntegration(bootConfig(), 'custom-agent');

    expect(await readRaw()).toBe(before);
  });

  it('persists a connect request as that integration entry only', async () => {
    const config = bootConfig();
    await fileEditedAfterBoot({ name: 'node', contextGraphs: ['saved-by-cli'] });
    const res = jsonResponse();

    await handleLocalAgentsRoutes({
      req: jsonRequest('POST', '/api/local-agent-integrations/connect', { id: 'custom-agent', name: 'Custom agent' }),
      res,
      config,
      path: '/api/local-agent-integrations/connect',
    } as any);

    expect(res.statusCode).toBe(200);
    const file = await readFileConfig();
    expect(file.contextGraphs).toEqual(['saved-by-cli']);
    expect(file.localAgentIntegrations['custom-agent']).toMatchObject({ id: 'custom-agent', name: 'Custom agent', enabled: true });
  });

  it('writes nothing when a connect request is rejected', async () => {
    const before = await fileEditedAfterBoot({ name: 'node' });
    const res = jsonResponse();

    await handleLocalAgentsRoutes({
      req: jsonRequest('POST', '/api/local-agent-integrations/connect', { name: 'No id' }),
      res,
      config: bootConfig(),
      path: '/api/local-agent-integrations/connect',
    } as any);

    expect(res.statusCode).toBe(400);
    expect(await readRaw()).toBe(before);
  });

  it('persists the legacy register-adapter route as the OpenClaw entry', async () => {
    const config = bootConfig();
    await fileEditedAfterBoot({ name: 'node', contextGraphs: ['saved-by-cli'], openclawAdapter: true });
    const res = jsonResponse();

    await handleStatusRoutes({
      req: jsonRequest('POST', '/api/register-adapter', { id: 'openclaw' }),
      res,
      config,
      path: '/api/register-adapter',
    } as any);

    expect(res.statusCode).toBe(200);
    const file = await readFileConfig();
    expect(file.contextGraphs).toEqual(['saved-by-cli']);
    expect(file).not.toHaveProperty('openclawAdapter');
    expect(file.localAgentIntegrations.openclaw.enabled).toBe(true);
  });
});
