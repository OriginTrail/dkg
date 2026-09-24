import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import yaml from 'js-yaml';
import { loadConfig, updateConfigFile, type DkgConfig, type DkgConfigFileUpdate } from '../src/config.js';
import { registerPublisherCommand } from '../src/commands/publisher.js';
import {
  connectLocalAgentIntegration,
  listLocalAgentIntegrations,
  updateLocalAgentIntegration,
} from '../src/daemon/local-agents.js';
import { persistLocalAgentIntegration } from '../src/daemon/local-agent-config-store.js';
import { withFileLease } from '../src/file-lock.js';
import { handleLocalAgentsRoutes } from '../src/daemon/routes/local-agents.js';
import { handleStatusRoutes } from '../src/daemon/routes/status.js';
import {
  createDaemonTelemetryRuntime,
  createLlmSettings,
  createSharedMemoryTtlSetting,
} from '../src/daemon/runtime-settings.js';

// The writer runs for real unless a test stands in for it.
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, updateConfigFile: vi.fn(actual.updateConfigFile) };
});

// The Hermes attach job and refresh probe run for real; only the bridge probe
// and the setup entrypoint they call are stubbed.
const hermesMocks = vi.hoisted(() => ({ probe: vi.fn(), setup: vi.fn() }));
vi.mock('../src/daemon/hermes.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/daemon/hermes.js')>(),
  probeHermesChannelHealth: hermesMocks.probe,
  runHermesUiSetup: hermesMocks.setup,
}));

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
  vi.mocked(updateConfigFile).mockReset();
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

