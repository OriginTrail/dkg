import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { DkgChannelPlugin, CHANNEL_NAME, formatInboundTurnDiagnostic } from '../src/DkgChannelPlugin.js';
import { DkgDaemonClient } from '../src/dkg-client.js';
import type { OpenClawPluginApi } from '../src/types.js';

interface TrackingFn {
  (...args: unknown[]): any;
  calls: unknown[][];
}

function trackFn(impl: (...args: unknown[]) => unknown = () => undefined): TrackingFn {
  const calls: unknown[][] = [];
  const fn = ((...args: unknown[]) => {
    calls.push(args);
    return impl(...args);
  }) as TrackingFn;
  fn.calls = calls;
  return fn;
}

function trackAsyncFn(impl: (...args: unknown[]) => unknown = async () => undefined): TrackingFn {
  const calls: unknown[][] = [];
  const fn = (async (...args: unknown[]) => {
    calls.push(args);
    return impl(...args);
  }) as TrackingFn;
  fn.calls = calls;
  return fn;
}

function makeApi(overrides?: Partial<OpenClawPluginApi>): OpenClawPluginApi {
  return {
    config: {},
    registerTool: trackFn(),
    registerHook: trackFn(),
    on: trackFn(),
    logger: { info: trackFn(), warn: trackFn(), debug: trackFn() },
    ...overrides,
  };
}

function makeMockRuntime(overrides?: {
  resolveAgentRouteImpl?: () => any;
  resolveStorePathImpl?: () => string;
  readSessionUpdatedAtImpl?: () => any;
  recordInboundSessionImpl?: (...args: any[]) => any;
  resolveEnvelopeFormatOptionsImpl?: () => any;
  formatAgentEnvelopeImpl?: () => string;
  dispatchImpl?: (params: any) => Promise<void>;
  dispatchReplyFn?: TrackingFn;
}) {
  const recordInboundSession = overrides?.recordInboundSessionImpl
    ? trackAsyncFn(overrides.recordInboundSessionImpl)
    : trackAsyncFn();

  return {
    recordInboundSession,
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute: trackFn(overrides?.resolveAgentRouteImpl ?? (() => ({ agentId: 'agent-1', sessionKey: 'session-1' }))),
        },
        session: {
          resolveStorePath: trackFn(overrides?.resolveStorePathImpl ?? (() => '/tmp/store')),
          readSessionUpdatedAt: trackFn(overrides?.readSessionUpdatedAtImpl ?? (() => undefined)),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: trackFn(overrides?.resolveEnvelopeFormatOptionsImpl ?? (() => ({}))),
          formatAgentEnvelope: trackFn(overrides?.formatAgentEnvelopeImpl ?? (() => '[DKG UI Owner] Hello')),
          ...(overrides?.dispatchReplyFn
            ? { dispatchReplyWithBufferedBlockDispatcher: overrides.dispatchReplyFn }
            : {
                async dispatchReplyWithBufferedBlockDispatcher(params: any) {
                  if (overrides?.dispatchImpl) {
                    await overrides.dispatchImpl(params);
                  }
                },
              }),
        },
      },
    },
  };
}

async function waitForBridgePort(plugin: DkgChannelPlugin): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = ((plugin as any).server?.address() as any)?.port;
    if (typeof port === 'number' && port > 0) return port;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Bridge server did not bind to a port');
}

