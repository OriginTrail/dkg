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
      expect(markerSpy).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: 'session-order',
        turnId: 'corr-writer-order',
        user: 'Immediate inbound',
        assistant: 'Immediate reply',
      }));
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
});
