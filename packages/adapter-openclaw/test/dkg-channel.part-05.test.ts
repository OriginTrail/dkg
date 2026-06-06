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



  it('waits for an abort-triggered lifecycle stop before starting the replacement lifecycle', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const firstController = new AbortController();
    const firstLifecycle = registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: firstController.signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus: vi.fn(),
    });
    await waitForBridgePort(plugin);

    const server = (plugin as any).server;
    const originalClose = server.close.bind(server);
    let closeNow: (() => void) | undefined;
    const closeSpy = vi.spyOn(server, 'close').mockImplementation((callback?: () => void) => {
      closeNow = () => originalClose(callback);
      return server;
    });

    try {
      firstController.abort();
      await vi.waitFor(() => {
        expect(closeNow).toBeTypeOf('function');
      });

      const replacementController = new AbortController();
      const replacementStatus = vi.fn();
      const replacementLifecycle = registeredPlugin.gateway.startAccount({
        accountId: 'default',
        account: { accountId: 'default' },
        cfg: {},
        runtime: {},
        abortSignal: replacementController.signal,
        getStatus: () => ({ accountId: 'default' }),
        setStatus: replacementStatus,
      });

      await flushAsyncContinuations();
      expect(replacementStatus).not.toHaveBeenCalledWith(expect.objectContaining({
        running: true,
      }));

      closeNow?.();
      await firstLifecycle;
      await waitForBridgePort(plugin);
      expect(replacementStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));

      replacementController.abort();
      await replacementLifecycle;
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('does not let a stale aborted lifecycle stop a replacement bridge', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const firstController = new AbortController();
    const firstStatus = vi.fn();
    const firstLifecycle = registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: firstController.signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus: firstStatus,
    });
    await vi.waitFor(() => {
      expect(firstStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });

    const replacementController = new AbortController();
    const replacementStatus = vi.fn();
    firstController.abort();
    const replacementLifecycle = registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: replacementController.signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus: replacementStatus,
    });

    await vi.waitFor(() => {
      expect(replacementStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });
    await firstLifecycle;
    expect(plugin.isListening).toBe(true);

    replacementController.abort();
    await replacementLifecycle;
    expect(plugin.isListening).toBe(false);
  });

  it('ignores a stale stopAccount request for a replaced lifecycle', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const firstController = new AbortController();
    const firstStatus = vi.fn();
    const firstLifecycle = registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: firstController.signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus: firstStatus,
    });
    await vi.waitFor(() => {
      expect(firstStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });

    const replacementController = new AbortController();
    const replacementStatus = vi.fn();
    firstController.abort();
    const replacementLifecycle = registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: replacementController.signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus: replacementStatus,
    });
    await vi.waitFor(() => {
      expect(replacementStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });
    await firstLifecycle;

    const staleStopStatus = vi.fn();
    await registeredPlugin.gateway.stopAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: firstController.signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus: staleStopStatus,
    });

    expect(plugin.isListening).toBe(true);
    expect(staleStopStatus).not.toHaveBeenCalledWith(expect.objectContaining({
      running: false,
    }));

    replacementController.abort();
    await replacementLifecycle;
    expect(plugin.isListening).toBe(false);
  });

  it('ignores a stale no-signal stopAccount request for a replaced lifecycle', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const firstStatus = vi.fn();
    const firstCtx = {
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'default' }),
      setStatus: firstStatus,
    };
    const firstLifecycle = registeredPlugin.gateway.startAccount(firstCtx);
    await vi.waitFor(() => {
      expect(firstStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });

    const replacementStatus = vi.fn();
    const replacementCtx = {
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'default' }),
      setStatus: replacementStatus,
    };
    const replacementLifecycle = registeredPlugin.gateway.startAccount(replacementCtx);
    await vi.waitFor(() => {
      expect(replacementStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });
    await firstLifecycle;

    await registeredPlugin.gateway.stopAccount(firstCtx);
    expect(plugin.isListening).toBe(true);
    expect(firstStatus).not.toHaveBeenCalledWith(expect.objectContaining({
      running: false,
    }));

    await registeredPlugin.gateway.stopAccount(replacementCtx);
    await replacementLifecycle;
    expect(plugin.isListening).toBe(false);
  });

  it('does not stop an active bridge when a lifecycle aborts before claiming post-start ownership', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);
    await plugin.start();

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    let abortedReads = 0;
    const signal: any = {
      get aborted() {
        abortedReads += 1;
        return abortedReads > 1;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const setStatus = vi.fn();

    await registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus,
    });

    expect(plugin.isListening).toBe(true);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('does not report running when a replacement lifecycle is aborted while waiting for stop to finish', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    await plugin.start();

    const server = (plugin as any).server;
    const originalClose = server.close.bind(server);
    let closeNow: (() => void) | undefined;
    const closeSpy = vi.spyOn(server, 'close').mockImplementation((callback?: () => void) => {
      closeNow = () => originalClose(callback);
      return server;
    });

    try {
      const stopPromise = plugin.stop();
      await vi.waitFor(() => {
        expect(closeNow).toBeTypeOf('function');
      });

      const controller = new AbortController();
      const setStatus = vi.fn();
      const lifecycle = registeredPlugin.gateway.startAccount({
        accountId: 'default',
        account: { accountId: 'default' },
        cfg: {},
        runtime: {},
        abortSignal: controller.signal,
        getStatus: () => ({ accountId: 'default' }),
        setStatus,
      });
      controller.abort();

      closeNow?.();
      await stopPromise;
      await lifecycle;

      expect(plugin.isListening).toBe(false);
      expect(setStatus.mock.calls.some(([status]) => status.running === true)).toBe(false);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('settles the gateway lifecycle wait if abort flips during listener registration', async () => {
    const signal: any = {
      aborted: false,
      removeEventListener: vi.fn(),
    };
    signal.addEventListener = vi.fn(() => {
      signal.aborted = true;
    });

    await (plugin as any).waitForGatewayLifecycleStop(signal);

    expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(signal.removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
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

});