async function flushAsyncContinuations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('DkgChannelPlugin', () => {
  let client: DkgDaemonClient;
  let plugin: DkgChannelPlugin;
  let origStoreChatTurn: typeof DkgDaemonClient.prototype.storeChatTurn;

  beforeEach(() => {
    client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200', apiToken: 'test-token' });
    origStoreChatTurn = client.storeChatTurn.bind(client);
    plugin = new DkgChannelPlugin({ enabled: true, port: 0 }, client);
  });

  afterEach(async () => {
    await plugin.stop();
    client.storeChatTurn = origStoreChatTurn;
  });



  it('should have channel name "dkg-ui"', () => {
    expect(CHANNEL_NAME).toBe('dkg-ui');
  });

  it('layers direct adapter config from api.config into merged runtime config', () => {
    // T364 — Pre-fix this test asserted `(plugin as any).cfg).toBe(fullConfig)`
    // (object identity), encoding the buggy behavior where the merged
    // runtime config was returned verbatim and the fresher direct adapter
    // config from `api.config` was dropped. Post-fix the direct adapter
    // config is layered into the merged config's nested
    // `plugins.entries['adapter-openclaw'].config`, so dispatch sees the
    // updated daemonUrl / channel / memory while still inheriting
    // `agents.defaults.workspace` from the merged runtime config.
    const { runtime } = makeMockRuntime();
    const fullConfig = {
      plugins: {
        entries: {
          'adapter-openclaw': {
            config: { channel: { enabled: true, port: 0 } },
          },
        },
      },
      agents: {
        defaults: {
          workspace: '/runtime-workspace',
        },
      },
    };
    const api = makeApi({
      config: {
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
      } as any,
      runtime: {
        ...runtime,
        config: fullConfig,
      },
      registerChannel: trackFn(),
      registerHttpRoute: trackFn(),
    } as any);

    plugin.register(api);

    // Workspace metadata from the merged runtime config is preserved.
    expect((plugin as any).cfg).toMatchObject({
      agents: { defaults: { workspace: '/runtime-workspace' } },
    });
    // Direct adapter config from api.config is layered into the nested
    // adapter-openclaw entry, with channel deep-merged over the entry's
    // baseline (entry had `channel: { enabled: true, port: 0 }`, direct
    // had `channel: { enabled: true, port: 0 }` — same shape, merge-clean).
    expect((plugin as any).cfg.plugins.entries['adapter-openclaw'].config).toMatchObject({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true, port: 0 },
    });
  });

  it('overlays current route metadata onto fallback merged runtime config', async () => {
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Merged route reply' });
      },
    });
    const staleRuntimeConfig = {
      agents: { defaults: { workspace: '/stale-runtime-workspace', model: 'gpt-5.5' } },
      session: { projectContextGraphId: 'stale-cg', ttlMs: 10_000 },
      plugins: {
        entries: {
          'adapter-openclaw': {
            config: { channel: { enabled: true, port: 0 } },
          },
        },
      },
    };
    const currentRouteMetadata = {
      agents: { defaults: { workspace: '/live-cfg-workspace' } },
      session: { projectContextGraphId: 'live-cg' },
      workspace: '/live-cfg-workspace',
    };
    const api = makeApi({
      cfg: currentRouteMetadata,
      runtime: {
        ...runtime,
        config: staleRuntimeConfig,
      },
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    const reply = await plugin.processInbound('Hello', 'corr-merged-route', 'owner');

    expect(reply.text).toBe('Merged route reply');
    const dispatchCfg = (runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg;
    expect(dispatchCfg).toMatchObject({
      agents: { defaults: { workspace: '/live-cfg-workspace', model: 'gpt-5.5' } },
      session: { projectContextGraphId: 'live-cg', ttlMs: 10_000 },
      workspace: '/live-cfg-workspace',
      plugins: staleRuntimeConfig.plugins,
    });
  });

  it('uses direct plugin config as dispatch cfg fallback when no merged config exists', async () => {
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Direct config reply' });
      },
    });
    const directConfig = {
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true, port: 0 },
    };
    const fallbackRoute = trackAsyncFn(async () => ({
      text: 'fallback',
      correlationId: 'corr-direct-config',
    }));
    const api = makeApi({
      config: directConfig,
      runtime,
      routeInboundMessage: fallbackRoute,
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    const reply = await plugin.processInbound('Hello', 'corr-direct-config', 'owner');

    expect(reply.text).toBe('Direct config reply');
    expect(fallbackRoute.calls).toHaveLength(0);
    expect((runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg).toBe(directConfig);
  });

  it('T364 round 6 — extracts adapter overlay from mixed { workspaceDir, channel } gateway payload', async () => {
    // Pre-fix `directAdapterConfigFrom` rejected any object carrying
    // route-metadata keys (workspaceDir, agents, session, workspace),
    // so a gateway payload like `{ workspaceDir, channel: { port: 9801 } }`
    // dropped its channel override on the floor and the dispatch
    // resolver kept stale daemon/channel settings from lower-priority
    // sources. Post-fix the helper splits the route-metadata portion
    // (handled separately by `resolveOpenClawRouteMetadataConfig`) from
    // the adapter-config portion and returns just the latter, so the
    // overlay layers correctly over the lower-priority full config.
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Mixed payload reply' });
      },
    });
    const mixedConfig = {
      workspaceDir: '/legacy-workspace',
      channel: { port: 9801 },
    };
    const fullPluginConfig = {
      daemonUrl: 'http://localhost:9350',
      memory: { enabled: true },
      channel: { enabled: true, port: 0 },
    };
    const api = makeApi({
      config: mixedConfig,
      pluginConfig: fullPluginConfig,
      runtime,
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    const reply = await plugin.processInbound('Hello', 'corr-mixed-payload', 'owner');

    expect(reply.text).toBe('Mixed payload reply');
    const dispatchCfg = (runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg;
    // Adapter overlay (channel.port: 9801) MUST be preserved on top of
    // the lower-priority full plugin config; route metadata (workspaceDir)
    // is recognized by the route-metadata path separately. Adapter
    // fields land nested under `plugins.entries['adapter-openclaw'].config`
    // because mergeRouteConfigWithAdapterConfig groups them there when
    // a route-metadata layer is present (matches the no-merged-config
    // route+direct path used elsewhere in this file).
    expect(dispatchCfg.workspaceDir).toBe('/legacy-workspace');
    // Route layer must NOT leak the adapter `channel` key (T364 round 6
    // route-metadata-extraction fix).
    expect(dispatchCfg).not.toHaveProperty('channel');
    expect(dispatchCfg.plugins.entries['adapter-openclaw'].config).toMatchObject({
      daemonUrl: 'http://localhost:9350',
      memory: { enabled: true },
      channel: { enabled: true, port: 9801 },
    });
  });

  it('T364 round 8 — dispatch merge scrubs stale agents.defaults.workspace when newer route asserts workspaceDir only', async () => {
    // Pre-fix `mergeRouteMetadataWithMergedConfig` (DkgChannelPlugin.ts)
    // kept any older `workspace` / `agents.defaults.workspace` from the
    // merged snapshot when the routeConfig only carried a newer
    // `workspaceDir`. The setup-side resolver's fallback chain
    // (`agents.defaults.workspace -> workspace -> workspaceDir`) then
    // returned the stale alias and the channel dispatched against the
    // wrong workspace. Post-fix `scrubStaleWorkspaceAliases` is shared
    // with `openclaw-config.ts` and runs on the dispatch-side merge
    // too, so the newest workspace signal wins consistently.
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'New workspace reply' });
      },
    });
    // mergedConfig (older snapshot) carries plugins + a stale
    // agents.defaults.workspace.
    const staleMergedConfig = {
      agents: { defaults: { workspace: '/stale-workspace', model: 'gpt-4' } },
      plugins: {
        slots: { memory: 'adapter-openclaw' },
        entries: {
          'adapter-openclaw': {
            config: {
              daemonUrl: 'http://localhost:9350',
              memory: { enabled: true },
              channel: { enabled: true, port: 0 },
            },
          },
        },
      },
    };
    // Newer route metadata asserts workspaceDir but no agents.defaults.workspace.
    const freshRouteConfig = {
      workspaceDir: '/fresh-workspace',
    };
    const api = makeApi({
      cfg: freshRouteConfig,
      runtime: {
        ...runtime,
        config: staleMergedConfig,
      },
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    const reply = await plugin.processInbound('Hello', 'corr-route-scrub', 'owner');

    expect(reply.text).toBe('New workspace reply');
    const dispatchCfg = (runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg;
    // Newer workspaceDir wins.
    expect(dispatchCfg.workspaceDir).toBe('/fresh-workspace');
    // Stale `agents.defaults.workspace` MUST be scrubbed so the resolver
    // chain doesn't pick the old value.
    expect(dispatchCfg.agents?.defaults?.workspace).toBeUndefined();
    // Other agents.defaults fields preserved.
    expect(dispatchCfg.agents?.defaults?.model).toBe('gpt-4');
  });

  it('T364 round 8 — dispatch merge does NOT mutate caller-owned mergedConfig.agents.defaults', async () => {
    // QA-flagged side-effect concern: pre-fix `mergeRouteMetadataWithMergedConfig`
    // created `result` via `{...mergedConfig, ...routeConfig}` (shallow
    // spread), so when routeConfig has no `agents` key, `result.agents`
    // and `result.agents.defaults` are still pointers into the caller's
    // runtime config. The scrub then mutated `mergedConfig.agents.defaults.workspace`
    // — visible to subsequent dispatches/observers as a delete-on-input
    // side-effect. Post-fix `scrubStaleAgentsDefaultsWorkspace` clones
    // the agents/defaults path before deleting, so caller-owned input
    // is preserved verbatim.
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'No-mutation reply' });
      },
    });
    const liveMergedConfig = {
      agents: { defaults: { workspace: '/should-not-be-mutated', model: 'gpt-4' } },
      plugins: {
        slots: { memory: 'adapter-openclaw' },
        entries: {
          'adapter-openclaw': {
            config: {
              daemonUrl: 'http://localhost:9350',
              memory: { enabled: true },
              channel: { enabled: true, port: 0 },
            },
          },
        },
      },
    };
    const before = JSON.stringify(liveMergedConfig);
    const freshRouteConfig = { workspaceDir: '/fresh-from-route' };
    const api = makeApi({
      cfg: freshRouteConfig,
      runtime: {
        ...runtime,
        config: liveMergedConfig,
      },
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    await plugin.processInbound('Hello', 'corr-no-mutation', 'owner');

    // Caller-owned mergedConfig MUST be unchanged after dispatch.
    expect(JSON.stringify(liveMergedConfig)).toBe(before);
    expect(liveMergedConfig.agents.defaults.workspace).toBe('/should-not-be-mutated');
    // Returned dispatch cfg DOES carry the scrubbed view (newer
    // workspaceDir wins, stale agents.defaults.workspace removed).
    const dispatchCfg = (runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg;
    expect(dispatchCfg.workspaceDir).toBe('/fresh-from-route');
    expect((dispatchCfg.agents as any)?.defaults?.workspace).toBeUndefined();
    expect((dispatchCfg.agents as any)?.defaults?.model).toBe('gpt-4');
  });

  it('keeps direct api.cfg ahead of stale api.pluginConfig for dispatch cfg fallback', async () => {
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Direct cfg reply' });
      },
    });
    const liveConfig = {
      daemonUrl: 'http://localhost:9300',
      channel: { enabled: true, port: 0 },
    };
    const stalePluginConfig = {
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
    };
    const api = makeApi({
      cfg: liveConfig,
      pluginConfig: stalePluginConfig,
      runtime,
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    const reply = await plugin.processInbound('Hello', 'corr-direct-cfg', 'owner');

    expect(reply.text).toBe('Direct cfg reply');
    expect((runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg).toEqual(liveConfig);
  });

  it.each(['cfg', 'config'] as const)('merges metadata-only api.%s with current api.pluginConfig for dispatch cfg fallback', async (sourceKey) => {
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Merged metadata reply' });
      },
    });
    const metadataOnlyConfig = {
      stateDir: '/workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/workspace',
    };
    const currentPluginConfig = {
      daemonUrl: 'http://localhost:9350',
      channel: { enabled: true, port: 0 },
    };
    const api = makeApi({
      [sourceKey]: metadataOnlyConfig,
      pluginConfig: currentPluginConfig,
      runtime,
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    const reply = await plugin.processInbound('Hello', 'corr-metadata-plugin-config', 'owner');

    expect(reply.text).toBe('Merged metadata reply');
    const dispatchCfg = (runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg;
    expect(dispatchCfg).not.toBe(metadataOnlyConfig);
    expect(dispatchCfg).toMatchObject({
      ...metadataOnlyConfig,
      daemonUrl: 'http://localhost:9350',
      channel: { enabled: true, port: 0 },
    });
  });

});
