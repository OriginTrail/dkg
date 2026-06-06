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



  it.each(['cfg', 'config'] as const)('T364 — merges partial-channel api.%s overlay with current api.pluginConfig instead of masking it', async (sourceKey) => {
    // T364 regression for the Codex bug flagged on the merge of main into PR
    // #364: pre-fix `resolveDirectAdapterConfigFallback` only captured
    // state-metadata-only overlays and returned the first non-metadata
    // source verbatim. A higher-priority partial overlay like
    // `{ channel: { port: 9801 } }` (no `enabled` field) would mask the
    // lower-priority full adapter config in `api.pluginConfig` /
    // `runtime.*` — the channel ended up dispatching with an incomplete
    // `cfg` (no `daemonUrl`, no `memory.enabled`, etc.) which broke route
    // resolution on gateways that emit incremental direct config updates.
    //
    // Post-fix `isPartialAdapterConfigOverlay` is checked alongside the
    // state-metadata-only check; partial overlays are captured in
    // priority order and merged over the next full direct config.
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Partial overlay reply' });
      },
    });
    // Higher-priority partial overlay: just a partial channel block, no
    // `enabled` key (so isPartialAdapterConfigOverlay matches it).
    const partialChannelOverlay = {
      channel: { port: 9801 },
    };
    // Lower-priority full adapter config carrying the daemonUrl, memory,
    // and a baseline channel configuration that the overlay should layer
    // over rather than mask.
    const currentPluginConfig = {
      daemonUrl: 'http://localhost:9350',
      memory: { enabled: true },
      channel: { enabled: true, port: 9200 },
    };
    const api = makeApi({
      [sourceKey]: partialChannelOverlay,
      pluginConfig: currentPluginConfig,
      runtime,
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    const reply = await plugin.processInbound('Hello', 'corr-partial-overlay', 'owner');

    expect(reply.text).toBe('Partial overlay reply');
    const dispatchCfg = (runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg;
    // The dispatch cfg must carry the FULL config's daemonUrl + memory,
    // and the overlay's channel.port must win over the full config's
    // channel.port (deep-merge with later-wins semantic on module keys).
    expect(dispatchCfg).toMatchObject({
      daemonUrl: 'http://localhost:9350',
      memory: { enabled: true },
      channel: { enabled: true, port: 9801 },
    });
  });

  it('T364 — merges all overlays in priority order when no full direct config exists', async () => {
    // T364 follow-up regression: when EVERY discovered direct-config
    // source is a partial overlay (no full adapter config anywhere on
    // api.cfg/config/pluginConfig or runtime.*), the function previously
    // returned `overlays[0]` and dropped the rest — losing daemonUrl /
    // memory / channel fields that were available on lower-priority
    // overlays. Post-fix, all overlays are merged in priority order so
    // the highest priority wins on conflicts and lower priorities fill
    // in fields the higher overlays omit.
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'All-overlays merge reply' });
      },
    });
    // Highest-priority overlay: state metadata only (no daemonUrl/channel).
    const metadataOnlyOverlay = {
      stateDir: '/workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/workspace',
    };
    // Mid-priority overlay: partial channel (overrides channel.port).
    const partialChannelOverlay = {
      channel: { port: 9802 },
    };
    // Lowest-priority overlay: partial config carrying daemonUrl + a
    // baseline channel.host (no `enabled` so it's still partial).
    const partialDaemonOverlay = {
      daemonUrl: 'http://localhost:9555',
      channel: { host: '127.0.0.1' },
    };
    const api = makeApi({
      cfg: metadataOnlyOverlay,
      pluginConfig: partialChannelOverlay,
      runtime: {
        ...runtime,
        pluginConfig: partialDaemonOverlay,
      },
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    const reply = await plugin.processInbound('Hello', 'corr-all-overlays', 'owner');

    expect(reply.text).toBe('All-overlays merge reply');
    const dispatchCfg = (runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg;
    // Top-level keys: highest-priority metadataOnly (stateDir/Source/installedWorkspace)
    // wins, daemonUrl from runtime.pluginConfig fills the gap.
    expect(dispatchCfg).toMatchObject({
      stateDir: '/workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/workspace',
      daemonUrl: 'http://localhost:9555',
      // channel deep-merge: port from pluginConfig (mid-priority) overrides
      // host from runtime.pluginConfig (lowest); both fields are present
      // because module deep-merge preserves lower-priority defaults.
      channel: { port: 9802, host: '127.0.0.1' },
    });
  });

  it('keeps current api.pluginConfig ahead of runtime direct config fallback', async () => {
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Plugin config reply' });
      },
    });
    const currentPluginConfig = {
      daemonUrl: 'http://localhost:9400',
      channel: { enabled: true, port: 0 },
    };
    const staleRuntimeConfig = {
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
    };
    const api = makeApi({
      pluginConfig: currentPluginConfig,
      runtime: {
        ...runtime,
        config: staleRuntimeConfig,
      },
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    const reply = await plugin.processInbound('Hello', 'corr-plugin-config', 'owner');

    expect(reply.text).toBe('Plugin config reply');
    expect((runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg).toEqual(currentPluginConfig);
  });

  it('keeps route metadata while overlaying api.pluginConfig when api.cfg is not merged config', async () => {
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Route metadata fallback reply' });
      },
    });
    const currentPluginConfig = {
      daemonUrl: 'http://localhost:9500',
      channel: { enabled: true, port: 0 },
    };
    const staleRuntimeConfig = {
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
    };
    const routeMetadata = {
      agents: { defaults: { workspace: '/route-workspace' } },
      session: { ttlMs: 30_000 },
      workspace: '/route-workspace',
    };
    const api = makeApi({
      cfg: routeMetadata,
      pluginConfig: currentPluginConfig,
      runtime: {
        ...runtime,
        config: staleRuntimeConfig,
      },
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    const reply = await plugin.processInbound('Hello', 'corr-route-metadata', 'owner');

    expect(reply.text).toBe('Route metadata fallback reply');
    const dispatchCfg = (runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg;
    expect(dispatchCfg).not.toBe(routeMetadata);
    expect(dispatchCfg).toMatchObject({
      agents: routeMetadata.agents,
      session: routeMetadata.session,
      workspace: routeMetadata.workspace,
      plugins: {
        entries: {
          'adapter-openclaw': {
            config: currentPluginConfig,
          },
        },
      },
    });
    expect((routeMetadata as any).plugins).toBeUndefined();
  });

  it('keeps session-only route metadata while overlaying direct plugin config', async () => {
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Session metadata fallback reply' });
      },
    });
    const currentPluginConfig = {
      daemonUrl: 'http://localhost:9510',
      channel: { enabled: true, port: 0 },
    };
    const routeMetadata = {
      session: { dmScope: 'main', ttlMs: 30_000 },
    };
    const api = makeApi({
      cfg: routeMetadata,
      pluginConfig: currentPluginConfig,
      runtime,
    } as any);
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);

    plugin.register(api);
    const reply = await plugin.processInbound('Hello', 'corr-session-route-metadata', 'owner');

    expect(reply.text).toBe('Session metadata fallback reply');
    const dispatchCfg = (runtime as any).channel.routing.resolveAgentRoute.calls[0][0].cfg;
    expect(dispatchCfg).toMatchObject({
      session: routeMetadata.session,
      plugins: {
        entries: {
          'adapter-openclaw': {
            config: currentPluginConfig,
          },
        },
      },
    });
  });

  it('calls the pre-dispatch memory-slot reassert callback before processInbound runs (R9.1/R9.7)', async () => {
    const reassertSpy = vi.fn();
    plugin.setPreDispatchReAssert(reassertSpy);

    // Stub api so processInbound has the bare-minimum surface it needs;
    // we don't care about the dispatch result, only that reassert fired
    // before any further work.
    const mockApi = {
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
      runtime: undefined,
      cfg: undefined,
      routeInboundMessage: undefined,
    } as any;
    (plugin as any).api = mockApi;

    // processInbound throws once it can't find a dispatch route, but the
    // reassert is the FIRST thing it does — confirm spy fires exactly
    // once before the throw.
    await expect(
      plugin.processInbound('hello', 'corr-1', 'owner', {}),
    ).rejects.toThrow();
    expect(reassertSpy).toHaveBeenCalledTimes(1);
  });

  describe('formatInboundTurnDiagnostic (live-validation follow-up)', () => {
    // Diagnostic helper used by handleInboundHttp + handleInboundStreamHttp
    // to give operators runtime ground truth on envelope stamping. Without
    // this log line, a "can't see UI state" symptom from the agent is
    // indistinguishable from a React-state bug, a daemon-proxy dropout,
    // or an agent-interpretation issue. The formatter itself is pure so
    // we unit-test it directly; the HTTP handler wiring that calls it is
    // covered indirectly by existing processInbound/processInboundStream
    // tests.

    it('includes the correlation id, a present uiContextGraphId, and all context entry key=value pairs', () => {
      const line = formatInboundTurnDiagnostic(
        'corr-abc123',
        'agent-memory',
        [
          { key: 'target_context_graph', label: 'Target context graph', value: 'Agent Memory (agent-memory)' },
        ],
      );
      expect(line).toContain('correlationId=corr-abc123');
      expect(line).toContain('uiContextGraphId=agent-memory');
      expect(line).toContain('contextEntries=1');
      expect(line).toContain('target_context_graph=Agent Memory (agent-memory)');
    });

    it('renders the empty-envelope state with ∅ for uiContextGraphId and contextEntries=0', () => {
      const line = formatInboundTurnDiagnostic('corr-empty', undefined, undefined);
      expect(line).toContain('correlationId=corr-empty');
      expect(line).toContain('uiContextGraphId=∅');
      expect(line).toContain('contextEntries=0');
      // Empty envelope must not render a context-entries summary block
      // with dangling separators — the ` [key=value, ...]` suffix is
      // suppressed when count is zero so operators can visually tell
      // stamping is absent, not just empty. The `[dkg-channel]` prefix
      // bracket is still present, so this is a tail-shape check.
      expect(line).not.toMatch(/contextEntries=0 \[/);
      expect(line.trim().endsWith('contextEntries=0')).toBe(true);
    });

    it('joins multiple context entries with a comma in the summary block', () => {
      const line = formatInboundTurnDiagnostic(
        'corr-multi',
        'project-x',
        [
          { key: 'target_context_graph', label: 'Target context graph', value: 'Project X' },
          { key: 'user_role', label: 'User role', value: 'owner' },
        ],
      );
      expect(line).toContain('contextEntries=2');
      expect(line).toContain('target_context_graph=Project X');
      expect(line).toContain('user_role=owner');
      expect(line).toMatch(/target_context_graph=Project X, user_role=owner/);
    });

    it('strips control characters from every echoed field to defeat log-injection (QA review follow-up)', () => {
      // `normalizeChatContextEntry` only trims whitespace at parse time;
      // full control-char sanitization happens later in the dispatch
      // pipeline, AFTER this diagnostic log has already fired. So a
      // crafted envelope with a newline embedded in a value, key,
      // correlationId, or uiContextGraphId used to be able to inject a
      // forged log line. The formatter now runs its own
      // sanitizeDiagnosticField pass over every echoed field; this test
      // pins down the contract. Bridge auth also gates this attack
      // surface, but log integrity shouldn't be load-bearing on
      // authorization.
      const line = formatInboundTurnDiagnostic(
        'corr-with\nnewline',
        'project\r\nid',
        [
          { key: 'key\twith\ttabs', label: 'Label', value: 'foo\n[dkg-channel] FAKE LOG LINE: bar' },
          { key: 'normal_key', label: 'Normal', value: 'contains\x00null\x7fdel' },
        ],
      );
      // No raw control characters survive into the output — they are
      // all replaced with spaces. The real log prefix
      // `[dkg-channel] inbound turn:` must still appear exactly once,
      // meaning no injected forged line broke the envelope across
      // two lines. The bracket/literal text of the attempted injection
      // DOES appear inside the sanitized summary (as data, not as a
      // new log line), which is fine — the important invariant is
      // that it is on the same physical line as the real prefix.
      expect(line).not.toMatch(/[\u0000-\u001F\u007F]/);
      expect((line.match(/\[dkg-channel\] inbound turn:/g) ?? []).length).toBe(1);
      expect(line).toContain('correlationId=corr-with newline');
      // \r\n → two spaces.
      expect(line).toContain('uiContextGraphId=project  id');
      // Tabs → spaces, newline → space. The attacker's payload is
      // preserved as literal text inside the entry summary — that is
      // fine, it is data not a new log line.
      expect(line).toContain('key with tabs=foo [dkg-channel] FAKE LOG LINE: bar');
      // Null + DEL → spaces.
      expect(line).toContain('normal_key=contains null del');
    });
  });

  it('should start bridge server immediately on register', async () => {
    const api = makeApi();
    plugin.register(api);

    expect((api.registerHook as TrackingFn).calls.every(
      (call) => !(call[0] === 'session_start' && (call[2] as any)?.name === 'dkg-channel-start'),
    )).toBe(true);
  });

});
