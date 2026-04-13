import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DkgChannelPlugin, CHANNEL_NAME } from '../src/DkgChannelPlugin.js';
import { DkgDaemonClient } from '../src/dkg-client.js';
import type { OpenClawPluginApi } from '../src/types.js';

function makeApi(overrides?: Partial<OpenClawPluginApi>): OpenClawPluginApi {
  return {
    config: {},
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    ...overrides,
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

  beforeEach(() => {
    client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200', apiToken: 'test-token' });
    plugin = new DkgChannelPlugin({ enabled: true, port: 0 }, client);
  });

  afterEach(async () => {
    await plugin.stop();
    vi.restoreAllMocks();
  });

  it('should have channel name "dkg-ui"', () => {
    expect(CHANNEL_NAME).toBe('dkg-ui');
  });

  it('should start bridge server immediately on register', async () => {
    const api = makeApi();
    plugin.register(api);

    // Bridge starts asynchronously during register — no session_start hook needed
    expect(api.registerHook).not.toHaveBeenCalledWith(
      'session_start',
      expect.any(Function),
      expect.objectContaining({ name: 'dkg-channel-start' }),
    );
  });

  it('should call registerChannel if available', () => {
    const registerChannel = vi.fn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    expect(registerChannel).toHaveBeenCalledOnce();
    expect(registerChannel.mock.calls[0][0].plugin.id).toBe(CHANNEL_NAME);
  });

  it('should register a current-style channel config adapter for gateway health/runtime snapshots', async () => {
    const registerChannel = vi.fn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = registerChannel.mock.calls[0][0].plugin;
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
    const registerHttpRoute = vi.fn();
    const api = makeApi({ registerHttpRoute });
    plugin.register(api);

    expect(registerHttpRoute).toHaveBeenCalledTimes(2);
    expect(registerHttpRoute.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'POST', path: '/api/dkg-channel/inbound' }),
      expect.objectContaining({ method: 'GET', path: '/api/dkg-channel/health' }),
    ]));
  });

  it('should set useGatewayRoute when registerHttpRoute is available', () => {
    const registerHttpRoute = vi.fn();
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
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const mockRuntime = {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey: 'session-1' }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI Owner] Hello'),
          async dispatchReplyWithBufferedBlockDispatcher(params: any) {
            dispatched = params;
            await params.dispatcherOptions.deliver({ text: 'Hello from agent' });
          },
        },
      },
    };
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = mockRuntime;
    api.cfg = mockCfg;
    // Mock storeChatTurn to prevent actual HTTP call
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
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
    expect(recordInboundSession).toHaveBeenCalledWith(expect.objectContaining({
      storePath: '/tmp/store',
      sessionKey: 'session-1',
      ctx: expect.objectContaining({
        BodyForAgent: 'Hello',
        From: 'owner',
      }),
    }));
    expect(mockRuntime.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL_NAME }),
    );
  });

  it('processInbound should isolate non-owner identities into their own session', async () => {
    let dispatched: any;
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const mockRuntime = {
      channel: {
        routing: {
          // Return a fresh object each call so mutations don't leak between invocations.
          resolveAgentRoute: vi.fn().mockImplementation(() => ({ agentId: 'agent-1', sessionKey: 'session-1' })),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI background-worker] decide'),
          async dispatchReplyWithBufferedBlockDispatcher(params: any) {
            dispatched = params;
            await params.dispatcherOptions.deliver({ text: 'advance' });
          },
        },
      },
    };
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = mockRuntime;
    api.cfg = mockCfg;
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    plugin.register(api);

    // Non-owner identity gets its own session key
    const reply = await plugin.processInbound('decide', 'corr-game', 'background-worker');
    expect(reply.text).toBe('advance');
    expect(dispatched.ctx.SessionKey).toBe('agent:agent-1:background-worker');
    expect(recordInboundSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'agent:agent-1:background-worker',
    }));

    // Owner identity keeps the default session key
    const ownerReply = await plugin.processInbound('hello', 'corr-owner', 'owner');
    expect(ownerReply.text).toBe('advance');
    expect(dispatched.ctx.SessionKey).toBe('session-1');
  });

  it('processInbound should fall back to the legacy positional runtime dispatch when needed', async () => {
    const dispatchCalls: any[] = [];
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const mockRuntime = {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey: 'session-1' }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI Owner] Hello'),
          async dispatchReplyWithBufferedBlockDispatcher(ctx: any, cfg: any, opts: any, replyOptions: any) {
            dispatchCalls.push([ctx, cfg, opts, replyOptions]);
            await opts.deliver({ text: 'Hello from legacy runtime' });
          },
        },
      },
    };
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = mockRuntime;
    api.cfg = mockCfg;
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
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
    expect(recordInboundSession).toHaveBeenCalledWith(expect.objectContaining({
      storePath: '/tmp/store',
      sessionKey: 'session-1',
      ctx: expect.objectContaining({
        BodyForAgent: 'Hello',
        From: 'owner',
      }),
    }));
  });

  it('processInbound should persist turn to DKG after successful dispatch', async () => {
    const mockRuntime = {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey: 'session-1' }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI Owner] Hello'),
          async dispatchReplyWithBufferedBlockDispatcher(params: any) {
            await params.dispatcherOptions.deliver({ text: 'Agent reply' });
          },
        },
      },
    };
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = mockRuntime;
    api.cfg = mockCfg;
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    plugin.register(api);

    await plugin.processInbound('User message', 'corr-persist', 'owner');

    // Wait a tick for fire-and-forget promise to resolve
    await new Promise(r => setTimeout(r, 10));

    expect(storeSpy).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      'User message',
      'Agent reply',
      { turnId: 'corr-persist' },
    );
  });

  it('processInbound should retry turn persistence after a transient DKG failure', async () => {
    vi.useFakeTimers();
    try {
      const mockRuntime = {
        channel: {
          routing: {
            resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey: 'session-1' }),
          },
          session: {
            resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
            readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
            recordInboundSession: vi.fn(),
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
            formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI Owner] Retry me'),
            async dispatchReplyWithBufferedBlockDispatcher(params: any) {
              await params.dispatcherOptions.deliver({ text: 'Recovered reply' });
            },
          },
        },
      };
      const mockCfg = { session: { dmScope: 'main' }, agents: {} };

      const api = makeApi() as any;
      api.runtime = mockRuntime;
      api.cfg = mockCfg;
      const storeSpy = vi.spyOn(client, 'storeChatTurn')
        .mockRejectedValueOnce(new Error('temporary store outage'))
        .mockResolvedValueOnce(undefined);
      plugin.register(api);

      await plugin.processInbound('Retry me', 'corr-retry', 'owner');
      expect(storeSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      expect(storeSpy).toHaveBeenCalledTimes(2);
      expect(storeSpy).toHaveBeenLastCalledWith(
        'openclaw:dkg-ui',
        'Retry me',
        'Recovered reply',
        { turnId: 'corr-retry' },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('persistTurn should use separate sessionId for non-owner identities', async () => {
    const mockRuntime = {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockImplementation(() => ({ agentId: 'agent-1', sessionKey: 'session-1' })),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI] msg'),
          async dispatchReplyWithBufferedBlockDispatcher(params: any) {
            await params.dispatcherOptions.deliver({ text: 'reply' });
          },
        },
      },
    };
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = mockRuntime;
    api.cfg = mockCfg;
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    plugin.register(api);

    // background-worker identity → separate session
    await plugin.processInbound('decide', 'corr-game', 'background-worker');
    await new Promise(r => setTimeout(r, 10));
    expect(storeSpy).toHaveBeenCalledWith(
      'openclaw:dkg-ui:background-worker',
      'decide',
      'reply',
      { turnId: 'corr-game' },
    );

    storeSpy.mockClear();

    // owner identity → default session
    await plugin.processInbound('hello', 'corr-owner', 'owner');
    await new Promise(r => setTimeout(r, 10));
    expect(storeSpy).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      'hello',
      'reply',
      { turnId: 'corr-owner' },
    );
  });

  it('processInbound should use SDK core wrappers that preserve runtime method context', async () => {
    const sessionCalls: any[] = [];
    const dispatchCalls: any[] = [];
    const mockRuntime = {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey: 'session-1' }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession(this: any, params: any) {
            sessionCalls.push({ self: this, params });
          },
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI Owner] Hello'),
          async dispatchReplyWithBufferedBlockDispatcher(this: any, params: any) {
            dispatchCalls.push({ self: this, params });
            await params.dispatcherOptions.deliver({ text: 'Hello from sdk path' });
          },
        },
      },
    };
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };
    const mockSdk = {
      dispatchInboundReplyWithBase: vi.fn().mockImplementation(async (params: any) => {
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
      }),
    };

    const api = makeApi() as any;
    api.runtime = mockRuntime;
    api.cfg = mockCfg;
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    (plugin as any).sdk = mockSdk;
    plugin.register(api);

    const reply = await plugin.processInbound('Hello', 'corr-sdk', 'owner');

    expect(reply.text).toBe('Hello from sdk path');
    expect(mockSdk.dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0].self).toBe(mockRuntime.channel.session);
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].self).toBe(mockRuntime.channel.reply);
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
    // Register with a bare api (no runtime dispatch, no routeInboundMessage)
    const api = makeApi();
    plugin.register(api);

    await expect(plugin.processInbound('test', 'c-1', 'owner'))
      .rejects.toThrow('No message routing mechanism available');
  });

  it('processInbound should use routeInboundMessage when runtime dispatch is unavailable', async () => {
    const routeInboundMessage = vi.fn().mockResolvedValue({
      correlationId: 'corr-2',
      text: 'Reply!',
      turnId: 't-2',
    });
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    const reply = await plugin.processInbound('Hello', 'corr-2', 'owner');

    expect(routeInboundMessage).toHaveBeenCalledWith({
      channelName: CHANNEL_NAME,
      senderId: 'owner',
      senderIsOwner: true,
      text: 'Hello',
      correlationId: 'corr-2',
    });
    expect(reply.text).toBe('Reply!');
    expect(reply.correlationId).toBe('corr-2');

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storeSpy).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      'Hello',
      'Reply!',
      { turnId: 'corr-2' },
    );
  });

  it('processInboundStream should fall back to routeInboundMessage when streaming dispatch is unavailable', async () => {
    const routeInboundMessage = vi.fn().mockResolvedValue({
      correlationId: 'corr-stream',
      text: 'Reply from route',
    });
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    const events: Array<{ type: string; text?: string; correlationId?: string }> = [];
    for await (const event of plugin.processInboundStream('Hello', 'corr-stream', 'owner')) {
      events.push(event as any);
    }

    expect(routeInboundMessage).toHaveBeenCalledOnce();
    expect(events).toEqual([
      { type: 'final', text: 'Reply from route', correlationId: 'corr-stream' },
    ]);
  });

  it('processInboundStream should force block streaming in the direct runtime fallback', async () => {
    let dispatched: any;
    const mockRuntime = {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey: 'session-1' }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI Owner] Hello'),
          async dispatchReplyWithBufferedBlockDispatcher(params: any) {
            dispatched = params;
            await params.dispatcherOptions.deliver({ text: 'Streamed ' });
            await params.dispatcherOptions.deliver({ text: 'reply' });
          },
        },
      },
    };
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = mockRuntime;
    api.cfg = mockCfg;
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
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
    expect(storeSpy).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      'Hello',
      'Streamed reply',
      { turnId: 'corr-stream-runtime' },
    );
  });

  it('processInboundStream should persist a cancelled turn without storing the partial reply text', async () => {
    let resumeDispatch!: () => void;
    const mockRuntime = {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey: 'session-1' }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI Owner] Hello'),
          async dispatchReplyWithBufferedBlockDispatcher(params: any) {
            await params.dispatcherOptions.deliver({ text: 'Partial ' });
            await new Promise<void>((resolve) => { resumeDispatch = resolve; });
            await params.dispatcherOptions.deliver({ text: 'reply' });
          },
        },
      },
    };
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = mockRuntime;
    api.cfg = mockCfg;
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
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
    resumeDispatch();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(storeSpy).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      'Hello',
      '[OpenClaw reply cancelled before completion]',
      {
        turnId: 'corr-stream-cancel',
        persistenceState: 'failed',
        failureReason: 'cancelled',
      },
    );
  });

  it('processInboundStream should surface a real error when the agent returns no text', async () => {
    const mockRuntime = {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey: 'session-1' }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI Owner] Hello'),
          async dispatchReplyWithBufferedBlockDispatcher() {
            // Complete without yielding any text chunks.
          },
        },
      },
    };
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };

    const api = makeApi() as any;
    api.runtime = mockRuntime;
    api.cfg = mockCfg;
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    plugin.register(api);

    const stream = plugin.processInboundStream('Hello', 'corr-stream-empty', 'owner');
    await expect(stream.next()).rejects.toThrow('Agent returned no text response');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storeSpy).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      'Hello',
      '[OpenClaw reply failed before completion: Agent returned no text response]',
      {
        turnId: 'corr-stream-empty',
        persistenceState: 'failed',
        failureReason: 'Agent returned no text response',
      },
    );
  });

  it('processInboundStream should request block streaming when plugin-sdk helpers are available', async () => {
    const mockRuntime = {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey: 'session-1' }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI Owner] Hello'),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
      },
    };
    const mockCfg = { session: { dmScope: 'main' }, agents: {} };
    const mockSdk = {
      dispatchInboundReplyWithBase: vi.fn().mockImplementation(async (params: any) => {
        expect(params.replyOptions).toEqual({ disableBlockStreaming: false });
        await params.deliver({ text: 'SDK ' });
        await params.deliver({ text: 'reply' });
      }),
    };

    const api = makeApi() as any;
    api.runtime = mockRuntime;
    api.cfg = mockCfg;
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    (plugin as any).sdk = mockSdk;
    plugin.register(api);

    const events: Array<{ type: string; delta?: string; text?: string; correlationId?: string }> = [];
    for await (const event of plugin.processInboundStream('Hello', 'corr-stream-sdk', 'owner')) {
      events.push(event as any);
    }

    expect(mockSdk.dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
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

  it('stop should prevent a late persistence failure from scheduling retries after shutdown', async () => {
    vi.useFakeTimers();
    try {
      let rejectPersist!: (err: Error) => void;
      const mockRuntime = {
        channel: {
          routing: {
            resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey: 'session-1' }),
          },
          session: {
            resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
            readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
            recordInboundSession: vi.fn(),
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
            formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI Owner] Hello'),
            async dispatchReplyWithBufferedBlockDispatcher(params: any) {
              await params.dispatcherOptions.deliver({ text: 'Reply before shutdown' });
            },
          },
        },
      };
      const mockCfg = { session: { dmScope: 'main' }, agents: {} };

      const api = makeApi() as any;
      api.runtime = mockRuntime;
      api.cfg = mockCfg;
      const storeSpy = vi.spyOn(client, 'storeChatTurn').mockImplementationOnce(() =>
        new Promise<void>((_resolve, reject) => {
          rejectPersist = reject;
        }),
      );
      plugin.register(api);

      await plugin.processInbound('Hello', 'corr-stop-retry', 'owner');
      expect(storeSpy).toHaveBeenCalledTimes(1);

      await plugin.stop();
      rejectPersist(new Error('late persistence failure'));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(storeSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
