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



  it('stop should account for a marker created after storeChatTurn settles during final shutdown drain', async () => {
    vi.useFakeTimers();
    try {
      let resolveStore!: () => void;
      const storePromise = new Promise<void>((resolve) => { resolveStore = resolve; });
      const { runtime } = makeMockRuntime({
        dispatchImpl: async (params) => {
          await params.dispatcherOptions.deliver({ text: 'Persisted reply' });
        },
      });
      const mockCfg = { session: { dmScope: 'main' }, agents: {} };

      const api = makeApi({
        logger: { info: trackFn(), warn: trackFn(), debug: trackFn() },
      } as any) as any;
      api.runtime = runtime;
      api.cfg = mockCfg;
      const storeCalls: unknown[][] = [];
      client.storeChatTurn = ((...args: unknown[]) => {
        storeCalls.push(args);
        return storePromise;
      }) as any;
      const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
      plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
      plugin.register(api);

      await plugin.processInbound('Late store', 'corr-late-marker-after-store', 'owner');
      await vi.advanceTimersByTimeAsync(10);
      expect(storeCalls).toHaveLength(1);
      expect((plugin as any).pendingTurnPersistence.size).toBe(1);
      expect(markExternalTurnPersistedDurable).not.toHaveBeenCalled();

      const stopPromise = plugin.stop();
      let stopSettled = false;
      void stopPromise.then(() => { stopSettled = true; });
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1_500);
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      expect(markExternalTurnPersistedDurable).not.toHaveBeenCalled();

      resolveStore();
      await stopPromise;

      expect(stopSettled).toBe(true);
      expect(storeCalls).toHaveLength(1);
      expect(markExternalTurnPersistedDurable).toHaveBeenCalledTimes(1);
      expect(markExternalTurnPersistedDurable).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: 'session-1',
        turnId: 'corr-late-marker-after-store',
        user: 'Late store',
        assistant: 'Persisted reply',
      }));
      expect((plugin as any).pendingTurnPersistence.size).toBe(0);
      expect((plugin as any).pendingMarkerPersistence.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop should not create a hidden marker job when storeChatTurn settles after the final shutdown window', async () => {
    vi.useFakeTimers();
    try {
      let resolveStore!: () => void;
      const storePromise = new Promise<void>((resolve) => { resolveStore = resolve; });
      const { runtime } = makeMockRuntime({
        dispatchImpl: async (params) => {
          await params.dispatcherOptions.deliver({ text: 'Persisted reply' });
        },
      });
      const mockCfg = { session: { dmScope: 'main' }, agents: {} };

      const api = makeApi({
        logger: { info: trackFn(), warn: trackFn(), debug: trackFn() },
      } as any) as any;
      api.runtime = runtime;
      api.cfg = mockCfg;
      const storeCalls: unknown[][] = [];
      client.storeChatTurn = ((...args: unknown[]) => {
        storeCalls.push(args);
        return storePromise;
      }) as any;
      const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
      plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
      plugin.register(api);

      await plugin.processInbound('Late timeout', 'corr-late-marker-after-timeout', 'owner');
      await vi.advanceTimersByTimeAsync(10);
      expect(storeCalls).toHaveLength(1);

      const stopPromise = plugin.stop();
      await vi.advanceTimersByTimeAsync(1_750);
      await stopPromise;

      expect((plugin as any).pendingTurnPersistence.size).toBe(0);
      expect((plugin as any).pendingMarkerPersistence.size).toBe(0);
      expect(markExternalTurnPersistedDurable).not.toHaveBeenCalled();

      resolveStore();
      await Promise.resolve();
      await Promise.resolve();

      expect(storeCalls).toHaveLength(1);
      expect(markExternalTurnPersistedDurable).not.toHaveBeenCalled();
      expect((plugin as any).pendingMarkerPersistence.size).toBe(0);
      expect(api.logger.warn.calls.some((call: unknown[]) =>
        String(call[0]).includes('completed after shutdown marker drain'),
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop should force one final ChatTurnWriter marker flush before dropping timed-out marker jobs', async () => {
    vi.useFakeTimers();
    try {
      let resolveSecondMarker!: () => void;
      const { runtime } = makeMockRuntime({
        dispatchImpl: async (params) => {
          await params.dispatcherOptions.deliver({ text: 'Persisted reply' });
        },
      });
      const mockCfg = { session: { dmScope: 'main' }, agents: {} };

      const api = makeApi({
        logger: { info: trackFn(), warn: trackFn(), debug: trackFn() },
      } as any) as any;
      api.runtime = runtime;
      api.cfg = mockCfg;
      client.storeChatTurn = async () => undefined as any;
      const markExternalTurnPersistedDurable = vi.fn()
        .mockRejectedValueOnce(new Error('marker disk outage'))
        .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSecondMarker = resolve; }));
      plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
      plugin.register(api);

      await plugin.processInbound('Already stored', 'corr-marker-stop-timeout', 'owner');
      await vi.advanceTimersByTimeAsync(10);
      expect(markExternalTurnPersistedDurable).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      expect(markExternalTurnPersistedDurable).toHaveBeenCalledTimes(2);
      expect((plugin as any).pendingMarkerPersistence.size).toBe(1);

      const stopPromise = plugin.stop();
      let stopSettled = false;
      void stopPromise.then(() => { stopSettled = true; });
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_500);
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      expect(markExternalTurnPersistedDurable).toHaveBeenCalledTimes(2);

      resolveSecondMarker();
      await stopPromise;

      expect(stopSettled).toBe(true);
      expect(markExternalTurnPersistedDurable).toHaveBeenCalledTimes(2);
      expect(markExternalTurnPersistedDurable).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionKey: 'session-1',
        turnId: 'corr-marker-stop-timeout',
        user: 'Already stored',
        assistant: 'Persisted reply',
      }));
      expect((plugin as any).pendingMarkerPersistence.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop should keep the final ChatTurnWriter marker flush bounded when the final write hangs', async () => {
    vi.useFakeTimers();
    try {
      const { runtime } = makeMockRuntime({
        dispatchImpl: async (params) => {
          await params.dispatcherOptions.deliver({ text: 'Persisted reply' });
        },
      });
      const mockCfg = { session: { dmScope: 'main' }, agents: {} };

      const api = makeApi({
        logger: { info: trackFn(), warn: trackFn(), debug: trackFn() },
      } as any) as any;
      api.runtime = runtime;
      api.cfg = mockCfg;
      client.storeChatTurn = async () => undefined as any;
      const markExternalTurnPersistedDurable = vi.fn()
        .mockRejectedValueOnce(new Error('marker disk outage'))
        .mockImplementation(() => new Promise(() => {}));
      plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
      plugin.register(api);

      await plugin.processInbound('Already stored', 'corr-marker-stop-timeout-hang', 'owner');
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(250);
      expect(markExternalTurnPersistedDurable).toHaveBeenCalledTimes(2);

      const stopPromise = plugin.stop();
      let stopSettled = false;
      void stopPromise.then(() => { stopSettled = true; });
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_500);
      await Promise.resolve();
      expect(markExternalTurnPersistedDurable).toHaveBeenCalledTimes(2);
      expect(stopSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(249);
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;

      expect(stopSettled).toBe(true);
      expect((plugin as any).pendingMarkerPersistence.size).toBe(0);
      expect(api.logger.warn.calls.some((call: unknown[]) =>
        String(call[0]).includes('Final ChatTurnWriter marker flush timed out'),
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persistTurn should use separate sessionId for non-owner identities', async () => {
    const { runtime } = makeMockRuntime({
      resolveAgentRouteImpl: () => ({ agentId: 'agent-1', sessionKey: 'session-1' }),
      formatAgentEnvelopeImpl: () => '[DKG UI] msg',
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'reply' });
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

    await plugin.processInbound('decide', 'corr-game', 'background-worker');
    await new Promise(r => setTimeout(r, 10));
    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui:background-worker',
      'decide',
      'reply',
      { turnId: 'corr-game' },
    ]);

    storeCalls.length = 0;

    await plugin.processInbound('hello', 'corr-owner', 'owner');
    await new Promise(r => setTimeout(r, 10));
    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'hello',
      'reply',
      { turnId: 'corr-owner' },
    ]);
  });

  it('processInbound should use SDK core wrappers that preserve runtime method context', async () => {
    const sessionCalls: any[] = [];
    const dispatchCalls: any[] = [];

    const { runtime } = makeMockRuntime();
    runtime.channel.session.recordInboundSession = function (this: any, params: any) {
      sessionCalls.push({ self: this, params });
    };
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = async function (this: any, params: any) {
      dispatchCalls.push({ self: this, params });
      await params.dispatcherOptions.deliver({ text: 'Hello from sdk path' });
    };

    const mockCfg = { session: { dmScope: 'main' }, agents: {} };
    const sdkCalls: unknown[][] = [];
    const mockSdk = {
      dispatchInboundReplyWithBase: async (params: any) => {
        sdkCalls.push([params]);
        await params.core.channel.session.recordInboundSession({
          storePath: params.storePath,
          sessionKey: params.route.sessionKey,
          ctx: params.ctxPayload,
        });
        await params.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: params.ctxPayload,
          cfg: params.cfg,
          dispatcherOptions: {
            deliver: params.deliver,
            onError: params.onDispatchError,
          },
          replyOptions: {},
        });
      },
    };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    client.storeChatTurn = async () => undefined as any;
    (plugin as any).sdk = mockSdk;
    plugin.register(api);

    const reply = await plugin.processInbound('Hello', 'corr-sdk', 'owner');

    expect(reply.text).toBe('Hello from sdk path');
    expect(sdkCalls).toHaveLength(1);
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0].self).toBe(runtime.channel.session);
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].self).toBe(runtime.channel.reply);
    expect(dispatchCalls[0].params).toMatchObject({
      ctx: expect.objectContaining({ BodyForAgent: 'Hello', SessionKey: 'session-1' }),
      cfg: mockCfg,
      replyOptions: {},
    });
  });

  it('processInbound should throw if api is not registered', async () => {
    await expect(plugin.processInbound('test', 'c-1', 'owner'))
      .rejects.toThrow('Channel not registered');
  });

  it('processInbound should throw if no routing mechanism available', async () => {
    const api = makeApi();
    plugin.register(api);

    await expect(plugin.processInbound('test', 'c-1', 'owner'))
      .rejects.toThrow('No message routing mechanism available');
  });

});
