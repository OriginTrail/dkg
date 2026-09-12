import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatMemoryManager, DashboardDB, handleNodeUIRequest } from '@origintrail-official/dkg-node-ui';
import { DkgHomeFiles, type DkgConfig } from '../src/config.js';
import { DkgConfigStore } from '../src/daemon-config-store.js';
import { createDaemonLlmSettings } from '../src/daemon/llm-settings.js';
import { createDaemonTelemetryLifecycle } from '../src/daemon/telemetry-lifecycle.js';
import { createTelemetryRuntime, createTelemetrySettings, type TelemetryRuntime, type TelemetrySignalAdapter } from '../src/daemon/telemetry-runtime.js';
import * as publication from '../src/fs-utils.js';

type Setting = 'llm' | 'telemetry';
const changes = { llm: { apiKey: 'new-fixture-key', model: 'new-model' }, telemetry: { enabled: true } };

describe('daemon runtime settings HTTP transactions', () => {
  let directory: string;
  let files: DkgHomeFiles;
  let initial: DkgConfig;
  let store: DkgConfigStore;
  let memory: ChatMemoryManager;
  let telemetry: TelemetryRuntime;
  let signals: TelemetrySignalAdapter;
  let db: DashboardDB;
  let server: Server;
  let base: string;
  let otelActive: boolean;
  let logsActive: boolean;
  // Read the production field passed to LlmClient; the manager has no config getter.
  const memoryConfig = () => (memory as unknown as { llmConfig: DkgConfig['llm'] }).llmConfig;
  const put = (setting: Setting) => fetch(base + '/api/settings/' + setting, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(changes[setting]),
  });
  async function assertViews(setting: Setting, changed: boolean, name = initial.name) {
    expect(store.current.name).toBe(name);
    const expectedLlm = setting === 'llm' && changed ? changes.llm : initial.llm;
    const expectedTelemetry = setting === 'telemetry' && changed;
    expect(memoryConfig()).toEqual(expectedLlm);
    expect(store.current.llm).toEqual(expectedLlm);
    expect(telemetry.isEnabled()).toBe(expectedTelemetry);
    expect(otelActive).toBe(expectedTelemetry);
    expect(logsActive).toBe(expectedTelemetry);
    expect(store.current.telemetry?.enabled).toBe(expectedTelemetry);
    expect(store.current.telemetry?.logs?.endpoint).toBe(initial.telemetry?.logs?.endpoint);
    expect(JSON.parse(await readFile(files.configPath, 'utf8'))).toEqual(store.current);
    const read = await fetch(base + '/api/settings/' + setting);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject(setting === 'llm'
      ? { configured: true, model: expectedLlm?.model } : { enabled: expectedTelemetry });
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dkg-runtime-settings-'));
    initial = {
      name: 'initial', apiPort: 0, listenPort: 0, nodeRole: 'edge',
      llm: { apiKey: 'old-fixture-key', model: 'old-model' },
      telemetry: { enabled: false, logs: { exporter: 'otlp', endpoint: 'http://collector.test/v1/logs' }, traces: { endpoint: 'http://collector.test/v1/traces' } },
    };
    files = new DkgHomeFiles(directory);
    await files.saveConfig(initial);
    store = await DkgConfigStore.open(files, initial);
    memory = new ChatMemoryManager({
      query: async () => [], createAssertion: async () => ({ assertionUri: null, alreadyExists: true }),
      writeAssertion: async () => ({ written: 0 }), createContextGraph: async () => undefined, listContextGraphs: async () => [],
    }, { ...initial.llm! });
    otelActive = false; logsActive = false;
    signals = createDaemonTelemetryLifecycle({
      config: initial, env: {}, resource: { serviceName: 'test-daemon' },
      initOtel: async () => { otelActive = true; }, shutdownOtel: async () => { otelActive = false; },
      startLogExporter: async () => { logsActive = true; return { ok: true }; },
      stopLogExporter: async () => { logsActive = false; }, log: () => undefined,
    });
    telemetry = createTelemetryRuntime({ configStore: store, signals });
    const llmSettings = createDaemonLlmSettings(store, memory, () => undefined);
    const telemetrySettings = createTelemetrySettings(telemetry);
    db = new DashboardDB({ dataDir: directory });
    server = createServer((req, res) => {
      void handleNodeUIRequest(req, res, new URL(req.url ?? '/', 'http://localhost'), db, directory,
        undefined, undefined, undefined, memory, llmSettings, telemetrySettings).catch(error => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error.message ?? error) }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing HTTP address');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await telemetry?.shutdown();
    db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(['llm', 'telemetry'] as const)('keeps a queued unrelated edit after blocked %s publication', async setting => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const write = publication.writeFileAtomic;
    const publishing = vi.spyOn(publication, 'writeFileAtomic').mockImplementationOnce(async (...args) => { await gate; return write(...args); });
    const changing = put(setting);
    try {
      await vi.waitFor(() => expect(publishing).toHaveBeenCalledOnce());
      const unrelated = store.update(current => ({ ...current, name: 'queued unrelated edit' }), 'configuration-only');
      expect(memoryConfig()).toEqual(initial.llm);
      expect(otelActive).toBe(false);
      expect(store.current).toEqual(initial);
      release();
      const response = await changing;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
      await unrelated;
      await assertViews(setting, true, 'queued unrelated edit');
    } finally { release(); await changing; }
  });

  it.each(['llm', 'telemetry'] as const)('rebases %s settings after a preceding unrelated publication', async setting => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const write = publication.writeFileAtomic;
    const publishing = vi.spyOn(publication, 'writeFileAtomic').mockImplementationOnce(async (...args) => { await gate; return write(...args); });
    const committing = vi.spyOn(store, 'update');
    const unrelated = store.update(current => ({ ...current, name: 'preceding unrelated edit' }), 'configuration-only');
    await vi.waitFor(() => expect(publishing).toHaveBeenCalledOnce());
    const changing = put(setting);
    try {
      await vi.waitFor(() => expect(committing).toHaveBeenCalledTimes(2));
      release();
      await unrelated;
      const response = await changing;
      expect(response.status).toBe(200);
      await assertViews(setting, true, 'preceding unrelated edit');
    } finally { release(); await changing; }
  });

  it.each(['llm', 'telemetry'] as const)('restores file, snapshot and runtime after %s activation mutates then throws', async setting => {
    const before = await readFile(files.configPath, 'utf8');
    if (setting === 'llm') {
      const update = memory.updateConfig.bind(memory);
      vi.spyOn(memory, 'updateConfig').mockImplementationOnce(config => { update(config); throw new Error('LLM activation failed after mutation'); });
    } else {
      const start = signals.start.bind(signals);
      vi.spyOn(signals, 'start').mockImplementationOnce(async () => { await start(); throw new Error('telemetry activation failed after mutation'); });
    }
    const response = await put(setting);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('failed after mutation') });
    expect(await readFile(files.configPath, 'utf8')).toBe(before);
    await assertViews(setting, false);
    await store.update(current => ({ ...current, name: 'successful successor' }), 'configuration-only');
    await assertViews(setting, false, 'successful successor');
  });

  it.each(['llm', 'telemetry'] as const)('preserves all views when %s file publication fails', async setting => {
    const before = await readFile(files.configPath, 'utf8');
    const memoryUpdate = vi.spyOn(memory, 'updateConfig');
    const startSignals = vi.spyOn(signals, 'start');
    vi.spyOn(publication, 'writeFileAtomic').mockRejectedValueOnce(new Error('settings disk full'));
    const response = await put(setting);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'settings disk full' });
    expect(memoryUpdate).not.toHaveBeenCalled();
    expect(startSignals).not.toHaveBeenCalled();
    expect(await readFile(files.configPath, 'utf8')).toBe(before);
    await assertViews(setting, false);
  });

  it('rejects an ordinary save that would bypass both running settings adapters', async () => {
    await expect(files.saveConfig({ ...initial, llm: changes.llm, telemetry: { enabled: true } })).rejects.toThrow('explicit activation');
    await assertViews('llm', false);
  });
});
