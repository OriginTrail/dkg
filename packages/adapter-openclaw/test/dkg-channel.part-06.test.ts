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



  // Issue #272: in OpenClaw versions where the gateway also binds the
  // configured channel port (e.g. 2026.3.31 with channels.dkg-ui.port = 9201),
  // the standalone bridge can't bind on its configured port. Earlier we
  // tried skipping the bridge entirely when gateway routes were registered,
  // but the gateway-side `/api/dkg-channel/health` route is auth:'gateway'
  // and rejects the daemon's no-auth probe — leaving the UI with no usable
  // health target. The bridge is the only transport the daemon trusts (via
  // the bridge auth token), so it must always start. start() now falls back
  // to an OS-allocated free port on EADDRINUSE so it always comes up.
  describe('issue #272 — standalone bridge always starts (with port fallback)', () => {
    it('calls start() when registerHttpRoute is available (gateway-route mode)', () => {
      const startSpy = vi.spyOn(plugin, 'start').mockResolvedValue(undefined);
      const api = makeApi({ registerHttpRoute: trackFn() });

      plugin.register(api);

      expect(plugin.isUsingGatewayRoute).toBe(true);
      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('calls start() when registerHttpRoute is unavailable (fallback bridge mode)', () => {
      const startSpy = vi.spyOn(plugin, 'start').mockResolvedValue(undefined);
      const api = makeApi(); // no registerHttpRoute

      plugin.register(api);

      expect(plugin.isUsingGatewayRoute).toBe(false);
      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('calls start() when registerChannel and registerHttpRoute are both available', () => {
      const startSpy = vi.spyOn(plugin, 'start').mockResolvedValue(undefined);
      const registerChannel = trackFn();
      const registerHttpRoute = trackFn();
      const api = makeApi({ registerChannel, registerHttpRoute });

      plugin.register(api);

      expect(plugin.isUsingGatewayRoute).toBe(true);
      expect(registerChannel.calls).toHaveLength(1);
      expect(registerHttpRoute.calls).toHaveLength(2);
      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    // Drives the port-fallback path: pre-bind a server on a port, then ask
    // the plugin to listen on the same port. start() must catch EADDRINUSE
    // and re-listen on an OS-allocated port; the bound port surfaces via
    // bridgePort, and a diagnostic info log captures the fallback. A
    // refactor that drops the fallback silently regresses both #272 envs.
    it('falls back to an OS-allocated port on EADDRINUSE', async () => {
      const blocker = createServer(() => {});
      try {
        await new Promise<void>((resolve, reject) => {
          blocker.once('error', reject);
          blocker.listen(0, '127.0.0.1', () => resolve());
        });
        const blockerAddr = blocker.address();
        const blockerPort = typeof blockerAddr === 'object' && blockerAddr ? blockerAddr.port : 0;
        expect(blockerPort).toBeGreaterThan(0);

        const conflictClient = new DkgDaemonClient({ baseUrl: 'http://localhost:9200', apiToken: 'test-token' });
        const conflictPlugin = new DkgChannelPlugin({ enabled: true, port: blockerPort }, conflictClient);
        // Capture info logs so we can lock the operator-greppable fallback
        // diagnostic. register() wires api.logger into the plugin; start()
        // emits the fallback line via api.logger.info when EADDRINUSE fires.
        const infoCalls: unknown[][] = [];
        const api = makeApi({ logger: { info: (...args: unknown[]) => infoCalls.push(args) } });
        conflictPlugin.register(api);
        await conflictPlugin.start();

        try {
          expect(conflictPlugin.bridgePort).toBeGreaterThan(0);
          expect(conflictPlugin.bridgePort).not.toBe(blockerPort);
          // Refactor that drops the fallback log silently regresses operator
          // observability — issue #272 troubleshooting greps for this line.
          expect(
            infoCalls.some((call) => String(call[0]).includes('falling back to an OS-allocated free port')),
          ).toBe(true);
        } finally {
          await conflictPlugin.stop();
        }
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    // Symmetric to the env-A fallback test: when the configured port is FREE,
    // start() must bind it directly with no fallback log. Uses port 0 — the
    // OS guarantees an available port and assigns a real one — so there is
    // no TOCTOU race against another process and no possibility of EADDRINUSE
    // forcing an unintended fallback. The discriminator vs the env-A test is
    // the absence of the fallback log; if start() ever silently fell back on
    // this path (it shouldn't with a free port), this assertion catches it.
    it('binds the configured port directly when no conflict (no fallback)', async () => {
      const directClient = new DkgDaemonClient({ baseUrl: 'http://localhost:9200', apiToken: 'test-token' });
      const directPlugin = new DkgChannelPlugin({ enabled: true, port: 0 }, directClient);
      const infoCalls: unknown[][] = [];
      const api = makeApi({ logger: { info: (...args: unknown[]) => infoCalls.push(args) } });
      directPlugin.register(api);
      await directPlugin.start();

      try {
        expect(directPlugin.bridgePort).toBeGreaterThan(0);
        expect(
          infoCalls.some((call) => String(call[0]).includes('falling back to an OS-allocated free port')),
        ).toBe(false);
      } finally {
        await directPlugin.stop();
      }
    });
  });

  it('processInbound should use the current object-style runtime dispatch when plugin-sdk helpers are unavailable', async () => {
    let dispatched: any;
    const { runtime, recordInboundSession } = makeMockRuntime({
      dispatchImpl: async (params) => {
        dispatched = params;
        await params.dispatcherOptions.deliver({ text: 'Hello from agent' });
      },
    });
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
    plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
    plugin.register(api);

    const reply = await plugin.processInbound('Hello', 'corr-1', 'owner');

    expect(reply.text).toBe('Hello from agent');
    expect(reply.correlationId).toBe('corr-1');
    expect(reply.sessionKey).toBe('session-1');
    expect(dispatched).toMatchObject({
      ctx: expect.objectContaining({
        BodyForAgent: 'Hello',
        DkgTurnId: 'corr-1',
        CorrelationId: 'corr-1',
        SessionKey: 'session-1',
      }),
      cfg: mockCfg,
      dispatcherOptions: expect.objectContaining({
        deliver: expect.any(Function),
        onError: expect.any(Function),
      }),
      replyOptions: {},
    });
    expect(recordInboundSession.calls[0][0]).toEqual(expect.objectContaining({
      storePath: '/tmp/store',
      sessionKey: 'session-1',
      ctx: expect.objectContaining({
        BodyForAgent: 'Hello',
        DkgTurnId: 'corr-1',
        CorrelationId: 'corr-1',
        From: 'owner',
      }),
    }));
    expect((runtime.channel.routing.resolveAgentRoute as TrackingFn).calls[0][0]).toEqual(
      expect.objectContaining({ channel: CHANNEL_NAME }),
    );
  });

  it('processInbound should isolate non-owner identities into their own session', async () => {
    let dispatched: any;
    const { runtime, recordInboundSession } = makeMockRuntime({
      resolveAgentRouteImpl: () => ({ agentId: 'agent-1', sessionKey: 'session-1' }),
      formatAgentEnvelopeImpl: () => '[DKG UI background-worker] decide',
      dispatchImpl: async (params) => {
        dispatched = params;
        await params.dispatcherOptions.deliver({ text: 'advance' });
      },
    });
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    client.storeChatTurn = async () => undefined as any;
    plugin.register(api);

    const reply = await plugin.processInbound('decide', 'corr-game', 'background-worker');
    expect(reply.text).toBe('advance');
    expect(dispatched.ctx.SessionKey).toBe('agent:agent-1:background-worker');
    expect(recordInboundSession.calls[0][0]).toEqual(expect.objectContaining({
      sessionKey: 'agent:agent-1:background-worker',
    }));

    const ownerReply = await plugin.processInbound('hello', 'corr-owner', 'owner');
    expect(ownerReply.text).toBe('advance');
    expect(dispatched.ctx.SessionKey).toBe('session-1');
  });

  it('processInbound should fall back to the legacy positional runtime dispatch when needed', async () => {
    const dispatchCalls: any[] = [];
    const { runtime, recordInboundSession } = makeMockRuntime();

    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = async function (ctx: any, cfg: any, opts: any, replyOptions: any) {
      dispatchCalls.push([ctx, cfg, opts, replyOptions]);
      await opts.deliver({ text: 'Hello from legacy runtime' });
    };

    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    client.storeChatTurn = async () => undefined as any;
    plugin.register(api);

    const reply = await plugin.processInbound('Hello', 'corr-legacy', 'owner');

    expect(reply.text).toBe('Hello from legacy runtime');
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0][0]).toMatchObject({ BodyForAgent: 'Hello', SessionKey: 'session-1' });
    expect(dispatchCalls[0][1]).toEqual(mockCfg);
    expect(dispatchCalls[0][2]).toMatchObject({
      deliver: expect.any(Function),
      onError: expect.any(Function),
    });
    expect(dispatchCalls[0][3]).toEqual({});
    expect(recordInboundSession.calls[0][0]).toEqual(expect.objectContaining({
      storePath: '/tmp/store',
      sessionKey: 'session-1',
      ctx: expect.objectContaining({
        BodyForAgent: 'Hello',
        From: 'owner',
      }),
    }));
  });

  it('processInbound should persist turn to DKG after successful dispatch', async () => {
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Agent reply' });
      },
    });
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
    plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
    plugin.register(api);

    await plugin.processInbound('User message', 'corr-persist', 'owner');

    await new Promise(r => setTimeout(r, 10));

    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'User message',
      'Agent reply',
      { turnId: 'corr-persist' },
    ]);
    expect(markExternalTurnPersistedDurable).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'session-1',
      turnId: 'corr-persist',
      user: 'User message',
      userAliases: expect.arrayContaining(['[DKG UI Owner] Hello', 'User message']),
      assistant: 'Agent reply',
    }));
  });

  it('processInbound should persist without throwing when ChatTurnWriter is not wired', async () => {
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Agent reply' });
      },
    });
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    plugin.register(api);

    await expect(plugin.processInbound('User message', 'corr-no-writer', 'owner')).resolves.toMatchObject({
      text: 'Agent reply',
      correlationId: 'corr-no-writer',
    });
    await new Promise(r => setTimeout(r, 10));

    expect(storeCalls).toHaveLength(1);
    expect((plugin as any).pendingMarkerPersistence.size).toBe(0);
  });

});
