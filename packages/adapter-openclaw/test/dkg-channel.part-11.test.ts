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



  it('standalone bridge accepts context-only inbound requests', async () => {
    const routeInboundMessage = vi.fn().mockResolvedValue({
      correlationId: 'corr-context-only',
      text: 'Context-only reply',
    });
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);
    const port = await waitForBridgePort(plugin);
    const contextEntries = [{
      key: 'attachment_import_result_verified',
      label: 'Attachment import result: skipped.epub',
      value: JSON.stringify({
        assertionUri: 'did:dkg:context-graph:cg-attach/assertion/skipped',
        fileHash: 'sha256:skip',
        extractionStatus: 'skipped',
      }),
    }];

    const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dkg-bridge-token': 'test-token',
      },
      body: JSON.stringify({
        correlationId: 'corr-context-only',
        persistUserMessage: 'Attachment import result: skipped.epub.',
        contextEntries,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      correlationId: 'corr-context-only',
      text: 'Context-only reply',
    });
    expect(routeInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: 'corr-context-only',
      text: expect.stringContaining('Context for this chat turn:'),
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storeSpy).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      'Attachment import result: skipped.epub.',
      'Context-only reply',
      expect.objectContaining({
        turnId: 'corr-context-only',
      }),
    );
  });

  it('gateway route accepts context-only inbound requests when text is omitted', async () => {
    const routeInboundMessage = vi.fn().mockResolvedValue({
      correlationId: 'corr-gateway-context-only',
      text: 'Gateway context-only reply',
    });
    const registerHttpRoute = trackFn();
    const api = makeApi({ registerHttpRoute, routeInboundMessage });
    plugin.register(api);
    const route = registerHttpRoute.calls
      .map(([entry]) => entry as any)
      .find((entry) => entry.path === '/api/dkg-channel/inbound');
    const contextEntries = [{
      key: 'attachment_import_result_verified',
      label: 'Attachment import result: skipped.epub',
      value: JSON.stringify({
        assertionUri: 'did:dkg:context-graph:cg-attach/assertion/skipped',
        fileHash: 'sha256:skip',
        extractionStatus: 'skipped',
      }),
    }];
    let statusCode = 0;
    let responseBody = '';
    let resolveEnd!: () => void;
    const ended = new Promise<void>((resolve) => { resolveEnd = resolve; });
    const res = {
      writeHead: vi.fn((status: number) => { statusCode = status; }),
      end: vi.fn((body: string) => {
        responseBody = String(body);
        resolveEnd();
      }),
    };

    route.handler({
      body: {
        correlationId: 'corr-gateway-context-only',
        contextEntries,
      },
    }, res);
    await ended;

    expect(statusCode).toBe(200);
    expect(JSON.parse(responseBody)).toMatchObject({
      correlationId: 'corr-gateway-context-only',
      text: 'Gateway context-only reply',
    });
    expect(routeInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: 'corr-gateway-context-only',
      text: expect.stringContaining('Context for this chat turn:'),
    }));
  });

  it('gateway route returns structured agent timeout payloads', async () => {
    const routeInboundMessage = vi.fn().mockRejectedValue(new Error('Agent response timeout'));
    const registerHttpRoute = trackFn();
    const api = makeApi({ registerHttpRoute, routeInboundMessage });
    plugin.register(api);
    const route = registerHttpRoute.calls
      .map(([entry]) => entry as any)
      .find((entry) => entry.path === '/api/dkg-channel/inbound');
    let statusCode = 0;
    let responseBody = '';
    let resolveEnd!: () => void;
    const ended = new Promise<void>((resolve) => { resolveEnd = resolve; });
    const res = {
      writeHead: vi.fn((status: number) => { statusCode = status; }),
      end: vi.fn((body: string) => {
        responseBody = String(body);
        resolveEnd();
      }),
    };

    route.handler({
      body: {
        text: 'Slow task',
        correlationId: 'corr-agent-timeout',
      },
    }, res);
    await ended;

    expect(statusCode).toBe(504);
    expect(JSON.parse(responseBody)).toMatchObject({
      error: 'Agent response timeout',
      code: 'AGENT_TIMEOUT',
      source: 'openclaw-agent',
      details: 'OpenClaw agent runtime did not produce a response before its deadline',
    });
  });

  it('standalone bridge stream returns structured agent timeout events', async () => {
    const routeInboundMessage = vi.fn().mockRejectedValue(new Error('Agent response timeout'));
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);
    const port = await waitForBridgePort(plugin);

    const res = await fetch(`http://127.0.0.1:${port}/inbound/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'x-dkg-bridge-token': 'test-token',
      },
      body: JSON.stringify({
        text: 'Slow task',
        correlationId: 'corr-agent-timeout-stream',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    const dataLine = body.split(/\r?\n/).find((line) => line.startsWith('data: '));
    expect(dataLine).toBeTruthy();
    expect(JSON.parse(dataLine!.slice('data: '.length))).toMatchObject({
      type: 'error',
      error: 'Agent response timeout',
      code: 'AGENT_TIMEOUT',
      source: 'openclaw-agent',
      details: 'OpenClaw agent runtime did not produce a response before its deadline',
    });
  });

  it('standalone bridge streaming accepts attachment-only inbound requests', async () => {
    const routeInboundMessage = vi.fn().mockResolvedValue({
      correlationId: 'corr-attachment-stream',
      text: 'Attachment-only stream reply',
    });
    const api = makeApi({ routeInboundMessage });
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    plugin.register(api);
    const port = await waitForBridgePort(plugin);

    const res = await fetch(`http://127.0.0.1:${port}/inbound/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'x-dkg-bridge-token': 'test-token',
      },
      body: JSON.stringify({
        correlationId: 'corr-attachment-stream',
        attachmentRefs: [{
          assertionUri: 'did:dkg:context-graph:cg-attach/assertion/chat-doc',
          fileHash: 'sha256:attach123',
          contextGraphId: 'cg-attach',
          fileName: 'chat-doc.pdf',
        }],
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('"correlationId":"corr-attachment-stream"');
    expect(routeInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: 'corr-attachment-stream',
      text: expect.stringContaining('Attached Working Memory items:'),
    }));
  });

  it('standalone bridge streaming accepts context-only inbound requests', async () => {
    const routeInboundMessage = vi.fn().mockResolvedValue({
      correlationId: 'corr-context-stream',
      text: 'Context-only stream reply',
    });
    const api = makeApi({ routeInboundMessage });
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    plugin.register(api);
    const port = await waitForBridgePort(plugin);
    const contextEntries = [{
      key: 'attachment_import_result_verified',
      label: 'Attachment import result: skipped.epub',
      value: JSON.stringify({
        assertionUri: 'did:dkg:context-graph:cg-attach/assertion/skipped',
        fileHash: 'sha256:skip',
        extractionStatus: 'skipped',
      }),
    }];

    const res = await fetch(`http://127.0.0.1:${port}/inbound/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'x-dkg-bridge-token': 'test-token',
      },
      body: JSON.stringify({
        correlationId: 'corr-context-stream',
        persistUserMessage: 'Attachment import result: skipped.epub.',
        contextEntries,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('"correlationId":"corr-context-stream"');
    expect(routeInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: 'corr-context-stream',
      text: expect.stringContaining('Context for this chat turn:'),
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storeSpy).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      'Attachment import result: skipped.epub.',
      'Context-only stream reply',
      expect.objectContaining({
        turnId: 'corr-context-stream',
      }),
    );
  });

  it('stop should be safe to call multiple times and stay in the stopping state', async () => {
    const api = makeApi();
    plugin.register(api);

    // stop() sets an internal `stopping` flag and drains pending work.
    // Calling it twice must not throw (double-cleanup on shutdown signals
    // is a real code path) AND the second call must leave the plugin in
    // the same stopped state — not reset `stopping` back to false, which
    // would let new in-flight dispatches start during teardown and leak.
    await expect(plugin.stop()).resolves.toBeUndefined();
    const internal = plugin as unknown as { stopping: boolean };
    expect(internal.stopping).toBe(true);
    await expect(plugin.stop()).resolves.toBeUndefined();
    expect(internal.stopping).toBe(true);
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

});
