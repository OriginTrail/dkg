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



  it('processInboundStream should force block streaming in the direct runtime fallback', async () => {
    let dispatched: any;
    const attachmentRefs = [
      {
        assertionUri: 'did:dkg:context-graph:cg-stream/assertion/notes',
        fileHash: 'sha256:stream123',
        contextGraphId: 'cg-stream',
        fileName: 'notes.md',
        detectedContentType: 'text/markdown',
      },
    ];
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
    const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
    plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
    plugin.register(api);

    const events: Array<{ type: string; delta?: string; text?: string; correlationId?: string }> = [];
    for await (const event of plugin.processInboundStream('Hello', 'corr-stream-runtime', 'owner', { attachmentRefs })) {
      events.push(event as any);
    }

    expect(dispatched).toMatchObject({
      ctx: expect.objectContaining({
        BodyForAgent: expect.stringContaining('Attached Working Memory items:'),
        RawBody: 'Hello',
        CommandBody: 'Hello',
        BodyForCommands: 'Hello',
        AttachmentRefs: attachmentRefs,
        DkgTurnId: 'corr-stream-runtime',
        CorrelationId: 'corr-stream-runtime',
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
      { turnId: 'corr-stream-runtime', attachmentRefs },
    ]);
    expect(markExternalTurnPersistedDurable).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'session-1',
      turnId: 'corr-stream-runtime',
      user: expect.stringContaining('Attached Working Memory items:'),
      userAliases: expect.arrayContaining(['Hello']),
      assistant: 'Streamed reply',
    }));
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

  it('stop should drain a disconnected stream whose dispatch has not settled yet', async () => {
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
    const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
    plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
    plugin.register(api);

    const stream = plugin.processInboundStream('Hello', 'corr-stream-cancel-stop', 'owner');
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'text_delta', delta: 'Partial ' },
    });
    await expect(stream.return(undefined)).resolves.toEqual({
      done: true,
      value: undefined,
    });

    const stopPromise = plugin.stop();
    let stopSettled = false;
    void stopPromise.then(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    resumeDispatch();
    await stopPromise;

    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'Hello',
      'Partial reply',
      { turnId: 'corr-stream-cancel-stop' },
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

  it('standalone bridge accepts attachment-only inbound requests', async () => {
    const routeInboundMessage = vi.fn().mockResolvedValue({
      correlationId: 'corr-attachment-only',
      text: 'Attachment-only reply',
    });
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);
    const port = await waitForBridgePort(plugin);
    const attachmentRefs = [{
      assertionUri: 'did:dkg:context-graph:cg-attach/assertion/chat-doc',
      fileHash: 'sha256:attach123',
      contextGraphId: 'cg-attach',
      fileName: 'chat-doc.pdf',
    }];

    const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dkg-bridge-token': 'test-token',
      },
      body: JSON.stringify({
        correlationId: 'corr-attachment-only',
        attachmentRefs,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      correlationId: 'corr-attachment-only',
      text: 'Attachment-only reply',
    });
    expect(routeInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: 'corr-attachment-only',
      text: expect.stringContaining('Attached Working Memory items:'),
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storeSpy).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      '',
      'Attachment-only reply',
      expect.objectContaining({
        turnId: 'corr-attachment-only',
        attachmentRefs,
      }),
    );
  });

});