/** Hold the config lock, as another write would, until the returned release is called. */
async function holdConfigLock(): Promise<{ release: () => Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const holder = withFileLease(join(home, 'config.lock'), () => held, { timeoutMs: 5_000 });
  await vi.waitFor(() => expect(existsSync(join(home, 'config.lock'))).toBe(true));
  return { release: async () => { release(); await holder; } };
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

  it('applies overlapping LLM changes in the order they were requested, whichever write finishes first', async () => {
    const config = bootConfig();
    const memoryManager = { updateConfig: vi.fn() };
    const settings = createLlmSettings({ config, memoryManager, log: () => {} });
    const pending: Array<() => void> = [];
    vi.mocked(updateConfigFile).mockImplementation(() => new Promise<DkgConfigFileUpdate>((resolve) => {
      pending.push(() => resolve({ path: join(home, 'config.json'), changed: true, strategy: 'rename' }));
    }));

    const first = settings.setLlm({ apiKey: 'first' });
    const second = settings.setLlm({ apiKey: 'second' });
    // Finish the newest write in flight first, as a lock handed to the later writer would.
    for (let finished = 0; finished < 2; finished += 1) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.pop()!();
    }
    await Promise.all([first, second]);

    expect(memoryManager.updateConfig.mock.calls).toEqual([[{ apiKey: 'first' }], [{ apiKey: 'second' }]]);
    expect(config.llm).toEqual({ apiKey: 'second' });
  });

  // An operator's typo in config.json makes the write fail, as a lock
  // timeout or a failed replace would: the running node keeps its setting.
  it('changes neither the node nor the file when the LLM write fails, and the next change still goes through', async () => {
    const config = bootConfig({ llm: { apiKey: 'booted' } });
    const unparseable = '{ "name": "node",';
    await writeFile(join(home, 'config.json'), unparseable);
    const memoryManager = { updateConfig: vi.fn() };
    const settings = createLlmSettings({ config, memoryManager, log: () => {} });

    await expect(settings.setLlm({ apiKey: 'requested' })).rejects.toThrow(SyntaxError);
    await expect(settings.setLlm(null)).rejects.toThrow(SyntaxError);

    expect(config.llm).toEqual({ apiKey: 'booted' });
    expect(memoryManager.updateConfig).not.toHaveBeenCalled();
    expect(await readRaw()).toBe(unparseable);

    await fileEditedAfterBoot({ name: 'node' });
    await settings.setLlm({ apiKey: 'requested' });
    expect(config.llm).toEqual({ apiKey: 'requested' });
    expect(memoryManager.updateConfig).toHaveBeenCalledWith({ apiKey: 'requested' });
    expect((await readFileConfig()).llm).toEqual({ apiKey: 'requested' });
  });

  it('changes neither the agent nor the file when the shared memory TTL write fails, and the next change still goes through', async () => {
    const config = bootConfig({ sharedMemoryTtlMs: 3_600_000, workspaceTtlMs: 3_600_000 });
    const unparseable = '{ "name": "node",';
    await writeFile(join(home, 'config.json'), unparseable);
    const agent = { setSharedMemoryTtlMs: vi.fn() };
    const ttl = createSharedMemoryTtlSetting({ config, agent });

    await expect(ttl.set(86_400_000)).rejects.toThrow(SyntaxError);

    expect(config).toMatchObject({ sharedMemoryTtlMs: 3_600_000, workspaceTtlMs: 3_600_000 });
    expect(agent.setSharedMemoryTtlMs).not.toHaveBeenCalled();
    expect(await readRaw()).toBe(unparseable);

    await fileEditedAfterBoot({ name: 'node' });
    await ttl.set(86_400_000);
    expect(agent.setSharedMemoryTtlMs).toHaveBeenCalledWith(86_400_000);
    expect(await readFileConfig()).toEqual({ name: 'node', sharedMemoryTtlMs: 86_400_000, workspaceTtlMs: 86_400_000 });
  });

  it('applies the shared memory TTL to the agent and persists it under its current and legacy keys', async () => {
    const config = bootConfig();
    await fileEditedAfterBoot({ name: 'node', contextGraphs: ['saved-by-cli'] });
    const agent = { setSharedMemoryTtlMs: vi.fn() };

    await createSharedMemoryTtlSetting({ config, agent }).set(86_400_000);

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

  // A connect route's write and its attach job's write can both wait for the
  // lock; whichever runs last must store the newer record.
  it('writes the integration record the daemon holds when the write runs, not when it was requested', async () => {
    const config = bootConfig();
    connectLocalAgentIntegration(config, { id: 'custom-agent', runtime: { status: 'connecting' } });
    await fileEditedAfterBoot({ name: 'node' });
    const lock = await holdConfigLock();

    const write = persistLocalAgentIntegration(config, 'custom-agent');
    updateLocalAgentIntegration(config, 'custom-agent', { runtime: { status: 'ready', ready: true } });
    await lock.release();
    await write;

    expect((await readFileConfig()).localAgentIntegrations['custom-agent'].runtime)
      .toMatchObject({ status: 'ready', ready: true });
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

  // `__proto__` is a valid integration id; it must reach the file as an
  // entry of its own, beside the others, and come back after a restart.
  it.each(['json', 'yaml'])('persists a __proto__ integration beside another one, and reloads both (%s)', async (format) => {
    const config = bootConfig();
    const onDisk = { name: 'node', localAgentIntegrations: { hermes: { id: 'hermes', name: 'Hermes' } } };
    if (format === 'json') await fileEditedAfterBoot(onDisk);
    else await writeFile(join(home, 'config.yaml'), yaml.dump(onDisk));
    const res = jsonResponse();

    await handleLocalAgentsRoutes({
      req: jsonRequest('POST', '/api/local-agent-integrations/connect', { id: '__proto__', name: 'Proto agent' }),
      res,
      config,
      path: '/api/local-agent-integrations/connect',
    } as any);

    expect(res.statusCode).toBe(200);
    const reloaded = await loadConfig();
    expect(Object.keys(reloaded.localAgentIntegrations ?? {})).toEqual(['hermes', '__proto__']);
    expect(listLocalAgentIntegrations(reloaded).find((integration) => integration.id === '__proto__'))
      .toMatchObject({ id: '__proto__', name: 'Proto agent', enabled: true });
  });

  it('persists the state a node-UI attach job reaches after the route has answered', async () => {
    const config = bootConfig();
    await fileEditedAfterBoot({ name: 'node', contextGraphs: ['saved-by-cli'] });
    const transport = { kind: 'hermes-channel', bridgeUrl: 'http://127.0.0.1:9202' };
    hermesMocks.probe.mockResolvedValue({ ok: false, error: 'bridge offline' });
    // Setup finishes only after the route has answered and written its own record.
    let finishSetup!: (result: unknown) => void;
    hermesMocks.setup.mockReturnValue(new Promise((resolve) => { finishSetup = resolve; }));
    const res = jsonResponse();

    await handleLocalAgentsRoutes({
      req: jsonRequest('POST', '/api/local-agent-integrations/connect', {
        id: 'hermes',
        metadata: { source: 'node-ui', profileName: 'test', hermesHome: home },
      }),
      res,
      config,
      path: '/api/local-agent-integrations/connect',
    } as any);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).integration.runtime.status).toBe('connecting');
    expect((await readFileConfig()).localAgentIntegrations.hermes.runtime.status).toBe('connecting');

    finishSetup({
      ok: true,
      status: 'configured',
      profile: { profileName: 'test', hermesHome: home },
      daemonStarted: true,
      fundedWallets: [],
      transport,
      warnings: [],
      errors: [],
    });
    await vi.waitFor(async () => {
      expect((await readFileConfig()).localAgentIntegrations?.hermes?.runtime?.status).toBe('ready');
    });
    const file = await readFileConfig();
    expect(file.contextGraphs).toEqual(['saved-by-cli']);
    expect(file.localAgentIntegrations.hermes).toMatchObject({ enabled: true, transport, runtime: { ready: true } });
  });

  it('persists what a refresh finds as that integration entry only', async () => {
    const config = bootConfig({
      localAgentIntegrations: {
        hermes: {
          id: 'hermes',
          enabled: true,
          transport: { kind: 'hermes-channel', bridgeUrl: 'http://127.0.0.1:9202' },
          runtime: { status: 'degraded', ready: false, lastError: 'bridge offline' },
        },
      },
    });
    await fileEditedAfterBoot({ name: 'node', contextGraphs: ['saved-by-cli'] });
    hermesMocks.probe.mockResolvedValue({ ok: true, target: 'bridge' });
    const res = jsonResponse();

    await handleLocalAgentsRoutes({
      req: jsonRequest('POST', '/api/local-agent-integrations/hermes/refresh', {}),
      res,
      config,
      path: '/api/local-agent-integrations/hermes/refresh',
    } as any);

    expect(res.statusCode).toBe(200);
    const file = await readFileConfig();
    expect(file.contextGraphs).toEqual(['saved-by-cli']);
    expect(file.localAgentIntegrations.hermes.runtime).toMatchObject({ status: 'ready', ready: true, lastError: null });
  });

  it('persists a disconnect as that integration entry only', async () => {
    const connected = { id: 'custom-agent', enabled: true, runtime: { status: 'ready', ready: true } };
    const config = bootConfig({ localAgentIntegrations: { 'custom-agent': connected } });
    await fileEditedAfterBoot({
      name: 'node',
      contextGraphs: ['saved-by-cli'],
      localAgentIntegrations: { 'custom-agent': connected },
    });
    const res = jsonResponse();

    await handleLocalAgentsRoutes({
      req: jsonRequest('PUT', '/api/local-agent-integrations/custom-agent', {
        enabled: false,
        runtime: { status: 'disconnected' },
      }),
      res,
      config,
      path: '/api/local-agent-integrations/custom-agent',
    } as any);

    expect(res.statusCode).toBe(200);
    const file = await readFileConfig();
    expect(file.contextGraphs).toEqual(['saved-by-cli']);
    expect(file.localAgentIntegrations['custom-agent']).toMatchObject({
      enabled: false,
      runtime: { status: 'disconnected', ready: false },
      metadata: { userDisabled: true },
    });
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

// A node configured through config.yaml must stay on it: every daemon and CLI
// write edits that file in place and never adds a config.json, which would
// take precedence and hide the YAML from then on.
describe('a node configured through config.yaml', () => {
  const yamlConfig = [
    '# pinned until the Q3 hub rotation',
    'chain:',
    '  hubAddress: "0xabc"',
    'name: yaml-node',
    '',
  ].join('\n');

  async function readYaml(): Promise<{ text: string; config: Record<string, any> }> {
    const text = await readFile(join(home, 'config.yaml'), 'utf-8');
    return { text, config: yaml.load(text) as Record<string, any> };
  }

  it('keeps its YAML and comments through a daemon write and a CLI command', async () => {
    await writeFile(join(home, 'config.yaml'), yamlConfig);
    const config = bootConfig();
    connectLocalAgentIntegration(config, { id: 'hermes', name: 'Hermes' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    await persistLocalAgentIntegration(config, 'hermes');
    const program = new Command();
    program.exitOverride();
    registerPublisherCommand(program);
    await program.parseAsync(['publisher', 'enable'], { from: 'user' });

    expect(existsSync(join(home, 'config.json'))).toBe(false);
    const { text, config: written } = await readYaml();
    expect(text).toContain('# pinned until the Q3 hub rotation\nchain:\n  hubAddress: "0xabc"');
    expect(written).toMatchObject({
      name: 'yaml-node',
      chain: { hubAddress: '0xabc' },
      localAgentIntegrations: { hermes: { id: 'hermes', enabled: true } },
      publisher: { enabled: true },
    });
    vi.restoreAllMocks();
  });
});
