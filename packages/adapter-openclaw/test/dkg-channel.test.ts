import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DkgChannelPlugin, CHANNEL_NAME } from '../src/DkgChannelPlugin.js';
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

  it('should start bridge server immediately on register', async () => {
    const api = makeApi();
    plugin.register(api);

    expect((api.registerHook as TrackingFn).calls.every(
      (call) => !(call[0] === 'session_start' && (call[2] as any)?.name === 'dkg-channel-start'),
    )).toBe(true);
  });

  it('should call registerChannel if available', () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    expect(registerChannel.calls).toHaveLength(1);
    expect((registerChannel.calls[0][0] as any).plugin.id).toBe(CHANNEL_NAME);
  });

  it('should register a current-style channel config adapter for gateway health/runtime snapshots', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    expect(registeredPlugin.config.listAccountIds({})).toEqual(['default']);
    expect(registeredPlugin.config.defaultAccountId({})).toBe('default');
    expect(registeredPlugin.config.isEnabled({}, {})).toBe(true);
    expect(registeredPlugin.config.resolveAccount({}, undefined)).toMatchObject({
      accountId: 'default',
      enabled: true,
      name: 'DKG UI',
    });
    await expect(registeredPlugin.config.isConfigured({}, {})).resolves.toBe(true);
    expect(registeredPlugin.config.describeAccount({ accountId: 'default', name: 'DKG UI' }, {})).toMatchObject({
      accountId: 'default',
      enabled: true,
      configured: true,
      linked: true,
    });
  });

  it('should call registerHttpRoute if available', () => {
    const registerHttpRoute = trackFn();
    const api = makeApi({ registerHttpRoute });
    plugin.register(api);

    expect(registerHttpRoute.calls).toHaveLength(2);
    expect(registerHttpRoute.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'POST', path: '/api/dkg-channel/inbound' }),
      expect.objectContaining({ method: 'GET', path: '/api/dkg-channel/health' }),
    ]));
  });

  it('should set useGatewayRoute when registerHttpRoute is available', () => {
    const registerHttpRoute = trackFn();
    const api = makeApi({ registerHttpRoute });
    plugin.register(api);

    expect(plugin.isUsingGatewayRoute).toBe(true);
  });

  it('should not set useGatewayRoute when registerHttpRoute is not available', () => {
    const api = makeApi();
    plugin.register(api);

    expect(plugin.isUsingGatewayRoute).toBe(false);
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
    plugin.register(api);

    const reply = await plugin.processInbound('Hello', 'corr-1', 'owner');

    expect(reply.text).toBe('Hello from agent');
    expect(reply.correlationId).toBe('corr-1');
    expect(dispatched).toMatchObject({
      ctx: expect.objectContaining({
        BodyForAgent: 'Hello',
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
    expect(dispatchCalls[0][1]).toBe(mockCfg);
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
    plugin.register(api);

    await plugin.processInbound('User message', 'corr-persist', 'owner');

    await new Promise(r => setTimeout(r, 10));

    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'User message',
      'Agent reply',
      { turnId: 'corr-persist' },
    ]);
  });

  it('processInbound should retry turn persistence after a transient DKG failure', async () => {
    vi.useFakeTimers();
    try {
      const { runtime } = makeMockRuntime({
        dispatchImpl: async (params) => {
          await params.dispatcherOptions.deliver({ text: 'Recovered reply' });
        },
      });
      const mockCfg = { session: { dmScope: 'main' }, agents: {} };

      const api = makeApi() as any;
      api.runtime = runtime;
      api.cfg = mockCfg;
      const storeCalls: unknown[][] = [];
      let storeCallCount = 0;
      client.storeChatTurn = async (...args: unknown[]) => {
        storeCalls.push(args);
        storeCallCount++;
        if (storeCallCount === 1) throw new Error('temporary store outage');
        return undefined as any;
      };
      plugin.register(api);

      await plugin.processInbound('Retry me', 'corr-retry', 'owner');
      expect(storeCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(250);
      expect(storeCalls).toHaveLength(2);
      expect(storeCalls[storeCalls.length - 1]).toEqual([
        'openclaw:dkg-ui',
        'Retry me',
        'Recovered reply',
        { turnId: 'corr-retry' },
      ]);
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

  it('processInbound should use routeInboundMessage when runtime dispatch is unavailable', async () => {
    const routeInboundMessage = trackAsyncFn(async () => ({
      correlationId: 'corr-2',
      text: 'Reply!',
      turnId: 't-2',
    }));
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    const reply = await plugin.processInbound('Hello', 'corr-2', 'owner');

    expect(routeInboundMessage.calls[0][0]).toEqual({
      channelName: CHANNEL_NAME,
      senderId: 'owner',
      senderIsOwner: true,
      text: 'Hello',
      correlationId: 'corr-2',
    });
    expect(reply.text).toBe('Reply!');
    expect(reply.correlationId).toBe('corr-2');

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'Hello',
      'Reply!',
      { turnId: 'corr-2' },
    ]);
  });

  it('processInboundStream should fall back to routeInboundMessage when streaming dispatch is unavailable', async () => {
    const routeInboundMessage = trackAsyncFn(async () => ({
      correlationId: 'corr-stream',
      text: 'Reply from route',
    }));
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    const events: Array<{ type: string; text?: string; correlationId?: string }> = [];
    for await (const event of plugin.processInboundStream('Hello', 'corr-stream', 'owner')) {
      events.push(event as any);
    }

    expect(routeInboundMessage.calls).toHaveLength(1);
    expect(events).toEqual([
      { type: 'final', text: 'Reply from route', correlationId: 'corr-stream' },
    ]);
  });

  it('processInboundStream should force block streaming in the direct runtime fallback', async () => {
    let dispatched: any;
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        dispatched = params;
        await params.dispatcherOptions.deliver({ text: 'Streamed ' });
        await params.dispatcherOptions.deliver({ text: 'reply' });
      },
    });
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    plugin.register(api);

    const events: Array<{ type: string; delta?: string; text?: string; correlationId?: string }> = [];
    for await (const event of plugin.processInboundStream('Hello', 'corr-stream-runtime', 'owner')) {
      events.push(event as any);
    }

    expect(dispatched).toMatchObject({
      ctx: expect.objectContaining({
        BodyForAgent: 'Hello',
        SessionKey: 'session-1',
      }),
      cfg: mockCfg,
      dispatcherOptions: expect.objectContaining({
        deliver: expect.any(Function),
        onError: expect.any(Function),
      }),
      replyOptions: { disableBlockStreaming: false },
    });
    expect(events).toEqual([
      { type: 'text_delta', delta: 'Streamed ' },
      { type: 'text_delta', delta: 'reply' },
      { type: 'final', text: 'Streamed reply', correlationId: 'corr-stream-runtime' },
    ]);
    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'Hello',
      'Streamed reply',
      { turnId: 'corr-stream-runtime' },
    ]);
  });

  it('processInboundStream should wait for a still-running dispatch to settle before persisting a closed stream', async () => {
    let resumeDispatch!: () => void;
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Partial ' });
        await new Promise<void>((resolve) => { resumeDispatch = resolve; });
        await params.dispatcherOptions.deliver({ text: 'reply' });
      },
    });
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    plugin.register(api);

    const stream = plugin.processInboundStream('Hello', 'corr-stream-cancel', 'owner');
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'text_delta', delta: 'Partial ' },
    });
    await expect(stream.return(undefined)).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(storeCalls).toHaveLength(0);
    resumeDispatch();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'Hello',
      'Partial reply',
      { turnId: 'corr-stream-cancel' },
    ]);
  });

  it('processInboundStream should persist the completed reply when final completion was already queued before the consumer stopped iterating', async () => {
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        await params.dispatcherOptions.deliver({ text: 'Complete reply' });
      },
    });
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    plugin.register(api);

    const stream = plugin.processInboundStream('Hello', 'corr-stream-finished-before-return', 'owner');
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'text_delta', delta: 'Complete reply' },
    });
    await expect(stream.return(undefined)).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'Hello',
      'Complete reply',
      { turnId: 'corr-stream-finished-before-return' },
    ]);
  });

  it('processInboundStream should surface a real error when the agent returns no text', async () => {
    const { runtime } = makeMockRuntime();

    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    plugin.register(api);

    const stream = plugin.processInboundStream('Hello', 'corr-stream-empty', 'owner');
    await expect(stream.next()).rejects.toThrow('Agent returned no text response');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'Hello',
      '[OpenClaw reply failed before completion: Agent returned no text response]',
      {
        turnId: 'corr-stream-empty',
        persistenceState: 'failed',
        failureReason: 'Agent returned no text response',
      },
    ]);
  });

  it('processInboundStream should request block streaming when plugin-sdk helpers are available', async () => {
    const { runtime } = makeMockRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = trackFn();

    const mockCfg = { session: { dmScope: 'main' }, agents: {} };
    const sdkCalls: unknown[][] = [];
    const mockSdk = {
      dispatchInboundReplyWithBase: async (params: any) => {
        sdkCalls.push([params]);
        expect(params.replyOptions).toEqual({ disableBlockStreaming: false });
        await params.deliver({ text: 'SDK ' });
        await params.deliver({ text: 'reply' });
      },
    };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    client.storeChatTurn = async () => undefined as any;
    (plugin as any).sdk = mockSdk;
    plugin.register(api);

    const events: Array<{ type: string; delta?: string; text?: string; correlationId?: string }> = [];
    for await (const event of plugin.processInboundStream('Hello', 'corr-stream-sdk', 'owner')) {
      events.push(event as any);
    }

    expect(sdkCalls).toHaveLength(1);
    expect(events).toEqual([
      { type: 'text_delta', delta: 'SDK ' },
      { type: 'text_delta', delta: 'reply' },
      { type: 'final', text: 'SDK reply', correlationId: 'corr-stream-sdk' },
    ]);
  });

  it('standalone bridge health endpoint requires the bridge auth token', async () => {
    const api = makeApi();
    plugin.register(api);
    const port = await waitForBridgePort(plugin);
    const unauthorizedRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(unauthorizedRes.status).toBe(401);

    const authorizedRes = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'x-dkg-bridge-token': 'test-token' },
    });
    expect(authorizedRes.status).toBe(200);
    await expect(authorizedRes.json()).resolves.toMatchObject({ ok: true, channel: CHANNEL_NAME });
  });

  it('standalone bridge rejects CORS preflight requests', async () => {
    const api = makeApi();
    plugin.register(api);
    const port = await waitForBridgePort(plugin);
    const res = await fetch(`http://127.0.0.1:${port}/inbound`, { method: 'OPTIONS' });
    expect(res.status).toBe(405);
  });

  it('stop should be safe to call multiple times', async () => {
    const api = makeApi();
    plugin.register(api);

    await plugin.stop();
    await plugin.stop();
  });

  it('stop should allow a late non-stream persistence failure to retry within the bounded shutdown window', async () => {
    vi.useFakeTimers();
    try {
      let rejectPersist!: (err: Error) => void;
      const { runtime } = makeMockRuntime({
        dispatchImpl: async (params) => {
          await params.dispatcherOptions.deliver({ text: 'Reply before shutdown' });
        },
      });
      const mockCfg = { session: { dmScope: 'main' }, agents: {} };

      const api = makeApi() as any;
      api.runtime = runtime;
      api.cfg = mockCfg;
      const storeCalls: unknown[][] = [];
      let storeCallCount = 0;
      client.storeChatTurn = ((...args: unknown[]) => {
        storeCalls.push(args);
        storeCallCount++;
        if (storeCallCount === 1) {
          return new Promise<void>((_resolve, reject) => {
            rejectPersist = reject;
          });
        }
        return Promise.resolve(undefined);
      }) as any;
      plugin.register(api);

      await plugin.processInbound('Hello', 'corr-stop-retry', 'owner');
      expect(storeCalls).toHaveLength(1);

      const stopPromise = plugin.stop();
      rejectPersist(new Error('late persistence failure'));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(249);
      expect(storeCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;

      expect(storeCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop should preserve an already-scheduled shutdown-allowed persistence retry within the bounded drain window', async () => {
    vi.useFakeTimers();
    try {
      const { runtime } = makeMockRuntime({
        dispatchImpl: async (params) => {
          await params.dispatcherOptions.deliver({ text: 'Reply before shutdown' });
        },
      });
      const mockCfg = { session: { dmScope: 'main' }, agents: {} };

      const api = makeApi() as any;
      api.runtime = runtime;
      api.cfg = mockCfg;
      const storeCalls: unknown[][] = [];
      let storeCallCount = 0;
      client.storeChatTurn = (async (...args: unknown[]) => {
        storeCalls.push(args);
        storeCallCount++;
        if (storeCallCount === 1) throw new Error('temporary daemon outage');
        return undefined;
      }) as any;
      plugin.register(api);

      await plugin.processInbound('Hello', 'corr-stop-preserve-retry', 'owner');
      expect(storeCalls).toHaveLength(1);

      await Promise.resolve();
      const stopPromise = plugin.stop();

      await vi.advanceTimersByTimeAsync(249);
      expect(storeCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;

      expect(storeCalls).toHaveLength(2);
      expect(storeCalls[storeCalls.length - 1]).toEqual([
        'openclaw:dkg-ui',
        'Hello',
        'Reply before shutdown',
        { turnId: 'corr-stop-preserve-retry' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('processInbound should still persist a completed non-stream reply when shutdown has already begun', async () => {
    let resumeDispatch!: () => void;
    let markDispatchReady!: () => void;
    const dispatchReady = new Promise<void>((resolve) => { markDispatchReady = resolve; });
    const { runtime } = makeMockRuntime({
      dispatchImpl: async (params) => {
        markDispatchReady();
        await new Promise<void>((resolve) => { resumeDispatch = resolve; });
        await params.dispatcherOptions.deliver({ text: 'Reply before shutdown' });
      },
    });
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = runtime;
    api.cfg = mockCfg;
    let resolveStore!: () => void;
    const storePromise = new Promise<void>((resolve) => { resolveStore = resolve; });
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = ((...args: unknown[]) => { storeCalls.push(args); return storePromise; }) as any;
    plugin.register(api);

    const replyPromise = plugin.processInbound('Hello', 'corr-stop-nonstream', 'owner');
    await dispatchReady;
    const stopPromise = plugin.stop();
    resumeDispatch();

    await expect(replyPromise).resolves.toEqual({
      text: 'Reply before shutdown',
      correlationId: 'corr-stop-nonstream',
    });

    let stopSettled = false;
    void stopPromise.then(() => { stopSettled = true; });
    await Promise.resolve();
    expect(storeCalls).toHaveLength(1);
    expect(stopSettled).toBe(false);

    resolveStore();
    await stopPromise;
    expect(stopSettled).toBe(true);
    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'Hello',
      'Reply before shutdown',
      { turnId: 'corr-stop-nonstream' },
    ]);
  });

  it('stop should only wait a bounded time for a final turn persistence attempt that hangs during shutdown', async () => {
    vi.useFakeTimers();
    try {
      let resumeDispatch!: () => void;
      const { runtime } = makeMockRuntime({
        dispatchImpl: async (params) => {
          await params.dispatcherOptions.deliver({ text: 'Reply before shutdown' });
          await new Promise<void>((resolve) => { resumeDispatch = resolve; });
        },
      });
      const mockCfg = { session: { dmScope: 'main' }, agents: {} };

      const api = makeApi() as any;
      api.runtime = runtime;
      api.cfg = mockCfg;
      let resolveStore!: () => void;
      const storePromise = new Promise<void>((resolve) => { resolveStore = resolve; });
      const storeCalls: unknown[][] = [];
      client.storeChatTurn = ((...args: unknown[]) => { storeCalls.push(args); return storePromise; }) as any;
      plugin.register(api);

      const stream = plugin.processInboundStream('Hello', 'corr-stream-stop-store', 'owner');
      await expect(stream.next()).resolves.toEqual({
        done: false,
        value: { type: 'text_delta', delta: 'Reply before shutdown' },
      });

      const nextItem = stream.next();
      const stopPromise = plugin.stop();
      resumeDispatch();
      await expect(nextItem).resolves.toEqual({
        done: false,
        value: { type: 'final', text: 'Reply before shutdown', correlationId: 'corr-stream-stop-store' },
      });
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });

      let stopSettled = false;
      void stopPromise.then(() => { stopSettled = true; });
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_500);
      await stopPromise;
      expect(stopSettled).toBe(true);
      expect((plugin as any).pendingTurnPersistence.size).toBe(0);

      expect(storeCalls).toHaveLength(1);
      expect(storeCalls[0]).toEqual([
        'openclaw:dkg-ui',
        'Hello',
        'Reply before shutdown',
        { turnId: 'corr-stream-stop-store' },
      ]);

      resolveStore();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop should retry a shutdown-allowed final turn persistence attempt within the bounded drain window', async () => {
    vi.useFakeTimers();
    try {
      let resumeDispatch!: () => void;
      const { runtime } = makeMockRuntime({
        dispatchImpl: async (params) => {
          await params.dispatcherOptions.deliver({ text: 'Reply before shutdown' });
          await new Promise<void>((resolve) => { resumeDispatch = resolve; });
        },
      });
      const mockCfg = { session: { dmScope: 'main' }, agents: {} };

      const api = makeApi() as any;
      api.runtime = runtime;
      api.cfg = mockCfg;
      const storeCalls: unknown[][] = [];
      let storeCallCount = 0;
      client.storeChatTurn = (async (...args: unknown[]) => {
        storeCalls.push(args);
        storeCallCount++;
        if (storeCallCount === 1) throw new Error('temporary daemon outage');
        return undefined;
      }) as any;
      plugin.register(api);

      const stream = plugin.processInboundStream('Hello', 'corr-stream-stop-retry', 'owner');
      await expect(stream.next()).resolves.toEqual({
        done: false,
        value: { type: 'text_delta', delta: 'Reply before shutdown' },
      });

      const nextItem = stream.next();
      const stopPromise = plugin.stop();
      resumeDispatch();
      await expect(nextItem).resolves.toEqual({
        done: false,
        value: { type: 'final', text: 'Reply before shutdown', correlationId: 'corr-stream-stop-retry' },
      });
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });

      let stopSettled = false;
      void stopPromise.then(() => { stopSettled = true; });
      await Promise.resolve();
      expect(storeCalls).toHaveLength(1);
      expect(stopSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(249);
      expect(storeCalls).toHaveLength(1);
      expect(stopSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;
      expect(storeCalls).toHaveLength(2);
      expect(stopSettled).toBe(true);
      expect(storeCalls[storeCalls.length - 1]).toEqual([
        'openclaw:dkg-ui',
        'Hello',
        'Reply before shutdown',
        { turnId: 'corr-stream-stop-retry' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
