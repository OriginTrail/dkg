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

describe('DkgNodePlugin', () => {
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

  it('updates gateway status when refreshed config disables the channel module', async () => {
    const registerSpy = vi.spyOn(DkgChannelPlugin.prototype, 'register').mockImplementation(() => {});
    const stopSpy = vi.spyOn(DkgChannelPlugin.prototype, 'stop').mockResolvedValue(undefined);
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
      plugin.updateConfig({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      });
      (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });

      expect(stopSpy).toHaveBeenCalledWith({ updateGatewayStatus: true });
      await (plugin as any).channelPluginStopInFlight;
      expect((plugin as any).channelPlugin).toBeNull();
      expect(registerSpy).toHaveBeenCalledTimes(1);
    } finally {
      registerSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });

  it('clears a registered memory capability when refreshed config disables memory', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    (plugin as any).client = {};
    (plugin as any).refreshMemoryResolverState = vi.fn(() => Promise.resolve());
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

    (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });
    const activeCapability = registerMemoryCapability.mock.calls[0][0];
    const oldMemoryPlugin = (plugin as any).memoryPlugin;

    plugin.updateConfig({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: false },
      channel: { enabled: false },
    });
    (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });

    expect(registerMemoryCapability).toHaveBeenCalledTimes(2);
    const disabledCapability = registerMemoryCapability.mock.calls[1][0];
    expect(disabledCapability).not.toBe(activeCapability);
    expect(disabledCapability.promptBuilder?.({ availableTools: new Set(), citationsMode: undefined })).toEqual([]);
    const result = await disabledCapability.runtime.getMemorySearchManager({});
    expect(result.manager).toBeNull();
    expect(result.error).toContain('disabled');
    expect((plugin as any).memoryPlugin).toBeNull();
    expect((plugin as any).memoryResolverApi).toBeNull();

    oldMemoryPlugin.reAssertCapability();
    expect(registerMemoryCapability).toHaveBeenCalledTimes(2);
    expect(oldMemoryPlugin.isRegistered()).toBe(false);
  });

  it('rebuilds a registered memory capability when updateConfig refreshes the daemon client', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    (plugin as any).refreshMemoryResolverState = vi.fn(() => Promise.resolve());
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

    (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });
    const initialCapability = registerMemoryCapability.mock.calls[0][0];
    (plugin as any).initialized = true;

    plugin.updateConfig({
      daemonUrl: 'http://localhost:9300',
      memory: { enabled: true },
      channel: { enabled: false },
    });

    expect(registerMemoryCapability).toHaveBeenCalledTimes(2);
    expect(registerMemoryCapability.mock.calls[1][0]).not.toBe(initialCapability);
  });

  it('clears previous memory registry without stamping a stale registered api when ownership is unknown', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    (plugin as any).client = {};
    (plugin as any).refreshMemoryResolverState = vi.fn(() => Promise.resolve());
    const initialRegisterMemoryCapability = vi.fn();
    const currentRegisterMemoryCapability = vi.fn();
    const initialApi = {
      config: {
        plugins: {
          slots: {
            memory: 'adapter-openclaw',
          },
        },
      },
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: initialRegisterMemoryCapability,
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;
    const currentDirectApi = {
      config: {
        memory: { enabled: false },
      },
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: currentRegisterMemoryCapability,
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    (plugin as any).registerIntegrationModules(initialApi, { enableFullRuntime: true });
    expect(initialRegisterMemoryCapability).toHaveBeenCalledTimes(1);
    const oldMemoryPlugin = (plugin as any).memoryPlugin;

    plugin.updateConfig({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: false },
      channel: { enabled: false },
    });
    (plugin as any).registerIntegrationModules(currentDirectApi, { enableFullRuntime: true });

    // T364 — Pre-fix this test asserted `currentRegisterMemoryCapability`
    // NOT to be called when the prior registration was merged-config. That
    // was the bug Codex flagged: the user explicitly disabling memory in
    // direct config saw local bookkeeping cleared but the gateway slot
    // kept the stale DKG capability live. Post-fix, the disabled capability
    // is stamped on the CURRENT api (`currentDirectApi`, NOT the stale
    // `initialApi`) so the gateway slot stops routing memory through DKG.
    expect(currentRegisterMemoryCapability).toHaveBeenCalledTimes(1);
    expect(initialRegisterMemoryCapability).toHaveBeenCalledTimes(1);
    expect((plugin as any).memoryPlugin).toBeNull();
    expect((plugin as any).memoryResolverApi).toBeNull();
    oldMemoryPlugin.reAssertCapability();
    expect(initialRegisterMemoryCapability).toHaveBeenCalledTimes(1);
    expect(currentRegisterMemoryCapability).toHaveBeenCalledTimes(1);
    expect(oldMemoryPlugin.isRegistered()).toBe(false);
  });

  it('does not clear another plugin memory slot when refreshed config disables memory', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    (plugin as any).client = {};
    (plugin as any).refreshMemoryResolverState = vi.fn(() => Promise.resolve());
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

    (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });
    const oldMemoryPlugin = (plugin as any).memoryPlugin;

    (mockApi.config as any).plugins.slots.memory = 'some-other-memory-plugin';
    (plugin as any).initialized = true;
    plugin.updateConfig({
      daemonUrl: 'http://localhost:9300',
      memory: { enabled: false },
      channel: { enabled: false },
    });
    (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });

    expect(registerMemoryCapability).toHaveBeenCalledTimes(1);
    expect((plugin as any).memoryPlugin).toBeNull();
    expect((plugin as any).memoryResolverApi).toBeNull();
    expect(oldMemoryPlugin.isRegistered()).toBe(false);
    oldMemoryPlugin.reAssertCapability();
    expect(registerMemoryCapability).toHaveBeenCalledTimes(1);
  });

  it('registers session_end hook and all exported tools via register()', () => {
    const plugin = new DkgNodePlugin();
    const registeredHooks: Array<{ event: string; name?: string }> = [];
    const registeredTools: OpenClawTool[] = [];

    const mockApi: OpenClawPluginApi = {
      config: {},
      registerTool: (tool) => registeredTools.push(tool),
      registerHook: (event, _handler, opts) => registeredHooks.push({ event, name: opts?.name }),
      on: () => {},
      logger: {},
    };

    plugin.register(mockApi);

    // T7 — `session_end` is now routed through `HookSurface.install('legacy', ...)`
    // which uses the canonical `dkg-${event}` naming convention.
    expect(registeredHooks).toContainEqual({ event: 'session_end', name: 'dkg-session_end' });

    const toolNames = registeredTools.map(t => t.name);
    // Existing active tools
    expect(toolNames).toContain('dkg_status');
    expect(toolNames).toContain('dkg_wallet_balances');
    expect(toolNames).toContain('dkg_list_context_graphs');
    expect(toolNames).toContain('dkg_context_graph_create');
    expect(toolNames).toContain('dkg_context_graph_invite');
    expect(toolNames).toContain('dkg_participant_add');
    expect(toolNames).toContain('dkg_participant_remove');
    expect(toolNames).toContain('dkg_participant_list');
    expect(toolNames).toContain('dkg_join_request_list');
    expect(toolNames).toContain('dkg_join_request_approve');
    expect(toolNames).toContain('dkg_join_request_reject');
    expect(toolNames).toContain('dkg_subscribe');
    expect(toolNames).toContain('dkg_publish');
    expect(toolNames).toContain('dkg_query');
    expect(toolNames).toContain('dkg_find_agents');
    expect(toolNames).toContain('dkg_send_message');
    expect(toolNames).toContain('dkg_read_messages');
    expect(toolNames).toContain('dkg_invoke_skill');
    // 10 new tools from PR #254 (assertion lifecycle + sub-graph management + SWM→VM publish)
    expect(toolNames).toContain('dkg_assertion_create');
    expect(toolNames).toContain('dkg_assertion_write');
    expect(toolNames).toContain('dkg_assertion_promote');
    expect(toolNames).toContain('dkg_assertion_discard');
    expect(toolNames).toContain('dkg_assertion_import_file');
    expect(toolNames).toContain('dkg_assertion_query');
    expect(toolNames).toContain('dkg_assertion_history');
    expect(toolNames).toContain('dkg_sub_graph_create');
    expect(toolNames).toContain('dkg_sub_graph_list');
    expect(toolNames).toContain('dkg_shared_memory_publish');
    // dkg_share — direct SWM convenience helper, parity with Hermes (#382, #408).
    expect(toolNames).toContain('dkg_share');
    // Legacy V9 paranet aliases are removed as of v10-rc.
    expect(toolNames).not.toContain('dkg_list_paranets');
    expect(toolNames).not.toContain('dkg_paranet_create');
    // memory_search added by this feature branch (W2 — agent-callable recall button).
    expect(toolNames).toContain('memory_search');
    // Keep this resilient as main adds new exported tools; this test already
    // asserts presence of the critical tool set above.
    expect(registeredTools.length).toBeGreaterThanOrEqual(29);
  });

  it('new dkg_assertion_* and dkg_sub_graph_* tools have the expected schema shape', () => {
    const plugin = new DkgNodePlugin();
    const registeredTools: OpenClawTool[] = [];

    const mockApi: OpenClawPluginApi = {
      config: {},
      registerTool: (tool) => registeredTools.push(tool),
      registerHook: () => {},
      on: () => {},
      logger: {},
    };

    plugin.register(mockApi);

    const byName = new Map(registeredTools.map(t => [t.name, t] as const));

    const expectRequired = (name: string, required: string[]) => {
      const tool = byName.get(name);
      expect(tool, `${name} should be registered`).toBeTruthy();
      const props = tool!.parameters.properties;
      for (const key of required) {
        expect(props, `${name}.${key} should be declared in parameters.properties`).toHaveProperty(key);
      }
      expect(tool!.parameters.required).toEqual(expect.arrayContaining(required));
    };

    expectRequired('dkg_assertion_create', ['context_graph_id', 'name']);
    expectRequired('dkg_context_graph_invite', ['context_graph_id', 'peer_id']);
    expectRequired('dkg_participant_add', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_participant_remove', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_participant_list', ['context_graph_id']);
    expectRequired('dkg_join_request_list', ['context_graph_id']);
    expectRequired('dkg_join_request_approve', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_join_request_reject', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_assertion_write', ['context_graph_id', 'name', 'quads']);
    expectRequired('dkg_assertion_promote', ['context_graph_id', 'name']);
    expectRequired('dkg_assertion_discard', ['context_graph_id', 'name']);
    expectRequired('dkg_assertion_import_file', ['context_graph_id', 'name', 'file_path']);
    expectRequired('dkg_assertion_query', ['context_graph_id', 'name']);
    expectRequired('dkg_assertion_history', ['context_graph_id', 'name']);
    expectRequired('dkg_sub_graph_create', ['context_graph_id', 'sub_graph_name']);
    expectRequired('dkg_sub_graph_list', ['context_graph_id']);
    expectRequired('dkg_shared_memory_publish', ['context_graph_id']);

    // dkg_shared_memory_publish must declare `sub_graph_name` so agents that
    // create/write/promote into a sub-graph can publish the promoted data
    // through the same sub-graph instead of hitting the root SWM graph.
    const publishProps = byName.get('dkg_shared_memory_publish')!.parameters.properties;
    expect(publishProps).toHaveProperty('sub_graph_name');
    expect(publishProps.sub_graph_name.type).toBe('string');
    expect(publishProps).toHaveProperty('register_if_needed');
    expect(publishProps.register_if_needed.type).toBe('boolean');
    expect(publishProps).toHaveProperty('reveal_on_chain');
    expect(publishProps.reveal_on_chain.type).toBe('boolean');
    expect(publishProps).toHaveProperty('access_policy');
    expect(publishProps.access_policy.type).toBe('number');

    // dkg_assertion_write.quads is an array of {subject,predicate,object}
    const writeTool = byName.get('dkg_assertion_write')!;
    expect(writeTool.parameters.properties.quads.type).toBe('array');
    expect(writeTool.parameters.properties.quads.items).toBeDefined();

    // dkg_subscribe: `include_shared_memory` is boolean-only (subscribe is a
    // catch-up/sync flag, not a memory-layer selector).
    const subSchema = byName.get('dkg_subscribe')!.parameters.properties.include_shared_memory.type;
    expect(subSchema).toBe('boolean');

    // dkg_query: `view` is a plain string — validation lives in the
    // handler, not as a JSON-schema enum. Rationale: strict-schema
    // hosts would otherwise reject typos at the boundary before the
    // handler can surface the valid-list error. Description
    // enumerates accepted values for discoverability; handler
    // enforces them.
    //
    // WM reads are supported: the handler defaults `agent_address` to
    // this node's peerId (matches the memory plugin's default from
    // `memorySessionResolver.getDefaultAgentAddress`). Callers in
    // multi-agent deployments can override with an explicit
    // `agent_address`.
    //
    // The legacy `include_shared_memory` boolean is removed — there
    // is no exact replacement because the old `true` path queried
    // the data graph ∪ SWM (union), which no single `view` reproduces.
    const queryProps = byName.get('dkg_query')!.parameters.properties;
    expect(queryProps).not.toHaveProperty('include_shared_memory');
    expect(queryProps.view.type).toBe('string');
    expect(queryProps.view).not.toHaveProperty('enum');
    // Description advertises all three layers.
    expect(queryProps.view.description).toContain('working-memory');
    expect(queryProps.view.description).toContain('shared-working-memory');
    expect(queryProps.view.description).toContain('verified-memory');
    // agent_address is exposed as an optional tool param for WM targeting.
    expect(queryProps.agent_address.type).toBe('string');
    expect(queryProps.agent_address.description).toMatch(/working-memory/i);

    const inviteTool = byName.get('dkg_context_graph_invite')!;
    expect(inviteTool.description).toMatch(/primary user-facing deliverable/i);
    expect(inviteTool.description).toMatch(/paste into Join/i);

    const addParticipantTool = byName.get('dkg_participant_add')!;
    expect(addParticipantTool.description).toMatch(/allowlisting alone is not the full UI join flow/i);
  });

  // ---------------------------------------------------------------------------
  // Handler-level parameter drift guards: for each new tool, invoke
  // `tool.execute(snakeCaseArgs)` with a mocked fetch and assert the daemon
  // receives the exact camelCase body / query-string keys the route handlers
  // in packages/cli/src/daemon.ts destructure. This catches
  // snake_case → camelCase drift at the handler boundary — the same class of
  // bug that cost PR A multiple review rounds.
  // ---------------------------------------------------------------------------

  describe('handler-level drift guards: snake_case args → camelCase daemon body', () => {
    const setupPluginWithFetch = (
      response: unknown = {},
      opts: { skipNodeIdInjection?: boolean } = {},
    ) => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      // Most handler tests assume the node identity has resolved (e.g. dkg_share
      // builds canned-quad subjects from it). Inject a placeholder address so
      // tests don't have to mock the daemon /api/status probe end-to-end. Pass
      // `skipNodeIdInjection: true` to exercise the unresolved-identity branch.
      if (!opts.skipNodeIdInjection) {
        (plugin as any).nodePeerId = '12D3KooTestPeerId';
      }
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      return { fetchMock, plugin, byName };
    };

    const originalFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('dkg_assertion_create forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      await byName.get('dkg_assertion_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'chat-turns',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/create');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        name: 'chat-turns',
        subGraphName: 'protocols',
      });
    });

    it('dkg_context_graph_invite forwards snake_case → camelCase body', async () => {
      const statusResponse = {
        peerId: '12D3Kooself',
        multiaddrs: [
          '/ip4/127.0.0.1/tcp/9201/p2p/12D3Kooself',
          '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSrelay/p2p-circuit/p2p/12D3Kooself',
        ],
      };
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'http://localhost:9200/api/status') {
          return new Response(JSON.stringify(statusResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ invited: '12D3KooWfriend', contextGraphId: 'ctx' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      const result = await byName.get('dkg_context_graph_invite')!.execute('tc', {
        context_graph_id: 'ctx',
        peer_id: '12D3KooWfriend',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/invite');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        peerId: '12D3KooWfriend',
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.peerId).toBe('12D3KooWfriend');
      expect(body.curatorMultiaddr).toBe('/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSrelay/p2p-circuit/p2p/12D3Kooself');
      expect(body.inviteCode).toBe('ctx\n/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSrelay/p2p-circuit/p2p/12D3Kooself');
    });

    it('dkg_participant_add forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, contextGraphId: 'ctx', agentAddress: '0xabc' });
      await byName.get('dkg_participant_add')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/add-participant');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });

    it('dkg_participant_remove forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, contextGraphId: 'ctx', agentAddress: '0xabc' });
      await byName.get('dkg_participant_remove')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/remove-participant');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });

    it('dkg_participant_list forwards the context-graph path', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ contextGraphId: 'ctx', allowedAgents: ['0xabc'] });
      await byName.get('dkg_participant_list')!.execute('tc', {
        context_graph_id: 'ctx',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/participants');
      expect(init.method).toBe('GET');
    });

    it('dkg_join_request_list forwards the context-graph path', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ contextGraphId: 'ctx', requests: [] });
      await byName.get('dkg_join_request_list')!.execute('tc', {
        context_graph_id: 'ctx',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/join-requests');
      expect(init.method).toBe('GET');
    });

    it('dkg_join_request_approve forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, status: 'approved', agentAddress: '0xabc' });
      await byName.get('dkg_join_request_approve')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/approve-join');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });

    it('dkg_join_request_reject forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, status: 'rejected', agentAddress: '0xabc' });
      await byName.get('dkg_join_request_reject')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/reject-join');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });

    it('dkg_assertion_write forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ written: 1 });
      await byName.get('dkg_assertion_write')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        quads: [{ subject: 'urn:a', predicate: 'urn:b', object: 'urn:c' }],
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/notes/write');
      const body = JSON.parse(init.body as string);
      expect(body.contextGraphId).toBe('ctx');
      expect(body.subGraphName).toBe('protocols');
      expect(body.quads).toHaveLength(1);
    });

    it('dkg_assertion_promote forwards snake_case → camelCase body and rejects stray string "all"', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: 1 });
      await byName.get('dkg_assertion_promote')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        entities: ['urn:root-1', 'urn:root-2'],
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/notes/promote');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        entities: ['urn:root-1', 'urn:root-2'],
        subGraphName: 'protocols',
      });

      // Blocker guard: the previous string-"all" shortcut is gone from the public
      // tool surface. The handler now returns an error result instead of sending.
      fetchMock.mockClear();
      const bad = await byName.get('dkg_assertion_promote')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        entities: 'all',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(bad.content[0].text).toContain('entities');
      expect(bad.content[0].text).toContain('non-empty array');
    });

    it('dkg_assertion_promote omits entities when not supplied (daemon default kicks in)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: 1 });
      await byName.get('dkg_assertion_promote')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.contextGraphId).toBe('ctx');
      expect(body.entities).toBeUndefined();
    });

    it('dkg_assertion_discard forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ discarded: true });
      await byName.get('dkg_assertion_discard')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'draft',
        sub_graph_name: 'scratch',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/draft/discard');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        subGraphName: 'scratch',
      });
    });

    it('dkg_assertion_query forwards snake_case → camelCase body (no sparql)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ quads: [], count: 0 });
      await byName.get('dkg_assertion_query')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/notes/query');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ contextGraphId: 'ctx', subGraphName: 'protocols' });
      expect(body).not.toHaveProperty('sparql');
    });

    it('dkg_assertion_history forwards snake_case → camelCase query params (GET, no body)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ createdAt: 't' });
      await byName.get('dkg_assertion_history')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        agent_address: '0xabc',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/assertion/notes/history');
      expect(parsed.searchParams.get('contextGraphId')).toBe('ctx');
      expect(parsed.searchParams.get('agentAddress')).toBe('0xabc');
      expect(parsed.searchParams.get('subGraphName')).toBe('protocols');
      expect(init.body).toBeUndefined();
    });

    it('dkg_assertion_import_file reads the file and forwards camelCase multipart fields (.md → text/markdown)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const tmpDir = mkdtempSync(join(tmpdir(), 'dkg-test-'));
      const filePath = join(tmpDir, 'doc.md');
      writeFileSync(filePath, '# Hello\n');

      await byName.get('dkg_assertion_import_file')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        file_path: filePath,
        ontology_ref: 'urn:onto',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/notes/import-file');
      expect(init.method).toBe('POST');
      const form = init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('contextGraphId')).toBe('ctx');
      // content_type was omitted but file has .md extension — handler should infer text/markdown
      expect(form.get('contentType')).toBe('text/markdown');
      expect(form.get('ontologyRef')).toBe('urn:onto');
      expect(form.get('subGraphName')).toBe('protocols');
      expect((form.get('file') as File).name).toBe('doc.md');
    });

    it('dkg_assertion_import_file infers content-type for common formats (kept in sync with CLI UPLOAD_CONTENT_TYPES)', async () => {
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const cases: Array<[string, string]> = [
        ['doc.pdf', 'application/pdf'],
        ['doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
        ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        ['page.html', 'text/html'],
        ['page.htm', 'text/html'],
        ['feed.xml', 'application/xml'],
        ['book.epub', 'application/epub+zip'],
        ['notes.txt', 'text/plain'],
        ['data.csv', 'text/csv'],
        ['config.json', 'application/json'],
      ];

      for (const [fileName, expectedMime] of cases) {
        const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
        const tmpDir = mkdtempSync(join(tmpdir(), 'dkg-mime-'));
        const filePath = join(tmpDir, fileName);
        writeFileSync(filePath, 'dummy');
        await byName.get('dkg_assertion_import_file')!.execute('tc', {
          context_graph_id: 'ctx',
          name: 'notes',
          file_path: filePath,
        });
        const form = fetchMock.mock.calls[0][1]?.body as FormData;
        expect(form.get('contentType'), `${fileName} should infer ${expectedMime}`).toBe(expectedMime);
      }
    });

    it('dkg_assertion_import_file falls through to octet-stream for unknown extensions (no contentType form field)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const tmpDir = mkdtempSync(join(tmpdir(), 'dkg-unknown-'));
      const filePath = join(tmpDir, 'blob.xyz');
      writeFileSync(filePath, 'dummy');
      await byName.get('dkg_assertion_import_file')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        file_path: filePath,
      });
      const form = fetchMock.mock.calls[0][1]?.body as FormData;
      // Handler left contentType undefined → client does NOT append the form field,
      // daemon falls through to the Blob's default 'application/octet-stream' type.
      expect(form.has('contentType')).toBe(false);
    });

    it('dkg_sub_graph_create forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ created: 'protocols', contextGraphId: 'ctx' });
      await byName.get('dkg_sub_graph_create')!.execute('tc', {
        context_graph_id: 'ctx',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/sub-graph/create');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        subGraphName: 'protocols',
      });
    });

    it('dkg_sub_graph_list forwards snake_case → camelCase query param (GET, no body)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ contextGraphId: 'ctx', subGraphs: [] });
      await byName.get('dkg_sub_graph_list')!.execute('tc', { context_graph_id: 'ctx' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/sub-graph/list');
      expect(parsed.searchParams.get('contextGraphId')).toBe('ctx');
      expect(init.body).toBeUndefined();
    });

    it('dkg_shared_memory_publish forwards snake_case → camelCase body with selection="all" when omitted', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ kcId: 'kc-1', status: 'ok', kas: [] });
      await byName.get('dkg_shared_memory_publish')!.execute('tc', { context_graph_id: 'ctx' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/shared-memory/publish');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ contextGraphId: 'ctx', selection: 'all', clearAfter: true });
    });

    it('dkg_shared_memory_publish forwards explicit root_entities as selection array with clearAfter=false (subset safety default)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ kcId: 'kc-2', status: 'ok', kas: [] });
      await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        root_entities: ['urn:a', 'urn:b'],
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      // Subset publishes default to clearAfter=false so roots NOT in `selection`
      // aren't clobbered as a side-effect of publishing a subset.
      expect(body).toEqual({ contextGraphId: 'ctx', selection: ['urn:a', 'urn:b'], clearAfter: false });
    });

    it('dkg_shared_memory_publish plumbs sub_graph_name through to subGraphName for sub-graph-scoped publishes', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ kcId: 'kc-5', status: 'ok', kas: [] });
      await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        sub_graph_name: 'protocols',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      // Without this, an agent that created/wrote/promoted into a sub-graph
      // would publish to the root shared-memory graph instead of the sub-graph.
      expect(body.subGraphName).toBe('protocols');
      expect(body.contextGraphId).toBe('ctx');
    });

    it('dkg_shared_memory_publish can register the context graph before publish when requested', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'http://localhost:9200/api/context-graph/register') {
          return new Response(JSON.stringify({ registered: 'ctx', onChainId: '42', txHash: '0xabc' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ kcId: 'kc-7', status: 'ok', kas: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));

      const result = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        register_if_needed: true,
        reveal_on_chain: true,
        access_policy: 1,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:9200/api/context-graph/register');
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
        id: 'ctx',
        accessPolicy: 1,
      });
      expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:9200/api/shared-memory/publish');
      const body = JSON.parse(result.content[0].text);
      expect(body.registration).toEqual({ registered: 'ctx', onChainId: '42', txHash: '0xabc' });
      expect(body.kcId).toBe('kc-7');
    });

    it('dkg_shared_memory_publish ignores already-registered conflicts and still publishes', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'http://localhost:9200/api/context-graph/register') {
          return new Response(JSON.stringify({ error: 'Context graph "ctx" is already registered on-chain (42)' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ kcId: 'kc-8', status: 'ok', kas: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));

      const result = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        register_if_needed: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body = JSON.parse(result.content[0].text);
      expect(body.registration).toBeUndefined();
      expect(body.kcId).toBe('kc-8');
    });

    it('dkg_shared_memory_publish validates register_if_needed and registration options locally', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const bad = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        register_if_needed: 'yes',
        reveal_on_chain: 'yes',
        access_policy: 3,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(bad.content[0].text).toContain('register_if_needed');

      const badReveal = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        reveal_on_chain: 'yes',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(badReveal.content[0].text).toContain('reveal_on_chain');
    });

    it('dkg_shared_memory_publish rejects non-array / empty / non-string root_entities locally', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const bad = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        root_entities: 'all', // Agents must send an array, never a bare string.
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(bad.content[0].text).toContain('root_entities');
      expect(bad.content[0].text).toContain('non-empty array');
    });

    it('dkg_share is registered with required content and context_graph_id', () => {
      const { byName } = setupPluginWithFetch({});
      const tool = byName.get('dkg_share');
      expect(tool).toBeDefined();
      expect(tool!.parameters.required).toEqual(['content', 'context_graph_id']);
      const props = tool!.parameters.properties;
      expect(props.content?.type).toBe('string');
      expect(props.context_graph_id?.type).toBe('string');
      expect(props.sub_graph_name?.type).toBe('string');
    });

    it('dkg_share rejects non-string content/context_graph_id/sub_graph_name without coercing', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-types' });
      // Without explicit type checks, `String(args.content ?? '')` would coerce
      // {} → "[object Object]" and false → "false" — silently polluting SWM
      // with garbage. Validate at the runtime boundary instead.
      const objContent = await byName.get('dkg_share')!.execute('tc', { content: {}, context_graph_id: 'ctx' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(objContent.content[0].text).toContain('content');

      const boolContent = await byName.get('dkg_share')!.execute('tc', { content: false, context_graph_id: 'ctx' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(boolContent.content[0].text).toContain('content');

      const objCg = await byName.get('dkg_share')!.execute('tc', { content: 'x', context_graph_id: { id: 'ctx' } });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(objCg.content[0].text).toContain('context_graph_id');

      const numSub = await byName.get('dkg_share')!.execute('tc', {
        content: 'x', context_graph_id: 'ctx', sub_graph_name: 42,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(numSub.content[0].text).toContain('sub_graph_name');
    });

    it('dkg_share rejects missing/empty content without making a daemon call', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-1' });
      const result = await byName.get('dkg_share')!.execute('tc', { context_graph_id: 'ctx' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('content');

      const blank = await byName.get('dkg_share')!.execute('tc', { content: '   ', context_graph_id: 'ctx' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(blank.content[0].text).toContain('content');
    });

    it('dkg_share rejects missing/empty context_graph_id without making a daemon call', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-2' });
      const result = await byName.get('dkg_share')!.execute('tc', { content: 'fact' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('context_graph_id');
    });

    it('dkg_share forwards content as a canned quad to /api/shared-memory/write with localOnly=false', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-3' });
      await byName.get('dkg_share')!.execute('tc', {
        content: 'hello',
        context_graph_id: 'ctx',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/shared-memory/write');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.contextGraphId).toBe('ctx');
      expect(body.localOnly).toBe(false);
      expect(body.subGraphName).toBeUndefined();
      expect(body.quads).toHaveLength(1);
      const [quad] = body.quads;
      // Subject ends with a unique shareId suffix so the publisher's
      // delete-then-insert upsert doesn't replace prior shares.
      expect(quad.subject).toMatch(/^urn:openclaw:.+:shared:\d+-[a-z0-9]+$/);
      expect(quad.predicate).toBe('urn:openclaw:sharedContent');
      // Object is N-Triples-quoted so the storage formatTerm doesn't
      // IRI-encode the unquoted text.
      expect(quad.object).toBe('"hello"');
    });

    it('dkg_share returns the minted subject and snake_case root_entities in the tool response', async () => {
      // Field name is snake_case to match the consuming tool's argument
      // shape — agents chaining dkg_share → dkg_shared_memory_publish
      // ({ root_entities: ... }) can pass the value through unchanged.
      const { byName } = setupPluginWithFetch({ shareOperationId: 'op-resp' });
      const result = await byName.get('dkg_share')!.execute('tc', {
        content: 'targetable',
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.shareOperationId).toBe('op-resp');
      expect(body.subject).toMatch(/^urn:openclaw:.+:shared:\d+-[a-z0-9]+$/);
      expect(body.root_entities).toEqual([body.subject]);
      expect(body.rootEntities).toBeUndefined();
    });

    it('dkg_share mints a unique subject per call so successive shares do not upsert', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-multi' });
      await byName.get('dkg_share')!.execute('tc', { content: 'one', context_graph_id: 'ctx' });
      await byName.get('dkg_share')!.execute('tc', { content: 'two', context_graph_id: 'ctx' });
      const subjA = JSON.parse(fetchMock.mock.calls[0][1]?.body as string).quads[0].subject;
      const subjB = JSON.parse(fetchMock.mock.calls[1][1]?.body as string).quads[0].subject;
      expect(subjA).not.toBe(subjB);
      expect(subjA).toMatch(/^urn:openclaw:.+:shared:\d+-[a-z0-9]+$/);
      expect(subjB).toMatch(/^urn:openclaw:.+:shared:\d+-[a-z0-9]+$/);
    });

    it('dkg_share escapes the full N-Triples control-char set when building the literal', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-escape' });
      // Cover \\, ", \n, \r, \t, \f, \b — the canonical escaper from
      // @origintrail-official/dkg-core handles all seven.
      await byName.get('dkg_share')!.execute('tc', {
        content: 'a\nb\rc\td\fe\bf "q" \\ end',
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.quads[0].object).toBe('"a\\nb\\rc\\td\\fe\\bf \\"q\\" \\\\ end"');
    });

    it('dkg_share preserves leading/trailing whitespace in content (no silent trim)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-ws' });
      // Agents sharing code snippets or exact transcripts must get byte-for-byte
      // round-tripping. Trimming for serialization would silently drop terminal
      // newlines and indentation. Validation still rejects whitespace-only.
      await byName.get('dkg_share')!.execute('tc', {
        content: '  function f() {\n  return 1;\n}\n',
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      // Quoted, with the leading two spaces, embedded newlines, and trailing newline preserved.
      expect(body.quads[0].object).toBe('"  function f() {\\n  return 1;\\n}\\n"');

      const blank = await byName.get('dkg_share')!.execute('tc', {
        content: '   \n   ',
        context_graph_id: 'ctx',
      });
      expect(blank.content[0].text).toContain('content');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('dkg_share falls back to direct /api/agent/identity probe when the memory resolver is disabled', async () => {
      // With `memory.enabled: false` the memory resolver API never registers,
      // so ensureNodeAgentAddress/ensureNodePeerId both no-op (memoryResolverApi
      // stays null). dkg_share writes to /api/shared-memory/write directly and
      // must not go dark in that config — fall through to a direct daemon
      // /api/agent/identity probe.
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'http://localhost:9200/api/agent/identity') {
          return new Response(JSON.stringify({
            agentAddress: '0xprobed',
            peerId: '12D3KooProbed',
            agentDid: 'did:dkg:agent:probed',
            name: 'probed',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ shareOperationId: 'op-mem-off' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      // Deliberately do NOT inject nodePeerId — memory module disabled scenario.
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      const result = await byName.get('dkg_share')!.execute('tc', {
        content: 'works without memory module',
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.shareOperationId).toBe('op-mem-off');
      // Subject should incorporate the address surfaced by the direct probe.
      expect(body.subject).toMatch(/^urn:openclaw:0xprobed:shared:\d+-[a-z0-9]+$/);
      const identityCalls = fetchMock.mock.calls.filter(c => c[0] === 'http://localhost:9200/api/agent/identity');
      expect(identityCalls.length).toBe(1);
    });

    it('dkg_share falls back to an anonymous unique subject when node identity is unresolved', async () => {
      // Without an injected nodePeerId, ensureNodeAgentAddress/ensureNodePeerId
      // both no-op (no memoryResolverApi). The direct /api/agent/identity
      // probe returns the default mock payload which lacks agentAddress and
      // peerId. The handler must NOT refuse the share — /api/shared-memory/write
      // doesn't require identity preflight. Mint a unique-per-call anonymous
      // subject so the upsert problem is still avoided and authorship just
      // degrades to anon attribution.
      const { fetchMock, byName } = setupPluginWithFetch(
        { shareOperationId: 'op-noid' },
        { skipNodeIdInjection: true },
      );
      const result = await byName.get('dkg_share')!.execute('tc', {
        content: 'hello',
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.shareOperationId).toBe('op-noid');
      expect(body.subject).toMatch(/^urn:openclaw:anon:shared:\d+-[a-z0-9]+$/);
      expect(body.root_entities).toEqual([body.subject]);
      // The actual share write must have happened.
      const shareCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/shared-memory/write'));
      expect(shareCalls.length).toBe(1);
    });

    it('dkg_share UCHAR-encodes non-ECHAR control bytes (NUL, VT, DEL) the canonical escaper leaves raw', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-uchar' });
      // escapeDkgRdfLiteral covers \b, \t, \n, \f, \r — but leaves NUL (0x00),
      // VT (0x0B), DEL (0x7F), etc. untouched. Those would produce invalid
      // N-Triples at the storage layer. Defensive post-pass UCHAR-encodes them.
      const NUL = String.fromCharCode(0x00);
      const VT = String.fromCharCode(0x0B);
      const DEL = String.fromCharCode(0x7F);
      await byName.get('dkg_share')!.execute('tc', {
        content: `a${NUL}b${VT}c${DEL}d`,
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.quads[0].object).toBe('"a\\u0000b\\u000Bc\\u007Fd"');
    });

    it('dkg_share plumbs sub_graph_name through to subGraphName for sub-graph-scoped writes', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-4' });
      await byName.get('dkg_share')!.execute('tc', {
        content: 'hello',
        context_graph_id: 'ctx',
        sub_graph_name: 'protocols',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.subGraphName).toBe('protocols');
    });

    it('dkg_share surfaces daemon-offline failures via the standard daemonError helper', async () => {
      const fetchMock = vi.fn(async () => { throw new Error('fetch failed: ECONNREFUSED'); });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      // Mirror setupPluginWithFetch's identity injection so the handler
      // gets past the unresolved-identity guard and reaches the fetch.
      (plugin as any).nodePeerId = '12D3KooTestPeerId';
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      const result = await byName.get('dkg_share')!.execute('tc', {
        content: 'hello',
        context_graph_id: 'ctx',
      });
      expect(result.content[0].text).toContain('DKG daemon is not reachable');
    });

    it('dkg_query explicitly rejects the v9 paranet_id field with a clear error', async () => {
      // V10-rc is the first product release; there is no v9 back-compat on the
      // public tool surface. Silently ignoring `paranet_id` would let stale v9
      // agent code run unscoped queries thinking it was scoping them — a
      // dangerous failure mode. The handler rejects the field explicitly so
      // the caller's wrong assumption surfaces instead of producing garbage.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        paranet_id: 'my-cg',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('paranet_id');
      expect(result.content[0].text).toContain('context_graph_id');
    });

    it('dkg_query rejects the legacy include_shared_memory field with a hint that names the union-semantics break', async () => {
      // The boolean was removed in favor of `view`. There is NO
      // one-line replacement: legacy `true` unioned the data graph with
      // SWM (engine wraps sparql in both and merges), which no single
      // `view` reproduces. `view: "shared-working-memory"` reads only
      // SWM and silently drops data-graph triples for `true` callers.
      // The hint must surface this break explicitly and name the HTTP
      // escape hatch for callers who need the exact union.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        include_shared_memory: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const msg = result.content[0].text;
      expect(msg).toContain('include_shared_memory');
      expect(msg).toContain('view');
      // Surface the non-equivalence.
      expect(msg).toMatch(/no exact|no single `view`/i);
      // Name the HTTP escape hatch for callers who need the original
      // union semantics — otherwise they have no migration path at all.
      expect(msg).toContain('/api/query');
      expect(msg).toContain('includeSharedMemory');
      // Also name the SWM closest-intent replacement + the omit path.
      expect(msg).toContain('shared-working-memory');
      expect(msg).toMatch(/omit/i);
    });

    it('dkg_query forwards an explicit agent_address to the daemon body for WM reads (T65 — checksums eth)', async () => {
      // WM reads are agent-scoped; the daemon requires an agentAddress.
      // T65 — Eth-shaped values are normalized to EIP-55 checksum form
      // before forwarding so they match the daemon's checksum-case graph
      // URI prefix. Caller-supplied lowercase wallet input → checksum on
      // the wire.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const ethLowercase = '0x26c9b05a30138b35e84e60a5b778d580065ffbb8';
      const ethChecksum = '0x26c9B05a30138b35e84e60A5B778d580065Ffbb8';
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: ethLowercase,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.view).toBe('working-memory');
      expect(body.agentAddress).toBe(ethChecksum);
    });

    it('dkg_query rejects a whitespace-only agent_address (same silent-namespace-swap risk as non-string)', async () => {
      // An explicitly-supplied whitespace string is still "caller meant
      // something here" — treating `"   "` as "missing" and defaulting
      // to `this.nodePeerId` would silently swap a cross-agent read for
      // a self-read, same failure mode as the non-string case.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: '   ',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('agent_address');
      expect(result.content[0].text).toMatch(/non-empty|empty/i);
    });

    it('dkg_query `view` validation uses the shared GET_VIEWS from dkg-core (no local mirror)', async () => {
      // Guard against the local VALID_VIEWS mirror being reintroduced.
      // When a view is added to core's GET_VIEWS but the adapter
      // maintains its own list, the tool silently rejects the new
      // view before the daemon can serve it. The handler must use
      // the shared constant so this class of drift can't happen.
      //
      // We verify behavior (not import graph): the error message lists
      // exactly the three views core publishes today, and a v9-removed
      // view is rejected.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        view: 'authoritative', // a REMOVED_VIEWS entry from core
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('working-memory');
      expect(text).toContain('shared-working-memory');
      expect(text).toContain('verified-memory');
    });

    it('dkg_query rejects a non-string agent_address instead of silently falling back to the node peerId', async () => {
      // Permissive hosts can pass through non-string values. If the
      // handler treated those as "missing", `view: "working-memory"`
      // would default to this node's peerId — a caller intending a
      // cross-agent WM read with a malformed value would silently get
      // the node's own WM back. Surface the bug instead: reject with
      // a clear type-error, don't leak namespaces.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: 12345,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('agent_address');
      expect(result.content[0].text).toContain('string');
    });

    it('dkg_query normalizes DID-prefixed eth agent_address for WM reads (T31/T48)', async () => {
      // T48 — Post-PR-264 WM is scoped by the daemon's eth address.
      // T65 — DID-prefixed eth values: prefix stripped THEN checksummed
      // (operator may supply lowercase under the DID wrapper; canonical
      // EIP-55 must reach the daemon).
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const ethLowercase = '0x26c9b05a30138b35e84e60a5b778d580065ffbb8';
      const ethChecksum = '0x26c9B05a30138b35e84e60A5B778d580065Ffbb8';
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: `did:dkg:agent:${ethLowercase}`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.agentAddress).toBe(ethChecksum);
      // DID prefix gone.
      expect(body.agentAddress).not.toContain('did:dkg:agent:');
    });

    it('dkg_query falls back to nodePeerId when agent_address is omitted before identity resolves', async () => {
      // Handler default for omitted agent_address must mirror the
      // daemon's writer-side `defaultAgentAddress ?? peerId` priority.
      const { fetchMock, byName, plugin } = setupPluginWithFetch({ ok: true });
      (plugin as any).nodeAgentAddress = undefined;
      (plugin as any).nodePeerId = '12D3KooWNoKeystorePeer';
      (plugin as any).ensureNodeAgentAddress = vi.fn().mockResolvedValue(undefined);
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        // agent_address intentionally omitted
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.view).toBe('working-memory');
      expect(body.agentAddress).toBe('12D3KooWNoKeystorePeer');
    });

    it('dkg_query errors when neither daemon identity nor peerId fallback is available', async () => {
      const { fetchMock, byName, plugin } = setupPluginWithFetch({ ok: true });
      (plugin as any).nodeAgentAddress = undefined;
      (plugin as any).nodePeerId = undefined;
      (plugin as any).ensureNodeAgentAddress = vi.fn().mockResolvedValue(undefined);
      (plugin as any).ensureNodePeerId = vi.fn().mockResolvedValue(undefined);
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('working-memory');
      expect(text).toContain('agent identity');
      expect(text).not.toContain('DKG_AGENT_ADDRESS');
      expect(text).not.toContain('dkgHome');
    });

    it('dkg_query forwards peerId-form WM agent_address verbatim (T48/T53 — daemon accepts as self-alias on no-keystore nodes)', async () => {
      // T53 supersedes T48's hard-rejection. The daemon's `/api/query`
      // accepts peerId as a valid self-alias for the default agent
      // when no keystore identity exists (writes go to peerId in that
      // case via `defaultAgentAddress ?? peerId`). Adapter-side hard-
      // rejection broke a legitimate read path. Forward the value
      // verbatim and let the daemon's scope rules decide.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      // DID-wrapped peerId: legacy DID prefix stripped, peerId forwarded.
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: 'did:dkg:agent:12D3KooWExamplePeerId',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      let body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.agentAddress).toBe('12D3KooWExamplePeerId');

      // Bare peerId: passes through unchanged.
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: '12D3KooWExamplePeerId',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      body = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
      expect(body.agentAddress).toBe('12D3KooWExamplePeerId');
    });

    it('dkg_query does NOT normalize agent_address on non-WM views (it only matters for WM routing)', async () => {
      // Non-WM views don't use `agentAddress` for graph resolution —
      // leave the value untouched so other downstream uses (e.g. audit
      // logging at the daemon) see the caller's original input.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'shared-working-memory',
        agent_address: 'did:dkg:agent:12D3KooWExamplePeerId',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.agentAddress).toBe('did:dkg:agent:12D3KooWExamplePeerId');
    });

    it('dkg_query rejects an invalid `view` string with the list of valid layers', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        view: 'long-term-memory', // a v9 view name, removed in v10
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('view');
      expect(text).toContain('working-memory');
      expect(text).toContain('shared-working-memory');
      expect(text).toContain('verified-memory');
    });

    it('dkg_query rejects a `view` without `context_graph_id` locally (no daemon round-trip)', async () => {
      // Engine throws "view '…' requires a contextGraphId" — catch it at
      // the tool boundary so callers see a clean, tool-shaped error
      // instead of a cryptic 500 from a round-trip.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        view: 'shared-working-memory',
        // context_graph_id intentionally omitted
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const msg = result.content[0].text;
      expect(msg).toContain('context_graph_id');
      expect(msg).toContain('shared-working-memory');
    });

    it('dkg_query description accurately describes the no-`view` routing (legacy path, not WM)', () => {
      // Documented-vs-actual: when `view` is omitted, the daemon +
      // DKGQueryEngine route through the legacy V9 data-graph path
      // (`DKGQueryEngine.query` → the `if (options?.view)` branch is
      // SKIPPED and falls through to "Legacy routing (V9 compat)"). It
      // is NOT implicit working-memory semantics, despite some stale
      // comments in the daemon hinting otherwise. This test guards the
      // tool description against re-introducing the misleading "omit
      // for WM" claim.
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const query = tools.find((t) => t.name === 'dkg_query')!;
      // Positive: description must call out the legacy routing for the omit case.
      expect(query.description).toMatch(/legacy/i);
      // Negative: specifically guard against re-introducing the misleading
      // "omit → WM default" phrasing. Use targeted substrings that would
      // only appear in the wrong claim, not the correct HTTP escape-hatch
      // sentence that mentions working-memory by name.
      expect(query.description).not.toMatch(/omit[^.]*default[^.]*working-memory/i);
      expect(query.description).not.toMatch(/default[^.]*WM semantics/i);
      expect(query.description).not.toMatch(/Omit `?view`? for the default/i);
    });

    it('dkg_query description steers WM reads toward current_agent_address and retries identity variants', () => {
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const query = tools.find((t) => t.name === 'dkg_query')!;
      const agentAddress = query.parameters.properties.agent_address as { description?: string };

      expect(query.description).toContain('current_agent_address');
      expect(query.description).toMatch(/retry alternate identity forms/i);
      expect(agentAddress.description).toContain('current_agent_address');
      // T48/T49/T53 — schema names eth-address shape as the recommended
      // form, accepts peerId as self-alias on no-keystore nodes,
      // documents the legacy `did:dkg:agent:` strip.
      expect(agentAddress.description).toMatch(/0x-prefixed eth address/i);
      expect(agentAddress.description).toMatch(/peer ID/i);
      expect(agentAddress.description).toMatch(/did:dkg:agent:/);
    });

    it('share-flow tool descriptions prefer invite code output for friend-sharing requests', () => {
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));

      expect(byName.get('dkg_context_graph_invite')!.description).toContain('ready-to-share invite code');
      expect(byName.get('dkg_context_graph_invite')!.description).toContain('paste into Join');
      expect(byName.get('dkg_participant_add')!.description).toContain('allowlisting alone is not the full UI join flow');
    });

    it('dkg_query forwards the `view` field to the daemon body verbatim', async () => {
      // Handler-level drift guard: the daemon's /api/query route destructures
      // `view` from the body. If we renamed the field in the handler, this
      // test catches the drift.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'verified-memory',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.view).toBe('verified-memory');
      expect(body.contextGraphId).toBe('my-cg');
      expect(body).not.toHaveProperty('includeSharedMemory');
    });

    it('dkg_subscribe rejects a stringified include_shared_memory (same rationale as dkg_query)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_subscribe')!.execute('tc', {
        context_graph_id: 'ctx',
        include_shared_memory: 'true',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('include_shared_memory');
      expect(result.content[0].text).toContain('boolean');
    });

    it('dkg_assertion_promote description points to dkg_shared_memory_publish as the next step', () => {
      // dkg_publish is a one-shot write-AND-publish helper. After promote the
      // data is already in SWM, so the correct finalizer is
      // dkg_shared_memory_publish — calling dkg_publish would append
      // duplicates. The promote description must steer agents correctly.
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const promote = tools.find((t) => t.name === 'dkg_assertion_promote')!;
      expect(promote.description).toContain('dkg_shared_memory_publish');
      expect(promote.description).toMatch(/NOT dkg_publish/);
    });

    it('dkg_assertion_write escapes every N-Triples ECHAR control character in literal objects', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ written: 1 });
      await byName.get('dkg_assertion_write')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        quads: [
          {
            subject: 'https://example.org/a',
            predicate: 'https://schema.org/text',
            // Includes: \n, \t, \r, ", \, \f (form-feed), \b (backspace).
            // Missing \f / \b escapes would leave raw 0x0C / 0x08 bytes in
            // the JSON body and cause strict triple-store parsers to reject
            // the literal.
            object: 'line1\nline2\tcol\rend"with quote\\and backslash\fff\bbb',
          },
        ],
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.quads[0].object).toBe(
        '"line1\\nline2\\tcol\\rend\\"with quote\\\\and backslash\\fff\\bbb"',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // No v9 back-compat: v10-rc is the first product release. Any v9-era field
  // (`paranet_id`, stringified `include_shared_memory`, etc.) is out of scope
  // for the public tool surface. Handlers and schemas only accept the V10
  // shape. Strict JSON-schema validators and permissive hosts behave the
  // same: a stray legacy field is simply ignored (not a special-cased error),
  // and `context_graph_id` is the single source of truth on every tool that
  // needs it.
  // ---------------------------------------------------------------------------

  it('dkg_subscribe / dkg_publish / dkg_query do not advertise or honor the v9 paranet_id alias', () => {
    const plugin = new DkgNodePlugin();
    const tools: OpenClawTool[] = [];
    plugin.register({
      config: {},
      registerTool: (t) => tools.push(t),
      registerHook: () => {},
      on: () => {},
      logger: {},
    });
    const byName = new Map(tools.map((t) => [t.name, t] as const));
    for (const name of ['dkg_subscribe', 'dkg_publish', 'dkg_query'] as const) {
      const props = byName.get(name)!.parameters.properties;
      expect(props).not.toHaveProperty('paranet_id');
    }
  });

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

  it('registers OpenClaw through the generic local-agent endpoint', async () => {
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
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: {},
      };

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
      // Post-pivot, connect publishes the ready/bound transport upfront
      // (no follow-up PUT). syncLocalAgentIntegrationState awaits start()
      // before firing connect, so isListening is already true and
      // bridgeUrl/healthUrl/runtime.ready are all populated in this call.
      const connectBody = JSON.parse(String(connectCall?.[1]?.body));
      expect(connectBody).toMatchObject({
        id: 'openclaw',
        enabled: true,
        manifest: {
          packageName: '@origintrail-official/dkg-adapter-openclaw',
          setupEntry: './setup-entry.mjs',
        },
        metadata: {
          channelId: 'dkg-ui',
          registrationMode: 'full',
        },
        runtime: {
          status: 'ready',
          ready: true,
          lastError: null,
        },
      });
      // T30 — `dkgPrimaryMemory` and `wmImportPipeline` are derived
      // from the actual memory-slot registration state. This test
      // configured `memory.enabled: false`, so the slot is NOT
      // registered and these flags MUST be false.
      expect(connectBody.capabilities).toMatchObject({
        localChat: true,
        connectFromUi: true,
        dkgPrimaryMemory: false,
        wmImportPipeline: false,
      });
      expect(connectBody.manifest).toEqual({
        packageName: '@origintrail-official/dkg-adapter-openclaw',
        setupEntry: './setup-entry.mjs',
      });
      expect(connectBody.setupEntry).toBe('./setup-entry.mjs');
      expect(connectBody.transport.kind).toBe('openclaw-channel');
      expect(connectBody.transport.bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const readyCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      );
      expect(readyCall).toBeUndefined();
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  // Issue #272: when the gateway hosts the channel routes via registerHttpRoute,
  // start() still binds the standalone bridge — but on a fallback OS-allocated
  // port if the configured one is held by the gateway. To eliminate the
  // ready-but-not-yet-bound window the daemon would otherwise see, we await
  // start() BEFORE firing the connect call. The connect publishes ready:true
  // with the actually-bound bridgeUrl/healthUrl in one shot — there is no
  // separate post-start PUT.
  it('awaits channelPlugin.start() before firing connect (gateway routes active)', async () => {
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
    // Patch start() on the prototype so the spy is in place BEFORE the
    // DkgChannelPlugin instance is constructed by DkgNodePlugin.register().
    // Patching the instance after register() is too late — start() has
    // already been invoked through the await in syncLocalAgentIntegrationState.
    let resolveStart: () => void = () => {};
    const startGate = new Promise<void>((resolve) => { resolveStart = resolve; });
    const startSpy = vi.spyOn(DkgChannelPlugin.prototype, 'start').mockImplementation(() => startGate);

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: { gateway: { port: 19789 } },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);

      // Wait until start() has been invoked — proves the registration path
      // reached the await. Connect must NOT fire while start is pending.
      await vi.waitFor(() => {
        expect(startSpy).toHaveBeenCalled();
      });

      // Settle pending microtasks before the negative assertion so we don't
      // race a connect call queued after start was observed.
      await Promise.resolve();
      await Promise.resolve();
      const connectBeforeResolve = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      expect(connectBeforeResolve).toBeUndefined();

      // Release start() — the await resolves and the connect call fires.
      resolveStart();

      await vi.waitFor(() => {
        const connectCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/connect'),
        );
        expect(connectCall).toBeTruthy();
      });

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      const connectBody = JSON.parse(String(connectCall?.[1]?.body));
      // start() is stubbed (never actually binds), so isListening stays false.
      // The connect call fires with status:'connecting' / ready:false in this
      // case. What matters for the round-2 review is the ORDERING (start
      // awaited before connect), not the bound-port shape — the bridge-mode
      // test below exercises the real-bind path against a port:0 server and
      // asserts the ready/bridgeUrl shape.
      expect(connectBody).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'http://127.0.0.1:19789',
        },
        metadata: {
          transportMode: 'gateway+bridge',
        },
      });
      // No follow-up PUT — connect publishes the bound transport upfront.
      const readyCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      );
      expect(readyCall).toBeUndefined();
    } finally {
      resolveStart();
      startSpy.mockRestore();
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  // Bridge-mode (fallback) path — older gateways or runtimes where
  // api.registerHttpRoute is not available. The standalone bridge binds on
  // an OS-allocated port (channel.port: 0), then connect publishes ready:true
  // with the actually-bound bridgeUrl/healthUrl. There is no follow-up PUT.
  it('publishes ready:true with the bound bridgeUrl in bridge mode (no registerHttpRoute)', async () => {
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
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: { gateway: { port: 19789 } },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        // No registerHttpRoute — fallback to standalone bridge mode.
        on: () => {},
        logger: {},
      };

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
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        metadata: {
          transportMode: 'bridge',
        },
        runtime: {
          status: 'ready',
          ready: true,
          lastError: null,
        },
        transport: {
          kind: 'openclaw-channel',
          bridgeUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
          healthUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/health$/),
        },
      });

      // Confirm there's NO follow-up PUT — connect now publishes the bound
      // transport upfront. This locks the round-2 simplification: the daemon
      // never sees a transient ready:true integration whose bridgeUrl can't
      // serve traffic yet.
      const readyCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      );
      expect(readyCall).toBeUndefined();
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('drops a stale stored gatewayUrl when the current runtime is bridge-only', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              enabled: true,
              transport: {
                kind: 'openclaw-channel',
                gatewayUrl: 'http://127.0.0.1:9200',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: {},
      };

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
      // Post-pivot: connect publishes ready/bound transport upfront. The
      // stale stored gatewayUrl from the GET above must be dropped because
      // the current runtime (no registerHttpRoute → bridge-only) does not
      // serve gateway routes. bridgeUrl/healthUrl reflect the actually
      // bound port from the awaited start().
      const connectBody = JSON.parse(String(connectCall?.[1]?.body));
      expect(connectBody).toMatchObject({
        id: 'openclaw',
        enabled: true,
        transport: {
          kind: 'openclaw-channel',
          bridgeUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
          healthUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/health$/),
        },
        metadata: expect.objectContaining({
          channelId: 'dkg-ui',
          registrationMode: 'full',
          transportMode: 'bridge',
        }),
        runtime: {
          status: 'ready',
          ready: true,
          lastError: null,
        },
      });
      expect(connectBody.transport.gatewayUrl).toBeUndefined();

      const readyCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      );
      expect(readyCall).toBeUndefined();
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('clears the stored local-agent bridge state when the channel is hot-disabled', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              enabled: true,
              transport: {
                kind: 'openclaw-channel',
                bridgeUrl: 'http://127.0.0.1:9201',
                healthUrl: 'http://127.0.0.1:9201/health',
              },
              runtime: { status: 'ready', ready: true, lastError: null },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      };

      plugin.register(mockApi);
      await vi.waitFor(() => {
        const connectCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/connect'),
        );
        expect(connectCall).toBeTruthy();
      });

      plugin.updateConfig({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      });
      plugin.register(mockApi);

      await vi.waitFor(() => {
        const clearCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/openclaw') &&
          call[1]?.method === 'PUT',
        );
        expect(clearCall).toBeTruthy();
      });
      const clearCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw') &&
        call[1]?.method === 'PUT',
      );
      const clearBody = JSON.parse(String(clearCall?.[1]?.body));
      expect(clearBody).toMatchObject({
        enabled: false,
        transport: { kind: 'openclaw-channel' },
        capabilities: {
          localChat: false,
          chatAttachments: false,
          connectFromUi: false,
        },
        metadata: {
          channelId: 'dkg-ui',
          registrationMode: 'full',
          transportMode: 'disabled',
        },
        runtime: {
          status: 'configured',
          ready: false,
          lastError: 'DKG UI channel disabled by adapter config',
        },
      });
      expect(clearBody.transport.bridgeUrl).toBeUndefined();
      expect(clearBody.transport.healthUrl).toBeUndefined();
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('clears stored local-agent bridge state when disable races with a completed in-flight stop', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue({
      id: 'openclaw',
      enabled: true,
      runtime: { status: 'configured', ready: true },
      metadata: { transportMode: 'openclaw-channel' },
    });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).channelPlugin = null;
    (plugin as any).channelPluginStopInFlight = Promise.resolve(true);
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    (plugin as any).registerIntegrationModules(mockApi, {
      enableFullRuntime: true,
      registrationMode: 'full',
    });

    await vi.waitFor(() => {
      expect(updateLocalAgentIntegration).toHaveBeenCalledWith(
        'openclaw',
        expect.objectContaining({
          enabled: false,
          capabilities: expect.objectContaining({
            localChat: false,
            chatAttachments: false,
            connectFromUi: false,
          }),
          metadata: expect.objectContaining({ transportMode: 'disabled' }),
          runtime: expect.objectContaining({ status: 'configured', ready: false }),
        }),
      );
    });
  });

  it('clears stored local-agent bridge state on cold runtime registration with channel disabled', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue({
      id: 'openclaw',
      enabled: true,
      runtime: { status: 'configured', ready: true },
      metadata: { transportMode: 'openclaw-channel' },
    });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).channelPlugin = null;
    (plugin as any).channelPluginStopInFlight = null;
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    (plugin as any).registerIntegrationModules(mockApi, {
      enableFullRuntime: true,
      registrationMode: 'full',
    });

    await vi.waitFor(() => {
      expect(updateLocalAgentIntegration).toHaveBeenCalledWith(
        'openclaw',
        expect.objectContaining({
          enabled: false,
          capabilities: expect.objectContaining({
            localChat: false,
            chatAttachments: false,
            connectFromUi: false,
          }),
          metadata: expect.objectContaining({ transportMode: 'disabled' }),
          runtime: expect.objectContaining({ status: 'configured', ready: false }),
        }),
      );
    });
  });

  it('skips disabled-channel cleanup on cold runtime registration when no local-agent record exists', async () => {
    const debug = vi.fn();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue(null);
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).channelPlugin = null;
    (plugin as any).channelPluginStopInFlight = null;
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug },
    };

    (plugin as any).registerIntegrationModules(mockApi, {
      enableFullRuntime: true,
      registrationMode: 'full',
    });

    await vi.waitFor(() => {
      expect(getLocalAgentIntegration).toHaveBeenCalledWith('openclaw');
    });
    expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('nothing to clear'));
  });

  it('retries disabled-channel local-agent cleanup after a transient stored-state load failure', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const debug = vi.fn();
    const info = vi.fn();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn()
      .mockRejectedValueOnce(new Error('daemon cold start'))
      .mockResolvedValueOnce({
        id: 'openclaw',
        enabled: true,
        runtime: { status: 'configured', ready: true },
        metadata: { transportMode: 'openclaw-channel' },
      });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).channelPlugin = null;
    (plugin as any).channelPluginStopInFlight = null;
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info, warn, debug },
    };

    try {
      (plugin as any).registerIntegrationModules(mockApi, {
        enableFullRuntime: true,
        registrationMode: 'full',
      });
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(1);
      expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying disabled-channel status update'));

      await vi.advanceTimersByTimeAsync(4_999);
      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(2);
      expect(updateLocalAgentIntegration).toHaveBeenCalledWith(
        'openclaw',
        expect.objectContaining({
          enabled: false,
          metadata: expect.objectContaining({ transportMode: 'disabled' }),
          runtime: expect.objectContaining({ status: 'configured', ready: false }),
        }),
      );
      expect(info).toHaveBeenCalledWith(expect.stringContaining('loaded for disabled-channel cleanup after 1 retry attempt'));
    } finally {
      vi.useRealTimers();
      await plugin.stop();
    }
  });

  it('stops disabled-channel cleanup retry when the stored local-agent record is still missing', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const info = vi.fn();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn()
      .mockRejectedValueOnce(new Error('daemon cold start'))
      .mockResolvedValueOnce(null);
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).channelPlugin = null;
    (plugin as any).channelPluginStopInFlight = null;
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info, warn, debug: vi.fn() },
    };

    try {
      (plugin as any).registerIntegrationModules(mockApi, {
        enableFullRuntime: true,
        registrationMode: 'full',
      });
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(1);
      expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying disabled-channel status update'));

      await vi.advanceTimersByTimeAsync(5_000);
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(2);
      expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(expect.stringContaining('nothing to clear'));
      expect((plugin as any).localAgentIntegrationRetryTimer).toBeNull();
    } finally {
      vi.useRealTimers();
      await plugin.stop();
    }
  });

  it('does not let a stale disabled-channel cleanup retry overwrite a later re-enable', async () => {
    vi.useFakeTimers();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn()
      .mockRejectedValueOnce(new Error('daemon cold start'))
      .mockResolvedValueOnce(null);
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    try {
      (plugin as any).registerIntegrationModules(mockApi, {
        enableFullRuntime: true,
        registrationMode: 'full',
      });
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(1);

      (plugin as any).config.channel = { enabled: true, port: 0 };
      await vi.advanceTimersByTimeAsync(5_000);

      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(1);
      expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await plugin.stop();
    }
  });

  it('cancels a pending local-agent retry when clearing a disabled channel', async () => {
    vi.useFakeTimers();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue({
      id: 'openclaw',
      enabled: true,
      runtime: { status: 'configured', ready: true },
      metadata: { transportMode: 'openclaw-channel' },
    });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    const syncLocalAgentIntegrationState = vi
      .spyOn(plugin as any, 'syncLocalAgentIntegrationState')
      .mockResolvedValue(undefined);
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    try {
      (plugin as any).scheduleLocalAgentIntegrationRetry(mockApi, 'full');
      expect((plugin as any).localAgentIntegrationRetryTimer).not.toBeNull();

      (plugin as any).clearLocalAgentChannelIntegration(mockApi, 'full');

      expect((plugin as any).localAgentIntegrationRetryTimer).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(syncLocalAgentIntegrationState).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(updateLocalAgentIntegration).toHaveBeenCalledWith(
          'openclaw',
          expect.objectContaining({
            enabled: false,
            capabilities: expect.objectContaining({ localChat: false, connectFromUi: false }),
            metadata: expect.objectContaining({ transportMode: 'disabled' }),
          }),
        );
      });
    } finally {
      vi.useRealTimers();
      syncLocalAgentIntegrationState.mockRestore();
    }
  });

  it('does not re-enable an explicitly disconnected stored bridge when channel is disabled', async () => {
    const info = vi.fn();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue({
      id: 'openclaw',
      enabled: false,
      runtime: { status: 'disconnected', ready: false },
      metadata: { userDisabled: true },
    });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info, warn: vi.fn(), debug: vi.fn() },
    };

    (plugin as any).registerIntegrationModules(mockApi, {
      enableFullRuntime: true,
      registrationMode: 'full',
    });

    await vi.waitFor(() => {
      expect(getLocalAgentIntegration).toHaveBeenCalledWith('openclaw');
    });
    expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('explicitly disconnected by the user'));
  });

  it('does not advertise memory capabilities when clearing a disabled channel during memory disable', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue({
      id: 'openclaw',
      enabled: true,
      runtime: { status: 'configured', ready: true },
      metadata: { transportMode: 'openclaw-channel' },
    });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    const memoryPlugin = {
      isRegistered: vi.fn(() => true),
      disable: vi.fn(() => true),
      close: vi.fn(async () => {}),
    };
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).memoryPlugin = memoryPlugin;
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    (plugin as any).registerIntegrationModules(mockApi, {
      enableFullRuntime: true,
      registrationMode: 'full',
    });

    await vi.waitFor(() => {
      expect(updateLocalAgentIntegration).toHaveBeenCalledWith(
        'openclaw',
        expect.objectContaining({
          capabilities: expect.objectContaining({
            localChat: false,
            chatAttachments: false,
            connectFromUi: false,
            dkgPrimaryMemory: false,
            wmImportPipeline: false,
          }),
        }),
      );
    });
    expect(memoryPlugin.disable).toHaveBeenCalledWith(mockApi);
  });

  it('recomputes gatewayUrl from current gateway config even when the port stays at the default', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              enabled: true,
              transport: {
                kind: 'openclaw-channel',
                gatewayUrl: 'http://127.0.0.1:18789',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {
          gateway: {
            customBindHost: 'localhost',
            tls: { enabled: true },
          },
        },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );

      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'https://localhost:18789',
        },
      });
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('derives the current local gatewayUrl when gateway routing is active and the current gateway object has no URL-affecting settings', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              enabled: true,
              transport: {
                kind: 'openclaw-channel',
                gatewayUrl: 'http://10.0.0.5:18789',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {
          gateway: {
            announceBonjour: true,
          },
        } as any,
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );

      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'http://127.0.0.1:18789',
        },
      });
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('derives the current local gatewayUrl when gateway tls config only sets enabled=false', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              transport: {
                kind: 'openclaw-channel',
                gatewayUrl: 'http://10.0.0.5:18789',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {
          gateway: {
            tls: { enabled: false },
          },
        },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'http://127.0.0.1:18789',
        },
      });
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('formats IPv6 gateway hosts as valid URLs', async () => {
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
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {
          gateway: {
            customBindHost: '::1',
            port: 18789,
          },
        },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );

      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'http://[::1]:18789',
        },
      });
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('does not re-enable a stored OpenClaw integration when the user explicitly disconnected it', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const infoCalls: unknown[][] = [];
    const info = (...args: unknown[]) => { infoCalls.push(args); };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              enabled: false,
              runtime: { status: 'disconnected', ready: false },
              metadata: { userDisabled: true },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info },
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(fetchCalls.some(call =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'GET',
      )).toBe(true);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(false);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      )).toBe(false);
      expect(infoCalls.some(args => String(args[0]).includes('explicitly disconnected by the user'))).toBe(true);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('does not re-enable a legacy pre-flag disconnected OpenClaw integration on startup', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const infoCalls: unknown[][] = [];
    const info = (...args: unknown[]) => { infoCalls.push(args); };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              enabled: false,
              connectedAt: '2026-04-13T09:00:00.000Z',
              runtime: { status: 'disconnected', ready: false },
              transport: {
                kind: 'openclaw-channel',
                bridgeUrl: 'http://127.0.0.1:9201',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info },
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(false);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      )).toBe(false);
      expect(infoCalls.some(args => String(args[0]).includes('explicitly disconnected by the user'))).toBe(true);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('re-registers a transport-only OpenClaw record on startup', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              transport: {
                kind: 'openclaw-channel',
                bridgeUrl: 'http://127.0.0.1:9201',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(true);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('overwrites a stored bridgeUrl with the freshly bound port (post-pivot await-before-connect)', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              transport: {
                kind: 'openclaw-channel',
                bridgeUrl: 'http://127.0.0.1:9201',
                healthUrl: 'http://127.0.0.1:9201/health',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: {},
      };

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
      // Post-pivot: syncLocalAgentIntegrationState awaits start() before
      // building the connect payload, so bridgePort > 0 by the time
      // buildOpenClawTransport runs and the stored stale bridgeUrl is
      // overwritten with the freshly bound port. The stored values from the
      // GET above (port 9201) are intentionally NOT preserved on this path —
      // they would be wrong (the gateway holds 9201 in 2026.3.31).
      const connectBody = JSON.parse(String(connectCall?.[1]?.body));
      expect(connectBody.transport.bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(connectBody.transport.bridgeUrl).not.toBe('http://127.0.0.1:9201');
      expect(connectBody.transport.healthUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/health$/);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('aborts startup re-registration when stored OpenClaw integration state cannot be loaded', async () => {
    const originalFetch = globalThis.fetch;
    const warnCalls: unknown[][] = [];
    const warn = (...args: unknown[]) => { warnCalls.push(args); };
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        throw new Error('temporary daemon outage');
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { warn },
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(fetchCalls.some(call =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'GET',
      )).toBe(true);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(false);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      )).toBe(false);
      expect(warnCalls.some(args => String(args[0]).includes('aborting startup re-registration'))).toBe(true);
      expect(warnCalls.some(args => String(args[0]).includes('reason: temporary daemon outage'))).toBe(true);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('retries startup re-registration in-process after a transient stored-state load failure', async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const warnCalls: unknown[][] = [];
    const warn = (...args: unknown[]) => { warnCalls.push(args); };
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        if (fetchCalls.filter((call) =>
          String(call[0]).includes('/api/local-agent-integrations/openclaw') && call[1]?.method === 'GET',
        ).length === 1) {
          throw new Error('temporary daemon outage');
        }
        return {
          ok: true,
          json: async () => ({ integration: null }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { warn },
      };

      plugin.register(mockApi);
      await Promise.resolve();

      expect(fetchCalls.some(call =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'GET',
      )).toBe(true);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(false);

      // Retry-backoff follow-up: first retry delay is now 5s (not 1s),
      // so advance by the new base delay before asserting the retry
      // fired.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(fetchCalls.filter((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw') && call[1]?.method === 'GET',
      )).toHaveLength(2);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(true);
      expect(warnCalls.some(args => String(args[0]).includes('aborting startup re-registration'))).toBe(true);
      expect(warnCalls.some(args => String(args[0]).includes('reason: temporary daemon outage'))).toBe(true);
    } finally {
      vi.useRealTimers();
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('retry backoff grows exponentially and warns only once per distinct failure reason', async () => {
    // Live-validation follow-up: prior to this change the retry loop
    // fired every 1 s with a warn-level log on every attempt, which
    // flooded the gateway log when the daemon was not yet up on cold
    // start. The fix: 5 s base delay, 2x exponential growth capped at
    // 60 s, and log dedup that emits one warn per distinct failure
    // reason with subsequent repeats at debug level.
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const warn = vi.fn();
    const debug = vi.fn();
    const info = vi.fn();
    const fakeFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        throw new Error('daemon cold start');
      }
      return { ok: true, json: async () => ({ ok: true, integration: { id: 'openclaw' } }) };
    });
    globalThis.fetch = fakeFetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { warn, debug, info },
      };

      plugin.register(mockApi);
      await Promise.resolve();

      const getCallCount = () =>
        fakeFetch.mock.calls.filter((call) =>
          String(call[0]).includes('/api/local-agent-integrations/openclaw') && call[1]?.method === 'GET',
        ).length;

      // Initial register fires one sync call.
      expect(getCallCount()).toBe(1);
      // Attempt 1 scheduled for base delay (5s). Advance 4s — still no retry.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(getCallCount()).toBe(1);
      // Cross the 5s boundary — retry #1 lands.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getCallCount()).toBe(2);
      // Attempt 2 delay is 10s. Advance 9s — still no new retry.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(getCallCount()).toBe(2);
      // Cross the 10s boundary — retry #2 lands.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getCallCount()).toBe(3);
      // Attempt 3 delay is 20s. Advance 19s — still no new retry.
      await vi.advanceTimersByTimeAsync(19_000);
      expect(getCallCount()).toBe(3);
      // Cross the 20s boundary — retry #3 lands.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getCallCount()).toBe(4);

      // Dedup: exactly ONE warn with this reason across all four attempts,
      // even though the sync function was called four times. The repeated
      // sync calls see the same reason and drop to debug level.
      const warnCallsWithReason = warn.mock.calls.filter((call) =>
        String(call[0]).includes('reason: daemon cold start'),
      );
      expect(warnCallsWithReason).toHaveLength(1);
      // Debug is called on every subsequent attempt from both the
      // dedup path (syncLocalAgentIntegrationState) and the catch site
      // in loadStoredOpenClawIntegration — we only assert at least 3
      // debug hits (one per extra attempt beyond the first) to keep the
      // test resilient to future log-site refactors.
      const debugCallsWithReason = debug.mock.calls.filter((call) =>
        String(call[0]).includes('daemon cold start'),
      );
      expect(debugCallsWithReason.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('retry delay caps at 60s after enough failed attempts', async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const fakeFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        throw new Error('daemon unreachable');
      }
      return { ok: true, json: async () => ({}) };
    });
    globalThis.fetch = fakeFetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
      };

      plugin.register(mockApi);
      await Promise.resolve();

      const getCallCount = () =>
        fakeFetch.mock.calls.filter((call) =>
          String(call[0]).includes('/api/local-agent-integrations/openclaw') && call[1]?.method === 'GET',
        ).length;

      // Chew through the ramp (5s → 10s → 20s → 40s → 60s) and then
      // verify the next two attempts both fire on the 60s cap rather
      // than growing further (80s, 160s would both push past the cap).
      expect(getCallCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000); // attempt 2 lands
      await vi.advanceTimersByTimeAsync(10_000); // attempt 3 lands
      await vi.advanceTimersByTimeAsync(20_000); // attempt 4 lands
      await vi.advanceTimersByTimeAsync(40_000); // attempt 5 lands
      expect(getCallCount()).toBe(5);
      await vi.advanceTimersByTimeAsync(60_000); // attempt 6 lands at the cap
      expect(getCallCount()).toBe(6);
      await vi.advanceTimersByTimeAsync(60_000); // attempt 7 also lands at the cap
      expect(getCallCount()).toBe(7);
    } finally {
      vi.useRealTimers();
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('retries only disabled-channel cleanup when both memory and channel are disabled', async () => {
    // A disabled channel still retries the cleanup path so it can clear stale
    // bridge state after daemon cold-start races. It must not run startup
    // re-registration or reconnect the bridge while both integrations are off.
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const fakeFetch = vi.fn();
    globalThis.fetch = fakeFetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { warn: vi.fn(), debug: vi.fn() },
      };

      plugin.register(mockApi);
      await Promise.resolve();
      // Advance a full minute. Disabled cleanup retries at 5s, 10s, then 20s;
      // the 40s follow-up lands after this window.
      await vi.advanceTimersByTimeAsync(60_000);

      const getCalls = fakeFetch.mock.calls.filter((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw') && call[1]?.method === 'GET',
      );
      const connectCalls = fakeFetch.mock.calls.filter((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      expect(getCalls).toHaveLength(4);
      expect(connectCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('registers the memory slot capability in setup-runtime mode on a slot-owning gateway', () => {
    // Live-validation follow-up: prior code classified setup-runtime as
    // lightweight and skipped memory-module registration entirely. That
    // left `registerMemoryCapability` unregistered on any gateway that
    // stayed in setup-runtime mode, silently disabling slot-backed
    // recall. With the fix, setup-runtime is a runtime mode — memory
    // slot registers as long as plugins.slots.memory names this adapter.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    const registerMemoryCapability = vi.fn();
    const info = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: {
        plugins: {
          slots: { memory: 'adapter-openclaw' },
        },
      } as any,
      registrationMode: 'setup-runtime',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability,
      on: () => {},
      logger: { info, warn: vi.fn(), debug: vi.fn() },
    };

    plugin.register(mockApi);

    expect(registerMemoryCapability).toHaveBeenCalledTimes(1);
    // Log line must include the registration mode so operators can tell
    // which pass of the gateway multi-phase init actually wired up the
    // slot.
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('registerMemoryCapability called (registrationMode=setup-runtime)'),
    );
  });

  it('does NOT register the memory slot capability in setup-only or cli-metadata modes (regression guard)', () => {
    // Negative counterpart of the setup-runtime test above. Widening
    // the runtime gate was an explicit decision for setup-runtime only;
    // setup-only and cli-metadata must still skip memory registration
    // because those modes have no runtime at all and the gateway does
    // not expect tool dispatch on them.
    for (const mode of ['setup-only', 'cli-metadata'] as const) {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      const registerMemoryCapability = vi.fn();
      const mockApi: OpenClawPluginApi = {
        config: {
          plugins: { slots: { memory: 'adapter-openclaw' } },
        } as any,
        registrationMode: mode,
        registerTool: () => {},
        registerHook: () => {},
        registerMemoryCapability,
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      };

      plugin.register(mockApi);

      expect(registerMemoryCapability, `mode=${mode}`).not.toHaveBeenCalled();
    }
  });

  it('setup-only registration skips tool registration but keeps the plugin bootable', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true },
      memory: { enabled: true },
    });
    const registeredTools: OpenClawTool[] = [];
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-only',
      registerTool: (tool) => registeredTools.push(tool),
      registerHook: () => {},
      on: () => {},
      logger: {},
    };

    plugin.register(mockApi);

    expect(registeredTools).toHaveLength(0);
    expect(plugin.getClient().baseUrl).toBe('http://localhost:9200');
  });

  it('R17.2 — setup-only registration must NOT construct ChatTurnWriter (no filesystem side effects)', () => {
    // Regression for R17.2: previously `ChatTurnWriter` was constructed
    // unconditionally before the `runtimeEnabled` gate, so setup-only
    // metadata-only loads still ran `mkdirSync` and read the watermark
    // file. In read-only workspaces that emitted warnings or errors
    // during what should be a side-effect-free scan. The writer must
    // now be created lazily inside the runtime-enabled branch.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true },
      memory: { enabled: true },
    });
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-only',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    plugin.register(mockApi);
    expect((plugin as any).chatTurnWriter).toBeNull();
  });

  it('R24.2 — DKG-Memory prompt section is NOT installed in setup-runtime mode (tools not registered there)', () => {
    // Regression for R24.2: pre-fix, the "Prefer memory_search" prompt
    // guidance was installed on every runtime-enabled registration
    // including `setup-runtime`. But `memory_search` / `dkg_query` are
    // registered only in `full` mode (the tool-registration loop in
    // register() is `fullRuntime`-gated). So in setup-runtime the model
    // would be told to use a tool that does not exist on this phase.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true },
      memory: { enabled: true },
    });
    const promptSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-runtime',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy,
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('R24.2 — DKG-Memory prompt section is NOT installed when memory.enabled is false (tool would error)', () => {
    // Regression for R24.2: when memory is config-disabled, `memory_search`
    // returns "memory unavailable" and the prompt guidance is misleading.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const promptSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy,
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('R24.2 — DKG-Memory prompt section IS installed in full mode with memory enabled', () => {
    // Positive control: confirms the gate is not too tight.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    });
    const promptSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy,
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    const call = promptSpy.mock.calls[0][0];
    expect(call.title).toBe('DKG Memory');
    expect(call.body).toContain('memory_search');
  });

  it('T6 — same-api setup-runtime → full upgrade retries previously-failed typed installs', () => {
    // Regression for T6: pre-fix, the same-api fast path in
    // `installHooksIfNeeded` only retried INTERNAL installs whose
    // previous `installedVia === 'none'`. If the gateway upgraded an
    // existing registry in place (`api.on` becomes a function on the
    // SAME api object after a setup-runtime → full transition), the
    // typed installs that recorded `installedVia: 'none'` at first
    // call stayed permanently uninstalled. W3 / W4a hooks would never
    // wire up.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    // Mutable api object — `on` is undefined initially, becomes a
    // function on the second register() call.
    const onSpy = vi.fn();
    const api: any = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'setup-runtime',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      // No `on` initially — typed installs will record 'none'.
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    plugin.register(api);
    // Tick 1 — typed installs failed (no api.on). onSpy not called.
    expect(onSpy).not.toHaveBeenCalled();
    const stats1 = (plugin as any).hookSurface.getDispatchStats();
    expect(stats1['typed:before_prompt_build']?.installedVia).toBe('none');
    expect(stats1['typed:agent_end']?.installedVia).toBe('none');

    // Tick 2 — same api object, but now `api.on` is available
    // (gateway upgraded the registry in place). registrationMode also
    // flipped to 'full'.
    api.on = onSpy;
    api.registrationMode = 'full';
    plugin.register(api);
    // Typed installs MUST have been retried this time.
    const events = onSpy.mock.calls.map((c: any) => c[0]);
    expect(events).toContain('before_prompt_build');
    expect(events).toContain('agent_end');
    expect(events).toContain('before_compaction');
    expect(events).toContain('before_reset');
  });

  it('T31 — multi-phase init re-bind: typed hooks installed on EVERY api so emit-against-old-api still fires', async () => {
    // Regression for T31 Bug B: pre-fix, the apiChanged branch destroyed
    // the old hook surface and rebuilt against the new api. The gateway
    // re-registers our plugin on each inbound turn against fresh api
    // objects but doesn't always dispatch against the latest one — orphan
    // handlers had `installedVia=on, fireCount=0` after multiple chats.
    // Post-fix, every surface stays live; whichever api the gateway emits
    // against has a bound handler.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);

    // Two distinct api objects, each with its own `on` registry.
    const onSpy1 = vi.fn();
    const api1 = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: onSpy1,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    const onSpy2 = vi.fn();
    const api2 = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: onSpy2,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    plugin.register(api1);
    // api1 received typed-hook installs.
    const events1 = onSpy1.mock.calls.map((c: any) => c[0]);
    expect(events1).toContain('before_prompt_build');
    expect(events1).toContain('agent_end');

    // Multi-phase init: gateway hands a NEW api on the next register.
    plugin.register(api2);
    // api2 ALSO received typed-hook installs (not just the latest — both
    // are now live so whichever api the gateway dispatches against has
    // a bound wrapper).
    const events2 = onSpy2.mock.calls.map((c: any) => c[0]);
    expect(events2).toContain('before_prompt_build');
    expect(events2).toContain('agent_end');

    // Critically: api1's handlers were NOT torn down. The `allHookSurfaces`
    // set tracks both surfaces; a future emit against api1 would still
    // reach a live handler. We don't have an emit primitive in the mock
    // here, but the surface count is the load-bearing invariant.
    expect((plugin as any).allHookSurfaces.size).toBe(2);
  });

  it('T338 - typed fires on one multi-phase surface suppress sibling timeout warnings', async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    } as any);

    const makeApi = () => {
      const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
      const api = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: vi.fn(),
        registerMemoryCapability: vi.fn(),
        on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
          const existing = handlers.get(event) ?? [];
          existing.push(handler);
          handlers.set(event, existing);
        }),
        logger,
      } as unknown as OpenClawPluginApi;
      return { api, handlers };
    };

    const api1 = makeApi();
    const api2 = makeApi();
    const api3 = makeApi();

    try {
      plugin.register(api1.api);
      plugin.register(api2.api);
      plugin.register(api3.api);

      const writer = (plugin as any).chatTurnWriter;
      writer.onAgentEnd = vi.fn().mockResolvedValue(undefined);

      await api2.handlers.get('before_prompt_build')![0](
        { messages: [{ role: 'user', content: 'hello dkg' }] },
        { sessionKey: 's1' },
      );
      await api2.handlers.get('agent_end')![0](
        { messages: [{ role: 'user', content: 'hello dkg' }, { role: 'assistant', content: 'hi' }] },
        { sessionKey: 's1' },
      );

      await vi.advanceTimersByTimeAsync(30_000);

      const warnMessages = logger.warn.mock.calls.map((args) => String(args[0]));
      expect(warnMessages.filter((msg) => msg.includes('typed:before_prompt_build'))).toHaveLength(0);
      expect(warnMessages.filter((msg) => msg.includes('typed:agent_end'))).toHaveLength(0);
      expect(writer.onAgentEnd).toHaveBeenCalledTimes(1);

      const peerCommittedSurfaces = Array.from((plugin as any).allHookSurfaces).filter((surface: any) => {
        const stats = surface.getDispatchStats();
        return stats['typed:agent_end']?.commitState === 'committed-by-peer-fire';
      });
      expect(peerCommittedSurfaces.length).toBeGreaterThan(0);
    } finally {
      await plugin.stop();
      vi.useRealTimers();
    }
  });

  it('T338 - full-mode typed install failures still warn loudly', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    } as any);
    const api: any = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: vi.fn(),
      logger,
    };

    plugin.register(api);

    const warnMessages = logger.warn.mock.calls.map((args) => String(args[0]));
    expect(warnMessages.some((msg) => msg.includes('install FAILED: typed hook before_prompt_build'))).toBe(true);
    expect(warnMessages.some((msg) => msg.includes('install FAILED: typed hook agent_end'))).toBe(true);
    const stats = (plugin as any).hookSurface.getDispatchStats();
    expect(stats['typed:before_prompt_build']?.installedVia).toBe('none');
    expect(stats['typed:agent_end']?.installedVia).toBe('none');
  });

  it('T7 — session_end goes through HookSurface so stop() → register() does NOT accumulate handlers', async () => {
    // Regression for T7: pre-fix, `session_end` was registered via
    // direct `api.registerHook(...)` on every install. After
    // `stop() → register()` cycles, handlers accumulated in the
    // upstream registry (no unsubscribe primitive) and one shutdown
    // event would call `stop()` once per accumulated handler.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const registerHookSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: registerHookSpy,
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    plugin.register(mockApi);
    const sessionEndAfter1 = registerHookSpy.mock.calls.filter(
      (c: any) => c[0] === 'session_end',
    ).length;
    expect(sessionEndAfter1).toBe(1);

    // After stop() — the previously-registered session_end wrapper
    // is still in the upstream registry (no real unsubscribe), but
    // its destroyed-flag will short-circuit on fire (R21.1).
    await plugin.stop();
    plugin.register(mockApi);
    const sessionEndAfter2 = registerHookSpy.mock.calls.filter(
      (c: any) => c[0] === 'session_end',
    ).length;
    // Each register() call DOES make one new registerHook call (we
    // can't avoid that without an unsubscribe primitive), but the
    // OLD wrapper now short-circuits via its destroyed flag — so a
    // single shutdown event won't call this.stop() twice. The
    // important invariant: each register() makes exactly ONE new
    // registration, and prior wrappers are no-ops post-destroy.
    expect(sessionEndAfter2).toBe(2); // one per register, not unbounded
  });

  it('T12 — stop() resets promptSectionInstalled so a later register() reinstalls the section', async () => {
    // Regression for T12: pre-fix, `promptSectionInstalled` was a global
    // boolean on the plugin instance. After `stop() -> register()` (or
    // any api swap), the flag stayed `true` and the new gateway api
    // never received the DKG Memory prompt guidance.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const promptSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy,
    } as unknown as OpenClawPluginApi;

    plugin.register(mockApi);
    expect(promptSpy).toHaveBeenCalledTimes(1);

    await plugin.stop();
    plugin.register(mockApi);
    // Post-stop, the second register MUST install the section again
    // because the api registry was effectively reset by the stop+restart
    // cycle (and in production a different api object would be passed).
    expect(promptSpy).toHaveBeenCalledTimes(2);
  });

  it('T12 — apiChanged path resets promptSectionInstalled so the new api gets the section', () => {
    // Regression for T12: api swap (different api object on second
    // register) destroys the surface and rebuilds it, but pre-fix left
    // `promptSectionInstalled = true`, so the prompt section was
    // registered against the OLD api registry and never against the new.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const promptSpy1 = vi.fn();
    const api1: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy1,
    } as unknown as OpenClawPluginApi;
    plugin.register(api1);
    expect(promptSpy1).toHaveBeenCalledTimes(1);

    // Second register with a DIFFERENT api object (gateway swapped registry).
    const promptSpy2 = vi.fn();
    const api2: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy2,
    } as unknown as OpenClawPluginApi;
    plugin.register(api2);
    // The new api MUST get the section installed against its own registry.
    expect(promptSpy2).toHaveBeenCalledTimes(1);
  });

  it('T13 — auto-recall single-flight: a second turn fired while the first is in flight skips recall', async () => {
    // Regression for T13: pre-fix, the 250ms `Promise.race` timeout in
    // `handleBeforePromptBuild` only stopped *waiting*; the underlying
    // SPARQL fan-out kept running. Successive turns fired during a slow
    // daemon would all start their own searches, amplifying load.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: vi.fn(),
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    // Stub the daemon so searchNarrow's underlying queries hang until
    // we explicitly release them. Track ALL pending resolvers so a
    // single release call clears every in-flight query (the searchNarrow
    // fan-out issues multiple queries per call).
    const client = (plugin as any).client;
    let queryCalls = 0;
    const pendingResolvers: Array<() => void> = [];
    client.query = vi.fn().mockImplementation(async () => {
      queryCalls++;
      await new Promise<void>((resolve) => { pendingResolvers.push(resolve); });
      return { results: { bindings: [] } };
    });
    const releaseQueries = () => { while (pendingResolvers.length) pendingResolvers.shift()!(); };
    // Give the manager a peer ID so the recall preflight doesn't early-return.
    // T31 — Resolver returns `nodeAgentAddress` (eth) instead of `nodePeerId`.
    (plugin as any).nodeAgentAddress = '0xabcabcabcabcabcabcabcabcabcabcabcabcabcd';

    const event = { messages: [{ role: 'user', content: 'find something interesting' }] };
    const ctx = { sessionKey: 'test-session-1' };

    // Turn 1: hangs in searchNarrow, returns undefined after 250ms timeout.
    const turn1 = (plugin as any).handleBeforePromptBuild(event, ctx);
    // Wait for the timeout race to settle (~300ms).
    await new Promise((r) => setTimeout(r, 300));
    const result1 = await turn1;
    expect(result1).toBeUndefined();
    const queriesAfterTurn1 = queryCalls;
    expect(queriesAfterTurn1).toBeGreaterThan(0); // some queries fired

    // Turn 2: fires while turn 1's underlying queries still hang. The
    // single-flight guard MUST short-circuit before manager.searchNarrow
    // runs again, so queryCalls does NOT increase.
    const result2 = await (plugin as any).handleBeforePromptBuild(event, ctx);
    expect(result2).toBeUndefined();
    expect(queryCalls).toBe(queriesAfterTurn1); // no new queries

    // Release turn 1's hanging queries so the in-flight set clears.
    releaseQueries();
    // Wait for the underlying promise's finally hook to clear the
    // single-flight reservation. Two macrotask hops are enough — first
    // resolves the inner queries, second runs the .finally cleanup.
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 50));

    // Turn 3: fires AFTER turn 1 settled. Single-flight has cleared; new
    // queries fire as normal.
    const result3 = await (plugin as any).handleBeforePromptBuild(event, ctx);
    expect(queryCalls).toBeGreaterThan(queriesAfterTurn1);

    await plugin.stop();
  });

  it('T20 — single-flight key includes projectContextGraphId; switching projects mid-conversation does NOT block recall under the old key', async () => {
    // Regression for T20: pre-fix, the single-flight key only included
    // the conversation tuple. searchNarrow's fan-out scopes through
    // the resolver's projectContextGraphId, so two recalls in the same
    // conversation but for DIFFERENT projects are semantically distinct
    // queries. If a slow recall for project A hung and the user
    // switched to project B in the same conversation, project B's
    // recall would be falsely suppressed under A's key.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: vi.fn(),
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    const client = (plugin as any).client;
    let queryCalls = 0;
    const pendingResolvers: Array<() => void> = [];
    client.query = vi.fn().mockImplementation(async () => {
      queryCalls++;
      await new Promise<void>((resolve) => { pendingResolvers.push(resolve); });
      return { results: { bindings: [] } };
    });
    // T31 — Resolver returns `nodeAgentAddress` (eth) instead of `nodePeerId`.
    (plugin as any).nodeAgentAddress = '0xabcabcabcabcabcabcabcabcabcabcabcabcabcd';

    // Stub the resolver so we can flip the resolved project mid-test.
    let currentProject = 'project-A';
    (plugin as any).memorySessionResolver = {
      getSession: () => ({ projectContextGraphId: currentProject, agentAddress: '12D3KooWTestT20' }),
      getDefaultAgentAddress: () => '12D3KooWTestT20',
      listAvailableContextGraphs: () => [],
    };

    const event = { messages: [{ role: 'user', content: 'find x' }] };
    const ctx = { channelId: 'tg', accountId: 'a', conversationId: 'c', sessionKey: 'sk' };

    // Turn 1: project A — recall hangs.
    const turn1 = (plugin as any).handleBeforePromptBuild(event, ctx);
    await new Promise((r) => setTimeout(r, 300));
    await turn1;
    const queriesAfterA = queryCalls;
    expect(queriesAfterA).toBeGreaterThan(0);

    // User switches to project B in the SAME conversation.
    currentProject = 'project-B';

    // Turn 2: same ctx, different project. Pre-fix, the in-flight key
    // ignored project, so this would be suppressed. Post-fix, the
    // key includes projectCG, so B issues fresh queries.
    const turn2 = (plugin as any).handleBeforePromptBuild(event, ctx);
    await new Promise((r) => setTimeout(r, 300));
    await turn2;
    expect(queryCalls).toBeGreaterThan(queriesAfterA);

    // Cleanup.
    while (pendingResolvers.length) pendingResolvers.shift()!();
    await new Promise((r) => setTimeout(r, 50));
    await plugin.stop();
  });

  it('T29 — runtime.state.resolveStateDir() returning the gateway homedir root is rejected; resolver falls through to workspace-derived branches', async () => {
    // Regression for an OpenClaw 2026.4.15 misbehavior observed in
    // production: the gateway's `runtime.state.resolveStateDir()`
    // returns the gateway's own `~/.openclaw` config root, which is
    // NOT workspace-scoped. Pre-fix the resolver trusted that value
    // (highest-priority branch) and wrote per-workspace chat-turn
    // watermarks into the shared homedir, conflating workspaces. The
    // T29 filter rejects values canonicalizing to the gateway homedir
    // and falls through to workspace-derived branches.
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const tmpRoot = require('os').tmpdir();
    const workspaceDir = path.join(tmpRoot, `dkg-t29-workspace-${Date.now()}`);
    const homeDir = path.join(require('os').homedir(), '.openclaw');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
        // Setup-default path pointing at the legacy `<workspace>/.openclaw`
        // location — exercises the redirect-to-`.dkg-adapter` branch
        // so we can verify the workspace-derived path wins after
        // T29 ignores the gateway's homedir runtime stateDir.
        stateDir: path.join(workspaceDir, '.openclaw'),
        stateDirSource: 'setup-default',
        installedWorkspace: workspaceDir,
      } as any);
      const api: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        workspaceDir,
        runtime: {
          state: {
            // Gateway homedir — must NOT be honored as the chat-turn
            // state dir even though it's the highest-priority branch.
            resolveStateDir: () => homeDir,
          },
        },
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(api);
      // Resolver must NOT pick the homedir; it should fall through to
      // the workspace branch (api.workspaceDir + .dkg-adapter).
      const resolved = (plugin as any).chatTurnWriterStateDir as string;
      expect(resolved.replace(/\\/g, '/')).toBe(
        path.join(workspaceDir, '.dkg-adapter').replace(/\\/g, '/'),
      );
      expect((plugin as any).chatTurnWriterStateDirSource).toBe('workspace');
      // No homedir-fallback warning emitted (the resolver picked a
      // proper workspace-scoped branch).
      const homedirWarnCall = (api.logger.warn as any).mock.calls.find((args: any[]) =>
        typeof args[0] === 'string' && args[0].includes('Could not resolve a workspace-scoped state dir'),
      );
      expect(homedirWarnCall).toBeUndefined();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
    }
  });

  it('T24 — chatTurnWriterStateDir is updated ONLY on successful migration; failure leaves state at fallback so future register() retries', async () => {
    // Regression for T24: pre-fix, `chatTurnWriterStateDir = stateDir`
    // was set BEFORE the async migration completed. If `setStateDir`
    // failed (e.g., transient FS error), the field was already updated
    // and the next register() with the same target stateDir
    // short-circuited under the "same path" guard — never retrying.
    // Post-fix the field flips ONLY on success; failure clears the
    // separate `chatTurnWriterMigrationTarget` flag and leaves
    // `chatTurnWriterStateDir` at the old value.
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const tmpRoot = require('os').tmpdir();
    const workspaceDir = path.join(tmpRoot, `dkg-t24-workspace-${Date.now()}`);
    const homeDir = path.join(require('os').homedir(), '.openclaw');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const apiFallback: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiFallback);
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(homeDir.replace(/\\/g, '/'));

      // Force setStateDir to fail.
      const writer = (plugin as any).chatTurnWriter;
      const originalSetStateDir = writer.setStateDir.bind(writer);
      writer.setStateDir = vi.fn().mockRejectedValue(new Error('simulated migration failure'));

      const apiBetter: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(apiBetter);

      // Wait for the fire-and-forget setStateDir to reject.
      await new Promise((r) => setTimeout(r, 50));

      // Failure: migration target cleared, but stateDir stays at fallback.
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(homeDir.replace(/\\/g, '/'));
      expect((plugin as any).chatTurnWriterMigrationTarget).toBe(null);

      // A second register() with the SAME apiBetter MUST re-trigger the
      // migration (proves the failure didn't poison the retry path).
      writer.setStateDir = vi.fn().mockImplementation(originalSetStateDir);
      plugin.register(apiBetter);
      // The migration was triggered again — `chatTurnWriterMigrationTarget`
      // should be set during the in-flight async work.
      const target = (plugin as any).chatTurnWriterMigrationTarget;
      expect(target?.replace(/\\/g, '/')).toBe(workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter');
      // Wait for retry to settle.
      await new Promise((r) => setTimeout(r, 50));
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter',
      );
    } finally {
      if (prevEnv !== undefined) process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T18/T21 — ensureChatTurnWriter migrates writer in-place via setStateDir when a better stateDir becomes available', async () => {
    // Regression for T18: pre-fix, once `chatTurnWriter` was constructed
    // with the home-dir fallback (because setup-runtime register had
    // no workspaceDir / resolveStateDir wired yet), it stayed pinned
    // forever.
    // Regression for T21: an earlier T18 fix REBUILT the writer and
    // used `flushSync()` which doesn't await in-flight persists/resets
    // — losing or duplicating turns mid-rebuild. Post-fix, the writer
    // is migrated IN-PLACE via `setStateDir` which `await flush()`s
    // before swapping paths.
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const tmpRoot = require('os').tmpdir();
    const workspaceDir = path.join(tmpRoot, `dkg-t18-workspace-${Date.now()}`);
    const homeDir = path.join(require('os').homedir(), '.openclaw');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const apiFallback: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiFallback);
      const writer1 = (plugin as any).chatTurnWriter;
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(homeDir.replace(/\\/g, '/'));

      // Second register with workspaceDir → triggers in-place migration.
      const apiBetter: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(apiBetter);
      const writer2 = (plugin as any).chatTurnWriter;
      // SAME instance — migration is in-place (preserves in-flight state).
      expect(writer2).toBe(writer1);
      // T24 — `chatTurnWriterStateDir` is updated ONLY on successful
      // migration. While the async `setStateDir` is in flight,
      // `chatTurnWriterMigrationTarget` reflects the target.
      expect((plugin as any).chatTurnWriterMigrationTarget?.replace(/\\/g, '/')).toBe(
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter',
      );
      // Wait for the fire-and-forget setStateDir to complete.
      await new Promise((r) => setTimeout(r, 100));
      // After success, chatTurnWriterStateDir flips and migration
      // target clears.
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter',
      );
      expect((plugin as any).chatTurnWriterMigrationTarget).toBe(null);
      const path2 = (writer2 as any).watermarkFilePath as string;
      expect(path2.replace(/\\/g, '/')).toContain(
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter/chat-turn-watermarks.json',
      );
    } finally {
      if (prevEnv !== undefined) process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T14 — single-flight key is per-conversation; a slow recall in one conversation does NOT block recall in a sibling conversation under the same sessionKey', async () => {
    // Regression for T14: pre-fix, single-flight was keyed on raw
    // `ctx.sessionKey`. Channels can multiplex several conversations
    // under one sessionKey (the same composition that ChatTurnWriter
    // uses for its FIFO queues), so a slow recall in conversation A
    // would suppress recall in unrelated conversation B. Post-fix,
    // the key is composed of channelId + accountId + conversationId +
    // sessionKey so siblings stay independent.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: vi.fn(),
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    const client = (plugin as any).client;
    let queryCalls = 0;
    const pendingResolvers: Array<() => void> = [];
    client.query = vi.fn().mockImplementation(async () => {
      queryCalls++;
      await new Promise<void>((resolve) => { pendingResolvers.push(resolve); });
      return { results: { bindings: [] } };
    });
    // T31 — Resolver returns `nodeAgentAddress` (eth) instead of `nodePeerId`.
    (plugin as any).nodeAgentAddress = '0xabcabcabcabcabcabcabcabcabcabcabcabcabcd';

    const event = { messages: [{ role: 'user', content: 'find something' }] };
    // Two ctx values share the SAME sessionKey but differ on
    // conversationId — exactly the scenario T14 flags.
    const ctxA = { channelId: 'tg', accountId: 'bot', conversationId: 'chat-A', sessionKey: 'shared-sk' };
    const ctxB = { channelId: 'tg', accountId: 'bot', conversationId: 'chat-B', sessionKey: 'shared-sk' };

    // Conversation A: hangs in searchNarrow.
    const turnA = (plugin as any).handleBeforePromptBuild(event, ctxA);
    await new Promise((r) => setTimeout(r, 300));
    await turnA;
    const queriesAfterA = queryCalls;
    expect(queriesAfterA).toBeGreaterThan(0);

    // Conversation B fires while A still has queries in flight. With
    // the per-conversation key, B MUST issue its own queries (not be
    // blocked by A's reservation under the shared sessionKey).
    const turnB = (plugin as any).handleBeforePromptBuild(event, ctxB);
    await new Promise((r) => setTimeout(r, 300));
    await turnB;
    expect(queryCalls).toBeGreaterThan(queriesAfterA);

    // Cleanup.
    while (pendingResolvers.length) pendingResolvers.shift()!();
    await new Promise((r) => setTimeout(r, 50));
    await plugin.stop();
  });

  it('R23.2 — stop() nulls out hookSurface refs so a later register() rebuilds the surface', async () => {
    // Regression for R23.2: pre-fix, stop() called hookSurface.destroy()
    // but left this.hookSurface and this.hookSurfaceApi populated.
    // A later register() on the same plugin instance with the same api
    // hit the existing-surface fast path in installHooksIfNeeded() and
    // skipped reinstalling hooks. The old surface is permanently inert
    // (destroyed=true), so W3 / W4a / W4b would silently never re-install.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const onSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: onSpy,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    // Initial register installed hooks.
    expect((plugin as any).hookSurface).not.toBeNull();
    const onCallCountAfterInitial = onSpy.mock.calls.length;
    expect(onCallCountAfterInitial).toBeGreaterThan(0);

    // Shutdown.
    await plugin.stop();
    // The hookSurface refs MUST be cleared by stop().
    expect((plugin as any).hookSurface).toBeNull();
    expect((plugin as any).hookSurfaceApi).toBeNull();

    // Re-register on the same plugin instance.
    plugin.register(mockApi);
    // Hooks must have been reinstalled — api.on count goes up.
    expect(onSpy.mock.calls.length).toBeGreaterThan(onCallCountAfterInitial);
    expect((plugin as any).hookSurface).not.toBeNull();
  });

  it('R17.2 — setup-only → full re-entry constructs ChatTurnWriter and installs hooks', () => {
    // Regression for the qa-engineer-flagged R17.2 follow-up: the
    // first `setup-only` call correctly skips ChatTurnWriter construction
    // (no FS work in metadata-only mode), but the SECOND call (full)
    // must then construct it before installHooksIfNeeded runs —
    // otherwise installHooksIfNeeded's `if (!this.chatTurnWriter) return`
    // guard silently no-ops and W3 / W4a / W4b never wire up.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true },
      memory: { enabled: true },
    });
    const onSpy = vi.fn();
    const setupOnlyApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-only',
      registerTool: () => {},
      registerHook: () => {},
      on: onSpy,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    plugin.register(setupOnlyApi);
    // Tick 1: setup-only — no ChatTurnWriter, no hooks.
    expect((plugin as any).chatTurnWriter).toBeNull();
    expect(onSpy).not.toHaveBeenCalled();

    // Tick 2: full — must construct ChatTurnWriter AND install hooks.
    const fullApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: onSpy,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    plugin.register(fullApi);
    expect((plugin as any).chatTurnWriter).not.toBeNull();
    // At least one typed hook (`before_prompt_build` or `agent_end`)
    // must have been registered against the now-full api.
    const typedHookEvents = onSpy.mock.calls.map((c: any[]) => c[0]);
    expect(typedHookEvents).toContain('before_prompt_build');
    expect(typedHookEvents).toContain('agent_end');
  });

  it('T359 - only supported typed agent_end plus internal message hooks are wired to ChatTurnWriter', async () => {
    const previousHookMap = (globalThis as any)[INTERNAL_HOOK_SYMBOL];
    (globalThis as any)[INTERNAL_HOOK_SYMBOL] = new Map<string, any[]>([
      ['message:received', []],
      ['message:sent', []],
    ]);
    const workspaceDir = fs.mkdtempSync(path.join(tmpdir(), 'dkg-node-t359-typed-'));
    const typedHandlers = new Map<string, (...args: any[]) => unknown>();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        typedHandlers.set(event, handler);
      }) as any,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      workspaceDir,
    } as unknown as OpenClawPluginApi;

    try {
      plugin.register(mockApi);
      const client = (plugin as any).client;
      client.storeChatTurn = vi.fn().mockResolvedValue(undefined);

      expect(typedHandlers.has('agent_end')).toBe(true);
      expect(typedHandlers.has('agent.end')).toBe(false);
      expect(typedHandlers.has('message_received')).toBe(false);
      expect(typedHandlers.has('message_sent')).toBe(false);
      expect(typedHandlers.has('message.received')).toBe(false);
      expect(typedHandlers.has('message.sent')).toBe(false);

      typedHandlers.get('agent_end')!(
        { messages: [{ role: 'user', content: 'healthy q' }, { role: 'assistant', content: 'healthy a' }] },
        { channelId: 'telegram', sessionKey: 'healthy-sk' },
      );
      await (plugin as any).chatTurnWriter.flush();
      expect(client.storeChatTurn).toHaveBeenCalledTimes(1);

      const hookMap = (globalThis as any)[INTERNAL_HOOK_SYMBOL] as Map<string, any[]>;
      hookMap.get('message:received')![0]({
        sessionKey: 'internal-sk',
        context: { channelId: 'telegram', conversationId: 'chat-1', content: 'internal q' },
      });
      await hookMap.get('message:sent')![0]({
        sessionKey: 'internal-sk',
        context: { channelId: 'telegram', conversationId: 'chat-1', content: 'internal a', success: true },
      });
      await (plugin as any).chatTurnWriter.flush();
      expect(client.storeChatTurn).toHaveBeenCalledTimes(2);
      expect(client.storeChatTurn.mock.calls[1][1]).toBe('internal q');
      expect(client.storeChatTurn.mock.calls[1][2]).toBe('internal a');
    } finally {
      await plugin.stop();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      if (previousHookMap === undefined) delete (globalThis as any)[INTERNAL_HOOK_SYMBOL];
      else (globalThis as any)[INTERNAL_HOOK_SYMBOL] = previousHookMap;
    }
  });

  it('T359 - gateway-preloaded internal handlers do not suppress adapter handlers', async () => {
    const previousHookMap = (globalThis as any)[INTERNAL_HOOK_SYMBOL];
    const hookMap = new Map<string, any[]>([
      ['message:received', [vi.fn()]],
      ['message:sent', [vi.fn()]],
    ]);
    (globalThis as any)[INTERNAL_HOOK_SYMBOL] = hookMap;
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    try {
      plugin.register(mockApi);
      expect(hookMap.get('message:received')).toHaveLength(2);
      expect(hookMap.get('message:sent')).toHaveLength(2);
    } finally {
      await plugin.stop();
      if (previousHookMap === undefined) delete (globalThis as any)[INTERNAL_HOOK_SYMBOL];
      else (globalThis as any)[INTERNAL_HOOK_SYMBOL] = previousHookMap;
    }
  });

  it('T359 - replacing the internal hook map triggers same-api reinstall', async () => {
    const previousHookMap = (globalThis as any)[INTERNAL_HOOK_SYMBOL];
    const firstMap = new Map<string, any[]>([
      ['message:received', []],
      ['message:sent', []],
    ]);
    (globalThis as any)[INTERNAL_HOOK_SYMBOL] = firstMap;
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    try {
      plugin.register(mockApi);
      expect(firstMap.get('message:received')).toHaveLength(1);
      expect(firstMap.get('message:sent')).toHaveLength(1);

      const replacementMap = new Map<string, any[]>([
        ['message:received', []],
        ['message:sent', []],
      ]);
      (globalThis as any)[INTERNAL_HOOK_SYMBOL] = replacementMap;
      plugin.register(mockApi);
      expect(replacementMap.get('message:received')).toHaveLength(1);
      expect(replacementMap.get('message:sent')).toHaveLength(1);
    } finally {
      await plugin.stop();
      if (previousHookMap === undefined) delete (globalThis as any)[INTERNAL_HOOK_SYMBOL];
      else (globalThis as any)[INTERNAL_HOOK_SYMBOL] = previousHookMap;
    }
  });

  it('R14.3 / T52 / T58 — setup-only registers only session_end (no channel server, no typed/internal hooks)', () => {
    // R14.3: setup-only must NOT wire prompt-injection / turn-
    // persistence handlers (`before_prompt_build`, `agent_end`,
    // `message:received`, `message:sent`).
    //
    // T52: `session_end` legacy cleanup STILL installs so that any
    // future runtime upgrade has a deterministic shutdown path.
    //
    // T58: `registerIntegrationModules` no longer brings up the
    // channel HTTP server in setup-only — the documented
    // metadata-only contract is honored. Channel registration is
    // deferred to the runtime-enabled re-entry.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true },
      memory: { enabled: true },
    });
    const onSpy = vi.fn();
    const registerHookSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-only',
      registerTool: () => {},
      registerHook: registerHookSpy,
      on: onSpy,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    plugin.register(mockApi);
    // T52 — Surface MUST exist (session_end is the cleanup anchor).
    expect((plugin as any).hookSurface).not.toBeNull();
    // R14.3 — No typed-hook installs may have called api.on.
    expect(onSpy).not.toHaveBeenCalled();
    // T52 — `session_end` MUST be the only legacy registerHook call.
    expect(registerHookSpy).toHaveBeenCalledTimes(1);
    expect(registerHookSpy.mock.calls[0][0]).toBe('session_end');
    // T58 — Channel must NOT have started in setup-only mode.
    expect((plugin as any).channelPlugin).toBeFalsy();
  });

  it('T59 — setup-only → full upgrade on the same api installs runtime hooks (W3/W4) on re-entry', () => {
    // T59: pre-fix the same-api retry path required `installedVia ===
    // 'none'` (an explicit failure record) to fire a re-install. In
    // setup-only the runtime hooks were never attempted, so their
    // stats keys were absent — the retry predicate evaluated
    // `undefined?.installedVia === 'none'` as false and the
    // setup-only → full upgrade left W3/W4/internal permanently
    // uninstalled. Post-fix the predicate treats `stats[key] ===
    // undefined` as a first-time install when the dispatch primitive
    // is now available.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    });
    const onSpy = vi.fn();
    const registerHookSpy = vi.fn();
    const mockApi: any = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'setup-only',
      registerTool: () => {},
      registerHook: registerHookSpy,
      registerMemoryCapability: () => {},
      on: onSpy,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    // First register: setup-only — no W3/W4/internal installs.
    plugin.register(mockApi);
    expect(onSpy).not.toHaveBeenCalled();
    expect(registerHookSpy).toHaveBeenCalledTimes(1);
    expect(registerHookSpy.mock.calls[0][0]).toBe('session_end');

    // Re-register on the SAME api with mode flipped to full. T59
    // guarantees this path installs the typed hooks even though
    // their stats keys are absent (never attempted in setup-only).
    mockApi.registrationMode = 'full';
    plugin.register(mockApi);

    // api.on MUST have been called for each typed hook now.
    const typedEvents = onSpy.mock.calls.map((c: any[]) => c[0]);
    expect(typedEvents).toContain('before_prompt_build');
    expect(typedEvents).toContain('agent_end');
    expect(typedEvents).toContain('before_compaction');
    expect(typedEvents).toContain('before_reset');
  });

  it('marks session_end and internal message hooks as rare-fire so startup timeout diagnostics stay quiet', async () => {
    vi.useFakeTimers();
    const previousHookMap = (globalThis as any)[INTERNAL_HOOK_SYMBOL];
    (globalThis as any)[INTERNAL_HOOK_SYMBOL] = new Map();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: vi.fn(),
      on: vi.fn(),
      logger,
    };

    try {
      plugin.register(mockApi);
      await vi.advanceTimersByTimeAsync(30_000);

      const debugMessages = logger.debug.mock.calls.map((args) => String(args[0]));
      const warnMessages = logger.warn.mock.calls.map((args) => String(args[0]));
      expect(debugMessages.some((msg) => msg.includes("legacy:session_end"))).toBe(true);
      expect(debugMessages.some((msg) => msg.includes("internal:message:received"))).toBe(true);
      expect(debugMessages.some((msg) => msg.includes("internal:message:sent"))).toBe(true);
      expect(debugMessages.some((msg) => msg.includes("typed:before_compaction"))).toBe(true);
      expect(debugMessages.some((msg) => msg.includes("typed:before_reset"))).toBe(true);
      expect(warnMessages.some((msg) => msg.includes("legacy:session_end"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("internal:message:received"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("internal:message:sent"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("typed:before_compaction"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("typed:before_reset"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("typed:agent_end"))).toBe(false);
      expect(debugMessages.some((msg) => msg.includes("typed:agent_end"))).toBe(true);
    } finally {
      await plugin.stop();
      if (previousHookMap === undefined) {
        delete (globalThis as any)[INTERNAL_HOOK_SYMBOL];
      } else {
        (globalThis as any)[INTERNAL_HOOK_SYMBOL] = previousHookMap;
      }
      vi.useRealTimers();
    }
  });

  it('R14.2 — handleBeforePromptBuild returns undefined when memoryPlugin exists but is not registered (slot owned by another plugin)', async () => {
    // Regression for R14.2: when `plugins.slots.memory` points at a
    // different plugin, `DkgMemoryPlugin.register()` returns false and
    // `registeredCapability` stays null. The before_prompt_build hook
    // must short-circuit instead of injecting DKG recall on top of the
    // elected provider's prompt.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const mockApi: OpenClawPluginApi = {
      // No `plugins.slots.memory` set → registerCapability returns false
      // → isRegistered() === false.
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);

    // memoryPlugin must exist — module is enabled — but it must NOT be
    // registered, because the slot points elsewhere.
    expect((plugin as any).memoryPlugin).not.toBeNull();
    expect((plugin as any).memoryPlugin.isRegistered()).toBe(false);

    const result = await (plugin as any).handleBeforePromptBuild(
      { messages: [{ role: 'user', content: 'tatooine suns' }] },
      { sessionKey: 'sk' },
    );
    expect(result).toBeUndefined();
  });

  it('T26 — empty / whitespace-only OPENCLAW_STATE_DIR does NOT short-circuit the fallback chain', () => {
    // Regression for T26: pre-fix the `??` chain treated empty strings
    // as real values, so `OPENCLAW_STATE_DIR=''` (or whitespace-only)
    // bypassed `api.workspaceDir` and `~/.openclaw` and the writer
    // ended up writing `./dkg-adapter/chat-turn-watermarks.json` from
    // the process CWD — silent state leak across workspaces.
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = '';   // empty
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir: '/tmp/dkg-t26-workspace',
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const ctw = (plugin as any).chatTurnWriter;
      const watermarkPath: string = (ctw as any).watermarkFilePath;
      const normalized = watermarkPath.replace(/\\/g, '/');
      // Must have fallen through empty env to workspaceDir-derived path.
      expect(normalized).toContain('/tmp/dkg-t26-workspace/.dkg-adapter/chat-turn-watermarks.json');
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
    }

    // Whitespace-only also normalizes to "missing".
    process.env.OPENCLAW_STATE_DIR = '   ';
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir: '/tmp/dkg-t26-workspace-ws',
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        '/tmp/dkg-t26-workspace-ws/.dkg-adapter/chat-turn-watermarks.json',
      );
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
    }
  });

  it('R16.2 — chat-turn watermark stateDir prefers api.workspaceDir over ~/.openclaw fallback', () => {
    // Regression for R16.2: previously the stateDir fallback chain went
    // straight to `~/.openclaw` when `runtime.state.resolveStateDir()` and
    // `OPENCLAW_STATE_DIR` were both absent, so two workspaces on the
    // same machine would share `chat-turn-watermarks.json`. The new
    // fallback prefers the workspace-local `.dkg-adapter` default when present.
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir: '/tmp/dkg-r162-workspace',
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const ctw = (plugin as any).chatTurnWriter;
      expect(ctw).toBeDefined();
      // ChatTurnWriter stores setup/workspace default watermarks directly
      // under `.dkg-adapter`, without the legacy nested subdirectory.
      const watermarkPath: string = (ctw as any).watermarkFilePath;
      // Normalize separators for cross-platform path comparison (Windows
      // path.join produces backslashes from a forward-slash workspaceDir).
      const normalized = watermarkPath.replace(/\\/g, '/');
      expect(normalized).toContain('/tmp/dkg-r162-workspace/.dkg-adapter/chat-turn-watermarks.json');
      // Must NOT have fallen back to the home dir.
      expect(normalized).not.toContain(homedir().replace(/\\/g, '/') + '/.openclaw/dkg-adapter');
      // The home-dir fallback warn must NOT have fired.
      const warnSpy = mockApi.logger.warn as any;
      const homeFallbackWarn = warnSpy.mock.calls.find((c: any[]) =>
        String(c[0] ?? '').includes('Could not resolve a workspace-scoped state dir'),
      );
      expect(homeFallbackWarn).toBeUndefined();
    } finally {
      if (prevEnv !== undefined) process.env.OPENCLAW_STATE_DIR = prevEnv;
    }
  });

  it('T75 - configured stateDir is used and suppresses the home-fallback warning', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const stateDir = path.join(require('os').tmpdir(), `dkg-t75-config-state-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const warn = vi.fn();
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn, debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        stateDir.replace(/\\/g, '/') + '/dkg-adapter/chat-turn-watermarks.json',
      );
      expect(warn.mock.calls.some((c: any[]) =>
        String(c[0] ?? '').includes('Could not resolve a workspace-scoped state dir'),
      )).toBe(false);
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - blank configured stateDir is ignored and falls through to api.workspaceDir', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-workspace-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: '   ',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - explicit configured stateDir overrides api.workspaceDir', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-current-workspace-${Date.now()}`);
    const configStateDir = path.join(require('os').tmpdir(), `dkg-t75-custom-config-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: configStateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        configStateDir.replace(/\\/g, '/') + '/dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(configStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - api.workspaceDir overrides setup-owned configured stateDir to avoid stale defaults', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-current-workspace-${Date.now()}`);
    const staleInstalledWorkspace = path.join(require('os').tmpdir(), `dkg-t75-stale-workspace-${Date.now()}`);
    const staleConfigStateDir = path.join(staleInstalledWorkspace, '.openclaw');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace: staleInstalledWorkspace,
        stateDir: staleConfigStateDir,
        stateDirSource: 'setup-default',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter/chat-turn-watermarks.json',
      );
      expect(watermarkPath.replace(/\\/g, '/')).not.toContain(staleConfigStateDir.replace(/\\/g, '/'));
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(staleInstalledWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - stale setup-owned marker does not override a configured custom stateDir', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const installedWorkspace = path.join(require('os').tmpdir(), `dkg-t75-installed-workspace-${Date.now()}`);
    const configuredStateDir = path.join(require('os').tmpdir(), `dkg-t75-custom-with-stale-marker-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace,
        stateDir: configuredStateDir,
        stateDirSource: 'setup-default',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const targetStateDir = path.join(installedWorkspace, '.dkg-adapter');
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        configuredStateDir.replace(/\\/g, '/'),
      );
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(configuredStateDir, 'dkg-adapter', 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(watermarkPath.replace(/\\/g, '/')).not.toContain(targetStateDir.replace(/\\/g, '/'));
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(installedWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(configuredStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - stale setup-owned marker does not make custom .dkg-adapter config direct', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const installedWorkspace = path.join(require('os').tmpdir(), `dkg-t75-installed-marker-${Date.now()}`);
    const customWorkspace = path.join(require('os').tmpdir(), `dkg-t75-custom-marker-${Date.now()}`);
    const configuredStateDir = path.join(customWorkspace, '.dkg-adapter');
    const legacyFile = path.join(customWorkspace, '.openclaw', 'dkg-adapter', 'chat-turn-watermarks.json');
    try {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        'openclaw:tg:::stale-marker': { w: 8, b: 2 },
      }));
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace,
        stateDir: configuredStateDir,
        stateDirSource: 'setup-default',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(configuredStateDir, 'dkg-adapter', 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(configuredStateDir, 'chat-turn-watermarks.json'))).toBe(false);
      expect(fs.existsSync(legacyFile)).toBe(true);
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(installedWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(customWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - config stateDir matching installedWorkspace default is explicit without setup marker', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-current-explicit-default-${Date.now()}`);
    const configuredWorkspace = path.join(require('os').tmpdir(), `dkg-t75-explicit-default-${Date.now()}`);
    const configuredStateDir = path.join(configuredWorkspace, '.openclaw');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace: configuredWorkspace,
        stateDir: configuredStateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        configuredStateDir.replace(/\\/g, '/') + '/dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(configuredWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - OPENCLAW_STATE_DIR pointing at .dkg-adapter uses direct layout and migrates sibling legacy state', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-env-direct-${Date.now()}`);
    const stateDir = path.join(workspaceDir, '.dkg-adapter');
    const legacyFile = path.join(workspaceDir, '.openclaw', 'dkg-adapter', 'chat-turn-watermarks.json');
    try {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        'openclaw:tg:::env-direct': { w: 7, b: 3 },
      }));
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(stateDir, 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(stateDir, 'dkg-adapter', 'chat-turn-watermarks.json'))).toBe(false);
      const persisted = JSON.parse(fs.readFileSync(watermarkPath, 'utf8'));
      expect(persisted['openclaw:tg:::env-direct']).toEqual({ w: 7, b: 3 });
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - user-owned config.stateDir matching installedWorkspace .dkg-adapter keeps nested layout', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-config-direct-${Date.now()}`);
    const stateDir = path.join(workspaceDir, '.dkg-adapter');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace: workspaceDir,
        stateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(stateDir, 'dkg-adapter', 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(stateDir, 'chat-turn-watermarks.json'))).toBe(false);
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - OPENCLAW_STATE_DIR ending .dkg-adapter migrates sibling legacy state from env-derived workspace', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-env-no-workspace-${Date.now()}`);
    const stateDir = path.join(workspaceDir, '.dkg-adapter');
    const legacyFile = path.join(workspaceDir, '.openclaw', 'dkg-adapter', 'chat-turn-watermarks.json');
    try {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        'openclaw:tg:::env-untrusted': { w: 9, b: 4 },
      }));
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(stateDir, 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(stateDir, 'dkg-adapter', 'chat-turn-watermarks.json'))).toBe(false);
      const persisted = JSON.parse(fs.readFileSync(watermarkPath, 'utf8'));
      expect(persisted['openclaw:tg:::env-untrusted']).toEqual({ w: 9, b: 4 });
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - user-owned config.stateDir ending .dkg-adapter does not migrate sibling legacy state', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-custom-dkg-adapter-${Date.now()}`);
    const stateDir = path.join(workspaceDir, '.dkg-adapter');
    const legacyFile = path.join(workspaceDir, '.openclaw', 'dkg-adapter', 'chat-turn-watermarks.json');
    try {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        'openclaw:tg:::unrelated': { w: 4, b: 1 },
      }));
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(stateDir, 'dkg-adapter', 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(stateDir, 'chat-turn-watermarks.json'))).toBe(false);
      expect(fs.existsSync(legacyFile)).toBe(true);
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - setup-owned configured stateDir migrates when api.workspaceDir appears later', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const staleInstalledWorkspace = path.join(require('os').tmpdir(), `dkg-t75-stale-first-${Date.now()}`);
    const staleConfigStateDir = path.join(staleInstalledWorkspace, '.openclaw');
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-current-later-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace: staleInstalledWorkspace,
        stateDir: staleConfigStateDir,
        stateDirSource: 'setup-default',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const apiWithoutWorkspace: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWithoutWorkspace);
      const writer = (plugin as any).chatTurnWriter;
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        path.join(staleInstalledWorkspace, '.dkg-adapter').replace(/\\/g, '/'),
      );

      const setStateDirSpy = vi.spyOn(writer, 'setStateDir');
      const apiWithWorkspace: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWithWorkspace);
      const targetStateDir = path.join(workspaceDir, '.dkg-adapter');
      expect(setStateDirSpy).toHaveBeenCalledWith(targetStateDir, expect.objectContaining({ stateLayout: 'direct' }));
      expect((plugin as any).chatTurnWriter).toBe(writer);

      await new Promise((r) => setTimeout(r, 100));
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        targetStateDir.replace(/\\/g, '/'),
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(staleInstalledWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - in-flight stateDir migration guard canonicalizes target aliases', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const realWorkspace = path.join(require('os').tmpdir(), `dkg-t75-real-migration-${Date.now()}`);
    const aliasWorkspace = path.join(require('os').tmpdir(), `dkg-t75-alias-migration-${Date.now()}`);
    fs.mkdirSync(realWorkspace, { recursive: true });
    try {
      fs.symlinkSync(realWorkspace, aliasWorkspace, 'dir');
    } catch {
      return;
    }
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const apiFallback: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiFallback);
      const writer = (plugin as any).chatTurnWriter;
      let resolveMigration: (() => void) | undefined;
      const setStateDirSpy = vi.spyOn(writer, 'setStateDir').mockImplementation(
        () => new Promise<void>((resolve) => { resolveMigration = resolve; }),
      );

      const apiWorkspace: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir: realWorkspace,
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWorkspace);
      expect(setStateDirSpy).toHaveBeenCalledTimes(1);

      const apiRuntimeAlias: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        runtime: { state: { resolveStateDir: () => path.join(aliasWorkspace, '.dkg-adapter') } },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiRuntimeAlias);
      expect(setStateDirSpy).toHaveBeenCalledTimes(1);

      resolveMigration?.();
      await new Promise((r) => setTimeout(r, 50));
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(aliasWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(realWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - setup-owned stateDir detection handles symlink aliases at runtime', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const realWorkspace = path.join(require('os').tmpdir(), `dkg-t75-real-workspace-${Date.now()}`);
    const aliasWorkspace = path.join(require('os').tmpdir(), `dkg-t75-alias-workspace-${Date.now()}`);
    const currentWorkspace = path.join(require('os').tmpdir(), `dkg-t75-current-after-alias-${Date.now()}`);
    fs.mkdirSync(realWorkspace, { recursive: true });
    fs.mkdirSync(currentWorkspace, { recursive: true });
    try {
      fs.symlinkSync(realWorkspace, aliasWorkspace, 'dir');
    } catch {
      return;
    }
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace: realWorkspace,
        stateDir: path.join(aliasWorkspace, '.openclaw'),
        stateDirSource: 'setup-default',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir: currentWorkspace,
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        currentWorkspace.replace(/\\/g, '/') + '/.dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(aliasWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(realWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(currentWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - OPENCLAW_STATE_DIR still overrides configured stateDir', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    const envStateDir = path.join(require('os').tmpdir(), `dkg-t75-env-state-${Date.now()}`);
    const configStateDir = path.join(require('os').tmpdir(), `dkg-t75-config-lower-${Date.now()}`);
    process.env.OPENCLAW_STATE_DIR = envStateDir;
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: configStateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        envStateDir.replace(/\\/g, '/') + '/dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(envStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(configStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - gateway runtime state API overrides env and configured stateDir', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    const runtimeStateDir = path.join(require('os').tmpdir(), `dkg-t75-runtime-state-${Date.now()}`);
    const envStateDir = path.join(require('os').tmpdir(), `dkg-t75-env-lower-${Date.now()}`);
    const configStateDir = path.join(require('os').tmpdir(), `dkg-t75-config-lowest-${Date.now()}`);
    process.env.OPENCLAW_STATE_DIR = envStateDir;
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: configStateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        runtime: { state: { resolveStateDir: () => runtimeStateDir } },
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        runtimeStateDir.replace(/\\/g, '/') + '/dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(runtimeStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(envStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(configStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - runtime state API .dkg-adapter root uses direct layout without workspaceDir metadata', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-runtime-direct-${Date.now()}`);
    const runtimeStateDir = path.join(workspaceDir, '.dkg-adapter');
    const legacyFile = path.join(workspaceDir, '.openclaw', 'dkg-adapter', 'chat-turn-watermarks.json');
    try {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        'openclaw:tg:::runtime-direct': { w: 11, b: 5 },
      }));
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        runtime: { state: { resolveStateDir: () => runtimeStateDir } },
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(runtimeStateDir, 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(runtimeStateDir, 'dkg-adapter', 'chat-turn-watermarks.json'))).toBe(false);
      const persisted = JSON.parse(fs.readFileSync(watermarkPath, 'utf8'));
      expect(persisted['openclaw:tg:::runtime-direct']).toEqual({ w: 11, b: 5 });
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - runtime state API returning the active .dkg-adapter root does not downgrade direct layout', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-runtime-same-direct-${Date.now()}`);
    const runtimeStateDir = path.join(workspaceDir, '.dkg-adapter');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const apiWithWorkspace: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWithWorkspace);
      const writer = (plugin as any).chatTurnWriter;
      const setStateDirSpy = vi.spyOn(writer, 'setStateDir');

      const apiRuntimeOnly: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        runtime: { state: { resolveStateDir: () => runtimeStateDir } },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiRuntimeOnly);

      expect(setStateDirSpy).not.toHaveBeenCalled();
      expect(((plugin as any).chatTurnWriter as any).watermarkFilePath.replace(/\\/g, '/')).toBe(
        path.join(runtimeStateDir, 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - writer migrates from configured stateDir when runtime state API appears later', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const configStateDir = path.join(require('os').tmpdir(), `dkg-t75-config-first-${Date.now()}`);
    const runtimeStateDir = path.join(require('os').tmpdir(), `dkg-t75-runtime-later-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: configStateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const apiWithoutRuntime: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWithoutRuntime);
      const writer = (plugin as any).chatTurnWriter;
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        configStateDir.replace(/\\/g, '/'),
      );

      const setStateDirSpy = vi.spyOn(writer, 'setStateDir');
      const apiWithRuntime: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        runtime: { state: { resolveStateDir: () => runtimeStateDir } },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWithRuntime);
      expect(setStateDirSpy).toHaveBeenCalledWith(runtimeStateDir, expect.objectContaining({ stateLayout: 'nested' }));
      expect((plugin as any).chatTurnWriter).toBe(writer);

      await new Promise((r) => setTimeout(r, 100));
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        runtimeStateDir.replace(/\\/g, '/'),
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(configStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(runtimeStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - writer migrates from configured stateDir when OPENCLAW_STATE_DIR appears later', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const configStateDir = path.join(require('os').tmpdir(), `dkg-t75-config-first-env-${Date.now()}`);
    const envStateDir = path.join(require('os').tmpdir(), `dkg-t75-env-later-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: configStateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const writer = (plugin as any).chatTurnWriter;
      const setStateDirSpy = vi.spyOn(writer, 'setStateDir');

      process.env.OPENCLAW_STATE_DIR = envStateDir;
      plugin.register(mockApi);
      expect(setStateDirSpy).toHaveBeenCalledWith(envStateDir, expect.objectContaining({ stateLayout: 'nested' }));
      expect((plugin as any).chatTurnWriter).toBe(writer);

      await new Promise((r) => setTimeout(r, 100));
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        envStateDir.replace(/\\/g, '/'),
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(configStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(envStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T75 - explicit config.stateDir equal to home fallback does not emit fallback warning', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const homeStateDir = path.join(require('os').homedir(), '.openclaw');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: homeStateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const warn = vi.fn();
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn, debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      expect(warn.mock.calls.some((args) =>
        String(args?.[0] ?? '').includes('Could not resolve a workspace-scoped state dir'),
      )).toBe(false);
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
    }
  });

  it('warns once when legacy OriginTrail Game config is still present', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
      game: { enabled: true } as any,
    } as any);
    const warnCalls: unknown[][] = [];
    const warn = (...args: unknown[]) => { warnCalls.push(args); };
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { warn },
    };

    plugin.register(mockApi);
    plugin.register(mockApi);

    // R16.2 introduced a separate warn when the state dir falls back to
    // `~/.openclaw` because `workspaceDir` and `OPENCLAW_STATE_DIR` are
    // both absent in this fixture. Filter to the game-config warn so the
    // assertion remains scoped to the legacy-detection invariant.
    const gameWarns = warnCalls.filter((args) =>
      String(args?.[0] ?? '').includes('dkg-node.game.enabled'),
    );
    expect(gameWarns).toHaveLength(1);
    expect(String(gameWarns[0]?.[0])).toContain('dkg-node.game.enabled');
  });

  it('upgrades from setup-runtime to full runtime and registers the memory slot capability', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });

    const setupRuntimeTools: OpenClawTool[] = [];
    const setupRuntimeApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-runtime',
      registerTool: (tool) => setupRuntimeTools.push(tool),
      registerHook: () => {},
      on: () => {},
      logger: {},
      workspaceDir: 'C:/tmp/openclaw-upgrade-test',
    };
    plugin.register(setupRuntimeApi);
    expect(setupRuntimeTools).toHaveLength(0);

    const fullRuntimeTools: OpenClawTool[] = [];
    const registerMemoryCapability = vi.fn();
    const fullRuntimeApi: OpenClawPluginApi = {
      config: {
        plugins: {
          slots: {
            memory: 'adapter-openclaw',
          },
        },
      } as any,
      registrationMode: 'full',
      registerTool: (tool) => fullRuntimeTools.push(tool),
      registerHook: () => {},
      registerMemoryCapability,
      on: () => {},
      logger: {},
      workspaceDir: 'C:/tmp/openclaw-upgrade-test',
    };
    plugin.register(fullRuntimeApi);

    // The adapter no longer registers dkg_memory_import or
    // dkg_memory_search as conventional tools — both reads and writes
    // flow through the memory slot via registerMemoryCapability.
    const fullToolNames = fullRuntimeTools.map((tool) => tool.name);
    expect(fullToolNames).not.toContain('dkg_memory_search');
    expect(fullToolNames).not.toContain('dkg_memory_import');
    expect(registerMemoryCapability).toHaveBeenCalledTimes(1);
  });

  it('does not re-register the OpenClaw channel routes when the same plugin instance upgrades to full runtime', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true, port: 0 },
      memory: { enabled: false },
    });
    const registerChannelCalls: unknown[][] = [];
    const registerChannel = (...args: unknown[]) => { registerChannelCalls.push(args); };
    const registerHttpRouteCalls: unknown[][] = [];
    const registerHttpRoute = (...args: unknown[]) => { registerHttpRouteCalls.push(args); };

    try {
      const setupRuntimeApi = {
        config: {},
        registrationMode: 'setup-runtime',
        registerTool: () => {},
        registerHook: () => {},
        registerChannel,
        registerHttpRoute,
        on: () => {},
        logger: {},
      } as OpenClawPluginApi & {
        registerChannel: typeof registerChannel;
        registerHttpRoute: typeof registerHttpRoute;
      };
      plugin.register(setupRuntimeApi);

      const fullRuntimeApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerChannel,
        registerHttpRoute,
        on: () => {},
        logger: {},
      } as OpenClawPluginApi & {
        registerChannel: typeof registerChannel;
        registerHttpRoute: typeof registerHttpRoute;
      };
      plugin.register(fullRuntimeApi);

      expect(registerChannelCalls).toHaveLength(1);
      expect(registerHttpRouteCalls).toHaveLength(2);
    } finally {
      await plugin.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('wires ChatTurnWriter before channel routes can dispatch during setup-only runtime upgrade', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(tmpdir(), 'dkg-node-writer-order-'));
    const originalFetch = globalThis.fetch;
    const markerSpy = vi
      .spyOn(ChatTurnWriter.prototype, 'markExternalTurnPersistedDurable')
      .mockResolvedValue(undefined);
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true, port: 0 },
      memory: { enabled: false },
    });
    const storeCalls: unknown[][] = [];
    let resolveRoute!: () => void;
    const routeDone = new Promise<void>((resolve) => { resolveRoute = resolve; });

    const runtime = {
      state: {
        resolveStateDir: () => path.join(workspaceDir, '.dkg-adapter'),
      },
      channel: {
        routing: {
          resolveAgentRoute: () => ({ agentId: 'agent-1', sessionKey: 'session-order' }),
        },
        session: {
          resolveStorePath: () => '/tmp/store',
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: () => '[DKG UI Owner] Immediate inbound',
          async dispatchReplyWithBufferedBlockDispatcher(params: any) {
            await params.dispatcherOptions.deliver({ text: 'Immediate reply' });
          },
        },
      },
    };
    const cfg = { session: { dmScope: 'main' }, agents: {} };
    const makeApi = (
      registrationMode: 'setup-only' | 'setup-runtime',
      registerHttpRoute: (...args: unknown[]) => void = () => {},
    ) => ({
      config: {},
      registrationMode,
      registerTool: () => {},
      registerHook: () => {},
      registerChannel: () => {},
      registerHttpRoute,
      on: () => {},
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      runtime,
      cfg,
      workspaceDir,
    } as any);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
    }) as any;

    try {
      plugin.register(makeApi('setup-only'));
      (plugin as any).client.storeChatTurn = vi.fn(async (...args: unknown[]) => {
        storeCalls.push(args);
      });

      const registerHttpRoute = (route: any) => {
        if (route.method !== 'POST' || route.path !== '/api/dkg-channel/inbound') {
          return;
        }
        const res = {
          writeHead: vi.fn(),
          end: vi.fn(() => resolveRoute()),
        };
        route.handler({
          body: {
            text: 'Immediate inbound',
            correlationId: 'corr-writer-order',
            identity: 'owner',
          },
        }, res);
      };

      plugin.register(makeApi('setup-runtime', registerHttpRoute));
      await routeDone;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(storeCalls).toHaveLength(1);
      expect(markerSpy).toHaveBeenCalledWith({
        sessionKey: 'session-order',
        turnId: 'corr-writer-order',
        user: 'Immediate inbound',
        assistant: 'Immediate reply',
      });
      expect((plugin as any).channelPlugin.chatTurnWriter).toBe((plugin as any).chatTurnWriter);
    } finally {
      markerSpy.mockRestore();
      globalThis.fetch = originalFetch;
      await plugin.stop();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it('memory resolver reads the UI-selected CG stashed on the channel plugin session state', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: true, port: 0 },
    });

    let registeredCapability: any = null;
    const mockApi = {
      // Codex B58: slot-ownership gate requires plugins.slots.memory to
      // name adapter-openclaw before DkgMemoryPlugin.register will claim
      // the slot. Stamp it here so this dispatch-context test exercises
      // the full registration path.
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full' as const,
      registerTool: () => {},
      registerHook: () => {},
      registerChannel: () => {},
      registerHttpRoute: () => {},
      registerMemoryCapability: (capability: any) => {
        registeredCapability = capability;
      },
      on: () => {},
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    } as unknown as OpenClawPluginApi;

    // Stub fetch so the plugin's best-effort getStatus + listContextGraphs
    // probes during register() resolve cleanly. /api/status returns a real
    // peer ID so DkgNodePlugin.nodePeerId populates and the runtime can
    // hand back an actual DkgMemorySearchManager (not the null-manager
    // fallback that fires when peer ID is still undefined — Codex B12).
    // /api/context-graph/list returns an empty array so the subscribed-CG
    // preflight terminates cleanly. Any other call returns an empty 200.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('/api/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, peerId: 'peer-dispatch-test' }),
        } as Response;
      }
      if (url.includes('/api/context-graph/list')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ contextGraphs: [] }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as any;

    try {
      plugin.register(mockApi);
      expect(registeredCapability).not.toBeNull();

      // T31 — The resolver now returns `nodeAgentAddress` (eth address from
      // keystore) instead of `nodePeerId`. This dispatch-context test
      // doesn't care about how the address is sourced, just that the
      // resolver hands back A non-undefined address so getMemorySearchManager
      // hits the manager-construction path (Codex B12 null-manager
      // fallback otherwise). Directly seed the field; the keystore-load
      // mechanics are tested in the dedicated B9-style tests below.
      (plugin as any).nodeAgentAddress = '0xabcabcabcabcabcabcabcabcabcabcabcabcabcd';

      // Let the best-effort probes kicked off inside register() flush.
      await new Promise((resolve) => setImmediate(resolve));

      // Before any dispatch: resolver returns no projectContextGraphId for
      // any sessionKey — the ALS store is empty outside of an active
      // dispatch. The runtime still hands back a real manager because the
      // peer-ID probe succeeded above; null-manager fallback only fires
      // when the resolver cannot produce an agent address.
      const runtime = registeredCapability.runtime;
      const resultBefore = await runtime.getMemorySearchManager({ sessionKey: 'session-xyz' });
      expect(resultBefore.manager).not.toBeNull();
      expect(resultBefore.error).toBeUndefined();

      const channelPlugin = (plugin as any).channelPlugin as any;
      expect(channelPlugin).toBeDefined();
      expect(channelPlugin.chatTurnWriter).toBe((plugin as any).chatTurnWriter);

      // Simulate a dispatch scope by running the memorySessionResolver
      // lookup inside `channelPlugin.dispatchContext.run`, the same
      // AsyncLocalStorage the real dispatch uses. Inside the scope the
      // resolver sees the stashed CG; outside the scope it returns
      // undefined. This mirrors what a real slot-backed tool call does
      // during a live dispatch. Codex Bug B6.
      const dispatchStore = {
        uiContextGraphId: 'research-x',
        sessionKey: 'session-xyz',
        correlationId: 'corr-test',
      };
      const insideScope = channelPlugin.dispatchContext.run(dispatchStore, () => {
        return (plugin as any).memorySessionResolver.getSession('session-xyz');
      });
      expect(insideScope?.projectContextGraphId).toBe('research-x');

      // Outside the scope: resolver returns a session with NO project CG.
      const outsideScope = (plugin as any).memorySessionResolver.getSession('session-xyz');
      expect(outsideScope?.projectContextGraphId).toBeUndefined();

      // And the channel plugin's own getter is scope-aware too.
      expect(channelPlugin.getSessionProjectContextGraphId('session-xyz')).toBeUndefined();
      const insideScopeGetter = channelPlugin.dispatchContext.run(dispatchStore, () => {
        return channelPlugin.getSessionProjectContextGraphId('session-xyz');
      });
      expect(insideScopeGetter).toBe('research-x');
    } finally {
      await plugin.stop();
      globalThis.fetch = originalFetch;
    }
  });

  describe('node peer ID lazy re-probe (Codex B9)', () => {
    // Helper: makes a fetch stub that routes /api/status calls through a
    // user-supplied handler and counts them. /api/context-graph/list (fired
    // by listContextGraphs in the same refresh) always resolves empty so
    // we don't have to care about its shape in these tests.
    function makeFetchStub(statusHandler: (callIndex: number) => Response | Promise<Response>) {
      const statusCalls: Array<{ url: string }> = [];
      const fetchFn = vi.fn(async (input: any, _init?: any) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes('/api/status')) {
          const idx = statusCalls.length;
          statusCalls.push({ url });
          return statusHandler(idx);
        }
        if (url.includes('/api/context-graph/list')) {
          return new Response(JSON.stringify({ contextGraphs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      });
      return { fetchFn, statusCalls };
    }

    function makeMockApi(): OpenClawPluginApi {
      return {
        config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
        registrationMode: 'full' as const,
        registerTool: () => {},
        registerHook: () => {},
        registerMemoryCapability: () => {},
        on: () => {},
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
      } as unknown as OpenClawPluginApi;
    }

    // Drain enough event-loop turns for a fire-and-forget fetch chain
    // (`ensureNodePeerId` → `probeNodePeerIdOnce` → `getStatus` → `fetch`
    // → response.json → state assignment → `.finally` cleanup) to
    // actually settle. Real-world fetch chains are ~15-20 microtask
    // hops; a generous count here is cheaper than a wall-clock wait.
    const flushMicrotasks = async () => {
      for (let i = 0; i < 50; i++) {
        await Promise.resolve();
      }
    };

    // T31 — These four tests exercise `ensureNodePeerId` directly. They
    // used to drive the lazy re-probe via `resolver.getDefaultAgentAddress()`,
    // which now feeds `nodeAgentAddress` (keystore-driven) instead. The
    // peerId machinery itself still exists for libp2p uses (relay/transport
    // metadata) and the lazy-recovery semantic is still worth pinning, so
    // these tests now drive `ensureNodePeerId()` directly. A separate
    // `node agent address keystore (T31)` describe-block below covers the
    // keystore-based equivalent that feeds the resolver.

    it('lazily re-probes peer ID when the register-time probe failed', async () => {
      const { fetchFn, statusCalls } = makeFetchStub((idx) => {
        if (idx === 0) {
          return new Response('daemon starting', { status: 503 });
        }
        return new Response(JSON.stringify({ peerId: 'did:dkg:agent:test-peer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        await flushMicrotasks();
        expect((plugin as any).nodePeerId).toBeUndefined();
        // Direct lazy re-probe — the resolver no longer triggers this
        // (it now feeds `nodeAgentAddress`) but the recovery contract
        // remains relevant for libp2p uses.
        await (plugin as any).ensureNodePeerId();
        await flushMicrotasks();
        expect((plugin as any).nodePeerId).toBe('did:dkg:agent:test-peer');
        const statusCallsBefore = statusCalls.length;
        // Subsequent calls are no-ops once cached.
        await (plugin as any).ensureNodePeerId();
        expect(statusCalls.length).toBe(statusCallsBefore);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });

    it('debounces concurrent ensureNodePeerId fires to a single in-flight probe', async () => {
      let resolveStatus: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        resolveStatus = resolve;
      });
      const { fetchFn, statusCalls } = makeFetchStub(async () => {
        await gate;
        return new Response(JSON.stringify({ peerId: 'did:dkg:agent:debounced' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        await flushMicrotasks();
        // 10 concurrent direct calls — must collapse to one in-flight probe.
        for (let i = 0; i < 10; i++) {
          void (plugin as any).ensureNodePeerId();
        }
        expect(statusCalls.length).toBe(1);
        resolveStatus!();
        await flushMicrotasks();
        expect((plugin as any).nodePeerId).toBe('did:dkg:agent:debounced');
        expect(statusCalls.length).toBe(1);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });

    it('recovers on every subsequent call when /api/status keeps failing', async () => {
      const { fetchFn, statusCalls } = makeFetchStub(() => {
        return new Response('daemon down', { status: 503 });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        await flushMicrotasks();
        const initialCalls = statusCalls.length;
        expect(initialCalls).toBeGreaterThanOrEqual(1);

        await (plugin as any).ensureNodePeerId();
        await flushMicrotasks();
        expect((plugin as any).nodePeerId).toBeUndefined();
        const afterFirstLazy = statusCalls.length;
        expect(afterFirstLazy).toBe(initialCalls + 1);

        await (plugin as any).ensureNodePeerId();
        await flushMicrotasks();
        const afterSecondLazy = statusCalls.length;
        expect(afterSecondLazy).toBe(initialCalls + 2);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });

    it('does NOT re-probe when the register-time probe already succeeded', async () => {
      const { fetchFn, statusCalls } = makeFetchStub(() => {
        return new Response(JSON.stringify({ peerId: 'did:dkg:agent:happy-path' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        await flushMicrotasks();
        expect((plugin as any).nodePeerId).toBe('did:dkg:agent:happy-path');
        const baselineCalls = statusCalls.length;
        for (let i = 0; i < 20; i++) {
          await (plugin as any).ensureNodePeerId();
        }
        expect(statusCalls.length).toBe(baselineCalls);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('node agent address identity probe (#324)', () => {
    const ETH_PRIMARY_LC = '0x26c9b05a30138b35e84e60a5b778d580065ffbb8';
    const ETH_SECONDARY_LC = '0x949ec97ab4ed1c9fb4c9a70c2dd368065d817b0c';
    const ETH_PRIMARY = toEip55Checksum(ETH_PRIMARY_LC);

    function makeMockApi(): OpenClawPluginApi {
      return {
        config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
        registrationMode: 'full' as const,
        registerTool: () => {},
        registerHook: () => {},
        registerMemoryCapability: () => {},
        on: () => {},
        logger: { info: () => {}, warn: vi.fn(), debug: () => {} },
      } as unknown as OpenClawPluginApi;
    }

    function identityResult(agentAddress: string) {
      return {
        ok: true,
        identity: {
          agentAddress,
          agentDid: `did:dkg:agent:${agentAddress}`,
          name: 'test-agent',
          peerId: '12D3KooWDaemonPeerFromIdentity',
          nodeIdentityId: '0',
        },
      };
    }

    let tempHome: string;
    let prevDkgHome: string | undefined;

    beforeEach(() => {
      tempHome = path.join(require('os').tmpdir(), `dkg-node-identity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(tempHome, { recursive: true });
      prevDkgHome = process.env.DKG_HOME;
      process.env.DKG_HOME = tempHome;
    });

    afterEach(() => {
      if (prevDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = prevDkgHome;
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    function installIdentityClient(plugin: DkgNodePlugin, response: unknown): ReturnType<typeof vi.fn> {
      const spy = vi.fn().mockResolvedValue(response);
      (plugin as any).client = { getAgentIdentity: spy };
      return spy;
    }

    function attachResolverApi(plugin: DkgNodePlugin, api: OpenClawPluginApi): void {
      (plugin as any).memoryResolverApi = api;
      (plugin as any).dkgHome = tempHome;
    }

    function writePoisonKeystore(): void {
      fs.writeFileSync(
        path.join(tempHome, 'agent-keystore.json'),
        JSON.stringify({
          [ETH_PRIMARY_LC]: { authToken: 'agent-token-that-must-not-be-read' },
          [ETH_SECONDARY_LC]: { authToken: 'second-token-that-would-have-triggered-multi-agent-branch' },
        }),
      );
    }

    it('caches the daemon default agent from the HTTP identity probe and ignores local keystore content', async () => {
      writePoisonKeystore();
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        attachResolverApi(plugin, api);
        const spy = installIdentityClient(plugin, identityResult(ETH_PRIMARY));

        await (plugin as any).ensureNodeAgentAddress();

        const resolver = (plugin as any).memorySessionResolver;
        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
        expect(resolver.getDefaultAgentAddress()).toBe(ETH_PRIMARY);
        expect(resolver.getSession(undefined)?.agentAddress).toBe(ETH_PRIMARY);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]).toEqual([]);
      } finally {
        await plugin.stop();
      }
    });

    it('probes daemon identity for non-local daemonUrl instead of skipping to local keystore logic', async () => {
      writePoisonKeystore();
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://daemon.example.com:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        attachResolverApi(plugin, api);
        const spy = installIdentityClient(plugin, identityResult(ETH_PRIMARY));

        await (plugin as any).ensureNodeAgentAddress();

        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
        expect(spy).toHaveBeenCalledWith();
      } finally {
        await plugin.stop();
      }
    });

    it('debounces concurrent daemon identity probes', async () => {
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      try {
        attachResolverApi(plugin, api);
        const spy = vi.fn(async () => {
          await gate;
          return identityResult(ETH_PRIMARY);
        });
        (plugin as any).client = { getAgentIdentity: spy };

        const first = (plugin as any).ensureNodeAgentAddress();
        const second = (plugin as any).ensureNodeAgentAddress();
        expect(spy).toHaveBeenCalledTimes(1);
        release();
        await Promise.all([first, second]);

        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        await plugin.stop();
      }
    });

    it('warns on failed identity probe and keeps the nodePeerId fallback available', async () => {
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        attachResolverApi(plugin, api);
        (plugin as any).nodePeerId = '12D3KooWPeerFallback';
        installIdentityClient(plugin, { ok: false, error: '401 Unauthorized' });

        await (plugin as any).ensureNodeAgentAddress();

        const resolver = (plugin as any).memorySessionResolver;
        expect((plugin as any).nodeAgentAddress).toBeUndefined();
        expect(resolver.getDefaultAgentAddress()).toBe('12D3KooWPeerFallback');
        const warnCalls = (api.logger.warn as any).mock.calls.map((c: any) => String(c[0]));
        expect(warnCalls.some((m: string) => m.includes('/api/agent/identity probe failed'))).toBe(true);
        expect(warnCalls.some((m: string) => m.includes('node API token'))).toBe(true);
        expect(warnCalls.some((m: string) => m.includes('keystore'))).toBe(false);
      } finally {
        await plugin.stop();
      }
    });

    it('keeps resolved dkgHome scoped to node-level auth.token loading only', async () => {
      delete process.env.DKG_HOME;

      const isolatedHome = path.join(require('os').tmpdir(), `dkg-t70-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const dkg = path.join(isolatedHome, '.dkg');
      const dkgDev = path.join(isolatedHome, '.dkg-dev');
      fs.mkdirSync(dkg, { recursive: true });
      fs.mkdirSync(dkgDev, { recursive: true });

      const prevHome = process.env.HOME;
      const prevUserProfile = process.env.USERPROFILE;
      const originalFetch = globalThis.fetch;
      process.env.HOME = isolatedHome;
      process.env.USERPROFILE = isolatedHome;

      globalThis.fetch = vi.fn(async (input: any) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes('/api/status')) {
          return new Response(JSON.stringify({ peerId: '12D3KooWResolvedHomePeer' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/agent/identity')) {
          return new Response(JSON.stringify(identityResult(ETH_PRIMARY).identity), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/context-graph/list')) {
          return new Response(JSON.stringify({ contextGraphs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as any;

      try {
        fs.writeFileSync(path.join(dkg, 'auth.token'), 'STALE-NPM-TOKEN');
        fs.writeFileSync(path.join(dkgDev, 'daemon.pid'), String(process.pid));

        const plugin = new DkgNodePlugin({
          daemonUrl: 'http://127.0.0.1:9200',
          memory: { enabled: true },
          channel: { enabled: false },
        });
        try {
          plugin.register(makeMockApi());
          expect((plugin as any).dkgHome).toBe(dkgDev);
          expect((plugin as any).client.apiToken).toBeUndefined();
        } finally {
          await plugin.stop();
        }
      } finally {
        globalThis.fetch = originalFetch;
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });

    it('honors config.dkgHome for node-level auth.token without using agent-keystore identity auth', async () => {
      const customHome = path.join(require('os').tmpdir(), `dkg-custom-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(customHome, { recursive: true });
      fs.writeFileSync(path.join(customHome, 'auth.token'), 'CUSTOM-NODE-TOKEN');
      fs.writeFileSync(
        path.join(customHome, 'agent-keystore.json'),
        JSON.stringify({
          [ETH_PRIMARY_LC]: { authToken: 'agent-token-that-must-not-be-forwarded' },
          [ETH_SECONDARY_LC]: { authToken: 'second-agent-token-that-must-not-matter' },
        }),
      );

      const originalFetch = globalThis.fetch;
      const identityRequests: RequestInit[] = [];
      globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes('/api/status')) {
          return new Response(JSON.stringify({ peerId: '12D3KooWCustomHomePeer' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/agent/identity')) {
          identityRequests.push(init ?? {});
          return new Response(JSON.stringify(identityResult(ETH_PRIMARY).identity), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/context-graph/list')) {
          return new Response(JSON.stringify({ contextGraphs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://127.0.0.1:9200',
        dkgHome: customHome,
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        expect((plugin as any).dkgHome).toBe(customHome);
        expect((plugin as any).client.apiToken).toBe('CUSTOM-NODE-TOKEN');

        await (plugin as any).ensureNodeAgentAddress();

        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
        expect(identityRequests.length).toBeGreaterThanOrEqual(1);
        const auth = new Headers(identityRequests.at(-1)?.headers as HeadersInit).get('authorization');
        expect(auth).toBe('Bearer CUSTOM-NODE-TOKEN');
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
        try { fs.rmSync(customHome, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });
  });

  describe('context-graph cache filter on synced + non-system (Codex B51 + B54)', () => {
    it('caches only entries with synced=true AND isSystem=false (includes local private CGs per B54)', async () => {
      // B51: `agent.listContextGraphs()` returns every known CG —
      // including system paranets (ontology, agents registry) and
      // discovered-but-not-synced ontology entries. The cache is the
      // needs_clarification availability list AND the B42 / B46 / B48
      // subscribed-project allowlist for `dkg_memory_import`, so
      // including non-locally-usable or system entries would advertise
      // targets the node cannot actually write to.
      //
      // B54: local private CGs are legitimately recorded as
      // `subscribed: false, synced: true` by `createContextGraph({
      // private: true })` (agent/src/dkg-agent.ts:2041-2045). B51's
      // original strict `subscribed === true` filter dropped these
      // and broke `dkg_memory_import` writes against legitimate
      // private targets. The relaxed filter uses `synced === true`
      // to accept both public-subscribed AND local-private while
      // still excluding system paranets and discovered-but-not-
      // synced entries.
      const fetchFn = vi.fn(async (input: any, _init?: any) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes('/api/status')) {
          return new Response(JSON.stringify({ peerId: 'peer-b51' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/context-graph/list')) {
          return new Response(
            JSON.stringify({
              contextGraphs: [
                // Valid: public subscribed, synced, non-system → cached
                { id: 'research-public', subscribed: true, synced: true, isSystem: false },
                // System paranet → filtered out (isSystem)
                { id: 'ontology', subscribed: true, synced: true, isSystem: true },
                // Subscribed but not yet synced (gossip subscribe lag) → filtered out
                { id: 'research-syncing', subscribed: true, synced: false, isSystem: false },
                // Reserved graph name → filtered out (pre-existing guard)
                { id: 'agent-context', subscribed: true, synced: true, isSystem: false },
                // B54 case: local PRIVATE CG, subscribed=false, synced=true → cached
                { id: 'research-private', subscribed: false, synced: true, isSystem: false },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });

      try {
        plugin.register({
          config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
          registrationMode: 'full' as const,
          registerTool: () => {},
          registerHook: () => {},
          registerMemoryCapability: () => {},
          on: () => {},
          logger: { info: () => {}, warn: () => {}, debug: () => {} },
        } as unknown as OpenClawPluginApi);

        // Drain the register-time refresh.
        for (let i = 0; i < 50; i++) await Promise.resolve();

        const resolver = (plugin as any).memorySessionResolver;
        const cached = resolver.listAvailableContextGraphs();
        // Only the two synced + non-system + non-reserved entries:
        // public subscribed and local private. Ontology (system),
        // subscribed-but-unsynced, and agent-context (reserved) are
        // all filtered.
        expect(cached).toEqual(['research-public', 'research-private']);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('context-graph cache refresh in-flight promise sharing (Codex B49)', () => {
    // B49: `refreshMemoryResolverState` used to gate concurrent calls
    // with a boolean that returned immediately while a background
    // refresh was in flight. That broke
    // `refreshAvailableContextGraphs` awaiters — they would resolve
    // against the still-stale cache instead of awaiting the in-flight
    // refresh. The fix tracks the refresh promise and returns it to
    // concurrent callers so all awaiters observe the populated cache.

    it('concurrent refreshAvailableContextGraphs calls share a single daemon fetch and all observe the populated cache', async () => {
      // Gate the context-graph listing so we can start a second
      // concurrent refresh while the first is in flight.
      let releaseListGate!: () => void;
      const listGate = new Promise<void>((resolve) => {
        releaseListGate = resolve;
      });
      let listCallCount = 0;

      const fetchFn = vi.fn(async (input: any, _init?: any) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes('/api/status')) {
          return new Response(JSON.stringify({ peerId: 'peer-b49' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/context-graph/list')) {
          listCallCount++;
          await listGate;
          // B51 + B54: the refresh now filters on `synced: true` and
          // `!isSystem`, so the mock entry has to carry both flags to
          // end up in the cache.
          return new Response(
            JSON.stringify({
              contextGraphs: [
                { id: 'research-b49-fresh', subscribed: true, synced: true, isSystem: false },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });

      try {
        plugin.register({
          config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
          registrationMode: 'full' as const,
          registerTool: () => {},
          registerHook: () => {},
          registerMemoryCapability: () => {},
          on: () => {},
          logger: { info: () => {}, warn: () => {}, debug: () => {} },
        } as unknown as OpenClawPluginApi);

        // Register-time fire-and-forget refresh is in flight and blocked
        // on the gate. Drain enough microtasks to let the
        // /api/context-graph/list call reach the gate.
        for (let i = 0; i < 50; i++) await Promise.resolve();
        expect(listCallCount).toBe(1);

        const resolver = (plugin as any).memorySessionResolver;
        // Cache is still empty because the in-flight refresh is parked.
        expect(resolver.listAvailableContextGraphs()).toEqual([]);

        // Start a second concurrent refresh via the resolver. This is
        // the B49 regression path: previously this call would return
        // immediately with the stale (empty) cache because the boolean
        // guard short-circuited the duplicate call.
        const secondRefreshPromise = resolver.refreshAvailableContextGraphs();

        // Release the gate so the in-flight daemon fetch completes.
        releaseListGate();

        // Await the second refresh — it MUST observe the populated
        // cache, not the stale one. And the daemon fetch must have
        // only fired once (both callers share the promise).
        const secondResult = await secondRefreshPromise;
        expect(secondResult).toEqual(['research-b49-fresh']);
        expect(listCallCount).toBe(1);
        expect(resolver.listAvailableContextGraphs()).toEqual(['research-b49-fresh']);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });
  });
});
