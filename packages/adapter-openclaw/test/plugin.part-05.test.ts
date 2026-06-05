import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { homedir, tmpdir } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { toEip55Checksum } from '@origintrail-official/dkg-core';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import { DkgChannelPlugin } from '../src/DkgChannelPlugin.js';
import { ChatTurnWriter } from '../src/ChatTurnWriter.js';
import { INTERNAL_HOOK_SYMBOL } from '../src/HookSurface.js';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types.js';

describe("DkgNodePlugin", () => {

  it('can be instantiated with default config', () => {
    const plugin = new DkgNodePlugin();
    expect(plugin).toBeDefined();
  });


  it('can be instantiated with custom config', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9999',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect(plugin).toBeDefined();
  });


  it('merges partial config refreshes without dropping existing module config', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true, memoryDir: '/memory' },
      channel: { enabled: true, port: 9201 },
    });

    plugin.updateConfig({
      stateDir: '/workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/workspace',
    }, { partial: true });

    expect((plugin as any).config).toMatchObject({
      daemonUrl: 'http://localhost:9200',
      stateDir: '/workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/workspace',
      memory: { enabled: true, memoryDir: '/memory' },
      channel: { enabled: true, port: 9201 },
    });
  });


  it('replaces config snapshots when the refresh is fully materialized', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: true, port: 9201 },
    });

    plugin.updateConfig({
      stateDir: '/workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/workspace',
    });

    expect((plugin as any).config).toEqual({
      stateDir: '/workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/workspace',
    });
  });


  it('round-trips query catalog resultColumn metadata in list output', async () => {
    const plugin = new DkgNodePlugin();
    (plugin as any).client = {
      readQueryCatalog: vi.fn(async () => ({
        result: {
          type: 'bindings',
          bindings: [
            {
              q: 'urn:dkg:profile:cg-1:query:orders',
              catalog: 'urn:dkg:profile:cg-1:catalog:saved',
              name: '"Orders"',
              sparql: '"SELECT ?uri WHERE { ?uri ?p ?o }"',
              resultColumn: '"uri"',
              subGraph: '"__context_graph"',
            },
          ],
        },
      })),
    };

    const result = await (plugin as any).handleQueryCatalogList({ context_graph_id: 'cg-1' });

    expect((result.details as any).items[0]).toMatchObject({
      slug: 'orders',
      name: 'Orders',
      resultColumn: 'uri',
      subGraph: '__context_graph',
    });
  });


  it('runs saved query catalog entries against their saved sub-graph scope', async () => {
    const query = vi.fn(async () => ({ result: { bindings: [] } }));
    const plugin = new DkgNodePlugin();
    (plugin as any).client = {
      readQueryCatalog: vi.fn(async () => ({
        result: {
          type: 'bindings',
          bindings: [
            {
              q: 'urn:dkg:profile:cg-1:query:orders',
              catalog: 'urn:dkg:profile:cg-1:catalog:saved',
              name: '"Orders"',
              sparql: '"SELECT ?s WHERE { ?s ?p ?o }"',
              resultColumn: '"s"',
              subGraph: '"production"',
            },
          ],
        },
      })),
      query,
    };

    const result = await (plugin as any).handleQueryCatalogRun({ context_graph_id: 'cg-1', query: 'orders' });

    expect(query).toHaveBeenCalledWith('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId: 'cg-1',
      subGraphName: 'production',
    });
    expect((result.details as any).savedQuery).toMatchObject({
      resultColumn: 's',
      subGraph: 'production',
    });
  });


  it('saves query catalog timestamp ranks as unbounded integer literals', async () => {
    const rank = 1_714_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(rank);
    const writeQueryCatalog = vi.fn(async () => ({ written: true }));
    const plugin = new DkgNodePlugin();
    (plugin as any).client = { writeQueryCatalog };

    try {
      const result = await (plugin as any).handleQueryCatalogSave({
        context_graph_id: 'cg-1',
        name: 'Orders',
        sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
      });

      const savedQuery = (result.details as any).savedQuery;
      const quads = writeQueryCatalog.mock.calls[0][1];
      const rankQuad = quads.find((q: any) =>
        q.subject === savedQuery.queryUri && q.predicate === 'http://dkg.io/ontology/profile/rank'
      );

      expect(rankQuad?.object).toBe(`"${rank}"^^<http://www.w3.org/2001/XMLSchema#integer>`);
    } finally {
      nowSpy.mockRestore();
    }
  });


  it('bootstraps resolver state even when slot is owned by another plugin (R10.2)', async () => {
    // Pre-fix: when memory slot was owned by a different plugin, the
    // resolver bootstrap (`memoryResolverApi = api` + `refreshMemoryResolverState`)
    // was inside the slot-registered branch and got skipped. The
    // memory_search tool was still exposed but stuck in a permanent
    // "backend not ready" response forever (no peer ID, no CG cache).
    // Fix moves bootstrap OUT, runs whenever memory module is enabled.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    const mockApi = {
      config: { plugins: { slots: { memory: 'some-other-memory-plugin' } } },
      registrationMode: 'full' as const,
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('/api/status')) return { ok: true, status: 200, json: async () => ({ peerId: 'p-r102' }) } as Response;
      if (url.includes('/api/context-graph/list')) return { ok: true, status: 200, json: async () => ({ contextGraphs: [] }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as any;
    try {
      plugin.register(mockApi);
      // Slot owned by another plugin → registerMemoryCapability never called.
      expect(mockApi.registerMemoryCapability).not.toHaveBeenCalled();
      // But resolver bootstrap MUST still happen so memory_search works
      // against the daemon directly. Wait for the async refresh to settle.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect((plugin as any).memoryResolverApi).toBe(mockApi);
      expect((plugin as any).nodePeerId).toBe('p-r102');
    } finally {
      globalThis.fetch = origFetch;
    }
  });


  it('reads memory slot ownership from runtime config when api.config is adapter plugin config', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    const registerMemoryCapability = vi.fn();
    const mockApi = {
      config: {
        daemonUrl: 'http://localhost:9200',
        stateDir: '/workspace/.dkg-adapter',
        stateDirSource: 'setup-default',
        installedWorkspace: '/workspace',
        memory: { enabled: true },
      },
      runtime: {
        config: {
          plugins: {
            slots: {
              memory: 'adapter-openclaw',
            },
          },
        },
      },
      registrationMode: 'full' as const,
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability,
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('/api/status')) {
        return { ok: true, status: 200, json: async () => ({ peerId: 'p-runtime-config' }) } as Response;
      }
      if (url.includes('/api/agent/identity')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ identity: { agentAddress: '0x0000000000000000000000000000000000000001' } }),
        } as Response;
      }
      if (url.includes('/api/context-graph/list')) {
        return { ok: true, status: 200, json: async () => ({ contextGraphs: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as any;
    try {
      plugin.register(mockApi);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(registerMemoryCapability).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });


  it('queues channel module recreation until the previous bridge stops', async () => {
    const registerSpy = vi.spyOn(DkgChannelPlugin.prototype, 'register').mockImplementation(() => {});
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
    const stopSpy = vi.spyOn(DkgChannelPlugin.prototype, 'stop').mockImplementation(() => stopPromise);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 9201 },
        memory: { enabled: true },
      });
      (plugin as any).client = {};
      (plugin as any).refreshMemoryResolverState = vi.fn(() => Promise.resolve());
      const syncLocalAgentSpy = vi
        .spyOn(plugin as any, 'syncLocalAgentIntegrationState')
        .mockResolvedValue(undefined);
      (plugin as any).chatTurnWriter = {} as any;
      const registerMemoryCapability = vi.fn();
      const mockApi = {
        config: {
          plugins: {
            slots: {
              memory: 'adapter-openclaw',
            },
          },
        },
        registerTool: () => {},
        registerHook: () => {},
        registerMemoryCapability,
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;

      (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true, registrationMode: 'full' });
      const firstChannelPlugin = (plugin as any).channelPlugin;
      const chatTurnWriter = (plugin as any).chatTurnWriter;

      plugin.updateConfig({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 9202 },
        memory: { enabled: true },
      });
      (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true, registrationMode: 'full' });
      (plugin as any).scheduleLocalAgentIntegrationRetry(mockApi, 'full');
      expect((plugin as any).localAgentIntegrationRetryTimer).not.toBeNull();
      (plugin as any).registerLocalAgentIntegration(mockApi, 'full');

      expect(firstChannelPlugin).toBeDefined();
      expect((plugin as any).channelPlugin).toBe(firstChannelPlugin);
      expect((firstChannelPlugin as any).preDispatchReAssert).toBeNull();
      expect(stopSpy).toHaveBeenCalledWith({ updateGatewayStatus: false });
      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(registerMemoryCapability).toHaveBeenCalledTimes(2);
      expect(syncLocalAgentSpy).not.toHaveBeenCalled();
      expect((plugin as any).localAgentIntegrationRetryTimer).toBeNull();

      const stopInFlight = (plugin as any).channelPluginStopInFlight;
      resolveStop();
      await stopInFlight;
      const secondChannelPlugin = (plugin as any).channelPlugin;

      expect(secondChannelPlugin).toBeDefined();
      expect(secondChannelPlugin).not.toBe(firstChannelPlugin);
      expect((secondChannelPlugin as any).chatTurnWriter).toBe(chatTurnWriter);
      expect((secondChannelPlugin as any).preDispatchReAssert).toEqual(expect.any(Function));
      expect(registerSpy).toHaveBeenCalledTimes(2);
      expect(syncLocalAgentSpy).toHaveBeenCalledTimes(1);
    } finally {
      registerSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });


  it('keeps the existing channel bridge when reconfiguration stop fails', async () => {
    const registerSpy = vi.spyOn(DkgChannelPlugin.prototype, 'register').mockImplementation(() => {});
    const stopSpy = vi.spyOn(DkgChannelPlugin.prototype, 'stop').mockRejectedValue(new Error('port still busy'));
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 9201 },
        memory: { enabled: true },
      });
      (plugin as any).client = {};
      (plugin as any).refreshMemoryResolverState = vi.fn(() => Promise.resolve());
      (plugin as any).chatTurnWriter = {} as any;
      const registerMemoryCapability = vi.fn();
      const mockApi = {
        config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
        registerTool: () => {},
        registerHook: () => {},
        registerMemoryCapability,
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;

      (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });
      const firstChannelPlugin = (plugin as any).channelPlugin;
      expect((firstChannelPlugin as any).preDispatchReAssert).toEqual(expect.any(Function));

      plugin.updateConfig({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 9202 },
        memory: { enabled: true },
      });
      (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });

      const stopInFlight = (plugin as any).channelPluginStopInFlight;
      expect(stopInFlight).toBeDefined();
      expect((plugin as any).channelPlugin).toBe(firstChannelPlugin);
      expect((firstChannelPlugin as any).preDispatchReAssert).toBeNull();
      await stopInFlight;

      expect((plugin as any).channelPlugin).toBe(firstChannelPlugin);
      expect((plugin as any).channelPluginConfigFingerprint).not.toBeNull();
      expect((firstChannelPlugin as any).preDispatchReAssert).toEqual(expect.any(Function));
      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(mockApi.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Channel module reconfiguration stop failed'),
      );
    } finally {
      registerSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });


  it('cancels a queued channel restart when a later refresh disables the channel', async () => {
    const registerSpy = vi.spyOn(DkgChannelPlugin.prototype, 'register').mockImplementation(() => {});
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
    const stopSpy = vi.spyOn(DkgChannelPlugin.prototype, 'stop').mockImplementation(() => stopPromise);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 9201 },
        memory: { enabled: false },
      });
      (plugin as any).client = {};
      (plugin as any).chatTurnWriter = {} as any;
      const mockApi = {
        config: {},
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;

      (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });
      const firstChannelPlugin = (plugin as any).channelPlugin;
      plugin.updateConfig({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 9202 },
        memory: { enabled: false },
      });
      (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });
      const stopInFlight = (plugin as any).channelPluginStopInFlight;

      plugin.updateConfig({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      });
      (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });

      expect((plugin as any).channelPlugin).toBe(firstChannelPlugin);
      expect((plugin as any).pendingChannelStartApi).toBeNull();
      expect(stopSpy).toHaveBeenNthCalledWith(1, { updateGatewayStatus: false });
      expect(stopSpy).toHaveBeenNthCalledWith(2, { updateGatewayStatus: true });

      resolveStop();
      await stopInFlight;

      expect((plugin as any).channelPlugin).toBeNull();
      expect(registerSpy).toHaveBeenCalledTimes(1);
    } finally {
      registerSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });
});
