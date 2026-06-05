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


  it('all tools have name, description, parameters, and execute', () => {
    const plugin = new DkgNodePlugin();
    const tools: OpenClawTool[] = [];

    const mockApi: OpenClawPluginApi = {
      config: {},
      registerTool: (tool) => tools.push(tool),
      registerHook: () => {},
      on: () => {},
      logger: {},
    };

    plugin.register(mockApi);

    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe('object');
      expect(typeof tool.execute).toBe('function');
    }
  });


  it('stop() is safe to call without register()', async () => {
    const plugin = new DkgNodePlugin();
    await expect(plugin.stop()).resolves.toBeUndefined();
  });


  it('T30 — capabilities.dkgPrimaryMemory / wmImportPipeline mirror actual memory-slot registration state', async () => {
    // Regression for T30: pre-fix the local-agent connect payload
    // statically advertised `dkgPrimaryMemory: true` and
    // `wmImportPipeline: true` from a frozen constant — even when
    // memory was config-disabled, or another plugin owned the slot.
    // Daemon/UI consumers would then offer DKG-backed memory actions
    // that the slot's actual owner couldn't honour. Post-fix the
    // flags are derived from `this.memoryPlugin?.isRegistered()`.
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;
    try {
      // Memory enabled → registration succeeds → flags should be true.
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: true },
      });
      const mockApi: OpenClawPluginApi = {
        config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerMemoryCapability: vi.fn(),
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      await vi.waitFor(() => {
        const connectCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/connect'),
        );
        expect(connectCall).toBeTruthy();
      });
      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      const body = JSON.parse(String(connectCall?.[1]?.body));
      expect(body.capabilities.dkgPrimaryMemory).toBe(true);
      expect(body.capabilities.wmImportPipeline).toBe(true);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });


  it('getClient() returns the DkgDaemonClient after register()', () => {
    const plugin = new DkgNodePlugin({ daemonUrl: 'http://example.com:9200' });
    const mockApi: OpenClawPluginApi = {
      config: {},
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: {},
    };
    plugin.register(mockApi);
    const client = plugin.getClient();
    expect(client).toBeDefined();
    expect(client.baseUrl).toBe('http://example.com:9200');
  });


  it('refreshes daemon-scoped clients and identity caches after singleton config update', async () => {
    const originalFetch = globalThis.fetch;
    const stateDir = path.join(require('os').tmpdir(), `dkg-t75-client-refresh-${Date.now()}`);
    const oldAgent = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const newAgent = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const flushAsync = async () => {
      for (let i = 0; i < 25; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const isNew = url.startsWith('http://localhost:9300');
      if (url.endsWith('/api/status')) {
        return new Response(JSON.stringify({ peerId: isNew ? 'peer-new' : 'peer-old' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/agent/identity')) {
        return new Response(JSON.stringify({
          agentAddress: isNew ? newAgent : oldAgent,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/context-graph/list')) {
        return new Response(JSON.stringify({
          contextGraphs: [{ id: isNew ? 'cg-new' : 'cg-old', synced: true, isSystem: false }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      stateDir,
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      registerMemoryCapability: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    try {
      plugin.register(mockApi);
      await flushAsync();
      expect(plugin.getClient().baseUrl).toBe('http://localhost:9200');
      expect((plugin as any).nodePeerId).toBe('peer-old');
      expect((plugin as any).nodeAgentAddress).toBe(oldAgent);
      expect((plugin as any).availableContextGraphCache).toEqual(['cg-old']);

      plugin.updateConfig({
        daemonUrl: 'http://localhost:9300',
        stateDir,
        channel: { enabled: false },
        memory: { enabled: true },
      } as any);

      expect(plugin.getClient().baseUrl).toBe('http://localhost:9300');
      expect((plugin as any).nodePeerId).toBeUndefined();
      expect((plugin as any).nodeAgentAddress).toBeUndefined();
      expect((plugin as any).availableContextGraphCache).toEqual([]);
      expect(((plugin as any).chatTurnWriter as any).client.baseUrl).toBe('http://localhost:9300');
      expect(((plugin as any).memoryPlugin as any).client.baseUrl).toBe('http://localhost:9300');

      plugin.register(mockApi);
      await flushAsync();
      expect((plugin as any).nodePeerId).toBe('peer-new');
      expect((plugin as any).nodeAgentAddress).toBe(newAgent);
      expect((plugin as any).availableContextGraphCache).toEqual(['cg-new']);
    } finally {
      await plugin.stop();
      globalThis.fetch = originalFetch;
      try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T364 round 6 — aborts in-flight local-agent sync when channel.enabled flips to false mid-await', async () => {
    // Regression: pre-fix syncLocalAgentIntegrationState only checked
    // daemonClientGeneration at each yield. A config flip from
    // channel.enabled=true→false does NOT bump that generation, so
    // a sync that was already awaiting getLocalAgentIntegration() or
    // channelPlugin.start() could still call
    // connectLocalAgentIntegration({ enabled: true }) AFTER the disable
    // path had cleared the OpenClaw record — silently re-enabling it.
    let resolveLoad: ((value: null) => void) | undefined;
    const client = {
      getLocalAgentIntegration: vi.fn(() => new Promise<null>((resolve) => { resolveLoad = resolve; })),
      connectLocalAgentIntegration: vi.fn(),
    };
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true, port: 0 },
      memory: { enabled: false },
    } as any);
    const api: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    (plugin as any).client = client;
    (plugin as any).channelPlugin = {
      isUsingGatewayRoute: false,
      isListening: true,
      bridgePort: 0,
      start: vi.fn(async () => {}),
      setClient: vi.fn(),
    };

    const sync = (plugin as any).syncLocalAgentIntegrationState(api, 'full');
    expect(client.getLocalAgentIntegration).toHaveBeenCalledWith('openclaw');

    // Flip channel.enabled to false WITHOUT bumping daemonClientGeneration —
    // simulates the operator/config path disabling channel mid-sync.
    (plugin as any).config = {
      ...(plugin as any).config,
      channel: { enabled: false, port: 0 },
    };

    resolveLoad?.(null);
    await sync;

    expect(client.connectLocalAgentIntegration).not.toHaveBeenCalled();
  });


  it('T364 round 13 — disable HTTP write resolves AFTER an enable HTTP write, but the daemon ends up disabled because the disable runs serialized AFTER the enable and re-checks channel state', async () => {
    // Round 6 closed the channel-disable race for the await yields BEFORE
    // the HTTP write. Round 13 closes the second-order race: the HTTP
    // writes themselves were independent. An older
    // `connectLocalAgentIntegration({ enabled: true })` in flight at the
    // time of disable could resolve AFTER the disable's HTTP write,
    // leaving the daemon record at `enabled: true` even though the
    // channel was already off. Post-fix the writes are serialized onto
    // a single chain and each step re-checks channel state, so the
    // latest config wins regardless of network ordering.
    let resolveConnect: (() => void) | undefined;
    let resolveDisable: (() => void) | undefined;
    const connectCalls: any[] = [];
    const disableCalls: any[] = [];
    const client = {
      getLocalAgentIntegration: vi.fn(async () => ({ enabled: true, transport: { kind: 'openclaw-channel' } })),
      connectLocalAgentIntegration: vi.fn((payload: any) => new Promise<void>((resolve) => {
        connectCalls.push(payload);
        resolveConnect = resolve;
      })),
      updateLocalAgentIntegration: vi.fn((id: string, payload: any) => new Promise<void>((resolve) => {
        disableCalls.push({ id, payload });
        resolveDisable = resolve;
      })),
    };
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true, port: 0 },
      memory: { enabled: false },
    } as any);
    const api: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    (plugin as any).client = client;
    (plugin as any).channelPlugin = {
      isUsingGatewayRoute: false,
      isListening: true,
      bridgePort: 0,
      start: vi.fn(async () => {}),
      setClient: vi.fn(),
    };

    // Step 1: kick off an enable sync. It will reach the
    // connectLocalAgentIntegration HTTP write (serialized) and pause
    // because we don't resolveConnect() yet.
    const syncPromise = (plugin as any).syncLocalAgentIntegrationState(api, 'full');
    // Drain microtasks so the serialized work can reach the HTTP call.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(client.connectLocalAgentIntegration).toHaveBeenCalledTimes(1);

    // Step 2: flip channel.enabled to false and fire the disable
    // path. Without serialization, this would race the in-flight
    // connect. With serialization, it queues behind the connect.
    (plugin as any).config = {
      ...(plugin as any).config,
      channel: { enabled: false, port: 0 },
    };
    (plugin as any).clearLocalAgentChannelIntegration(api, 'full');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Disable HTTP write must NOT have fired yet — it's queued
    // behind the in-flight connect.
    expect(client.updateLocalAgentIntegration).not.toHaveBeenCalled();

    // Step 3: resolve the in-flight connect. The serialized chain
    // now picks up the disable, which re-checks channel state
    // (false) and proceeds with the disable HTTP write.
    resolveConnect?.();
    await syncPromise;
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // The disable load probe should have fired (loadStoredOpenClawIntegration).
    expect(client.getLocalAgentIntegration).toHaveBeenCalled();
    // After the load resolves, the disable HTTP write fires.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(client.updateLocalAgentIntegration).toHaveBeenCalledTimes(1);
    expect(disableCalls[0].payload.enabled).toBe(false);

    resolveDisable?.();
    await Promise.resolve();
  });


  it('T364 round 6 — aborts in-flight local-agent sync when channel.enabled flips during channelPlugin.start() await', async () => {
    // Companion to the get-load-await test: covers the SECOND yield
    // window in syncLocalAgentIntegrationState. After the load
    // resolves, `await channelPlugin.start()` is the next yield;
    // a config flip during that window must also abort before
    // `connectLocalAgentIntegration({ enabled: true })` fires.
    let resolveStart: (() => void) | undefined;
    const client = {
      getLocalAgentIntegration: vi.fn(async () => null),
      connectLocalAgentIntegration: vi.fn(),
    };
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true, port: 0 },
      memory: { enabled: false },
    } as any);
    const api: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    (plugin as any).client = client;
    (plugin as any).channelPlugin = {
      isUsingGatewayRoute: false,
      isListening: true,
      bridgePort: 0,
      start: vi.fn(() => new Promise<void>((resolve) => { resolveStart = resolve; })),
      setClient: vi.fn(),
    };

    const sync = (plugin as any).syncLocalAgentIntegrationState(api, 'full');
    // Let the microtask chain drain past `getLocalAgentIntegration` and
    // into `channelPlugin.start()` so we are blocked on `resolveStart`.
    await Promise.resolve();
    await Promise.resolve();

    // Flip channel.enabled to false WITHOUT bumping daemonClientGeneration —
    // simulates a config update arriving while channelPlugin.start() is
    // still pending.
    (plugin as any).config = {
      ...(plugin as any).config,
      channel: { enabled: false, port: 0 },
    };

    resolveStart?.();
    await sync;

    expect(client.connectLocalAgentIntegration).not.toHaveBeenCalled();
  });


  it('drops stale local-agent sync work after daemon client refresh', async () => {
    vi.useFakeTimers();
    let resolveLoad: ((value: null) => void) | undefined;
    const oldClient = {
      getLocalAgentIntegration: vi.fn(() => new Promise<null>((resolve) => { resolveLoad = resolve; })),
      connectLocalAgentIntegration: vi.fn(),
    };
    const newClient = {
      getLocalAgentIntegration: vi.fn(),
      connectLocalAgentIntegration: vi.fn(),
    };
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true, port: 0 },
      memory: { enabled: false },
    } as any);
    const api: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    try {
      (plugin as any).client = oldClient;
      (plugin as any).channelPlugin = {
        isUsingGatewayRoute: false,
        isListening: true,
        bridgePort: 0,
        start: vi.fn(async () => {}),
        setClient: vi.fn(),
      };

      const sync = (plugin as any).syncLocalAgentIntegrationState(api, 'full');
      expect(oldClient.getLocalAgentIntegration).toHaveBeenCalledWith('openclaw');
      (plugin as any).scheduleLocalAgentIntegrationRetry(api, 'full');
      expect((plugin as any).localAgentIntegrationRetryTimer).not.toBeNull();

      (plugin as any).daemonClientGeneration += 1;
      (plugin as any).client = newClient;
      (plugin as any).resetDaemonScopedCachesForClientChange();
      expect((plugin as any).localAgentIntegrationRetryTimer).toBeNull();

      resolveLoad?.(null);
      await sync;

      expect(oldClient.connectLocalAgentIntegration).not.toHaveBeenCalled();
      expect(newClient.connectLocalAgentIntegration).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
