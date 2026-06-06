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



  it('normalizes gateway status account ids and preserves fields when reporting stopped', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    let currentStatus: Record<string, unknown> = {
      accountId: '   ',
      enabled: true,
      configured: true,
      linked: true,
      mode: 'webhook',
      port: 9201,
      displayName: 'DKG UI',
    };
    const setStatus = vi.fn((status: Record<string, unknown>) => {
      currentStatus = status;
    });
    const lifecycleCtx = {
      accountId: '   ',
      account: { accountId: '   ' },
      cfg: {},
      runtime: {},
      getStatus: () => currentStatus,
      setStatus,
    };
    const lifecycle = registeredPlugin.gateway.startAccount(lifecycleCtx);

    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
        accountId: 'default',
        enabled: true,
        configured: true,
        linked: true,
        running: true,
        connected: true,
        displayName: 'DKG UI',
      }));
    });

    await registeredPlugin.gateway.stopAccount(lifecycleCtx);
    await lifecycle;

    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'default',
      enabled: true,
      configured: true,
      linked: true,
      running: false,
      connected: false,
      restartPending: false,
      mode: 'webhook',
      port: expect.any(Number),
      displayName: 'DKG UI',
    }));
  });

  it('settles plugin-level gateway lifecycle only after bridge shutdown completes', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const setStatus = vi.fn();
    let settled = false;
    const lifecycle = registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'default' }),
      setStatus,
    }).then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });

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
      await flushAsyncContinuations();

      expect(settled).toBe(false);
      expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({
        running: false,
      }));

      closeNow?.();
      await stopPromise;
      await lifecycle;

      expect(settled).toBe(true);
      expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: false,
        connected: false,
        restartPending: false,
      }));
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('preserves replacement lifecycle status when OpenClaw reuses the same context object', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const setStatus = vi.fn();
    const lifecycleCtx = {
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'default' }),
      setStatus,
    };
    const firstLifecycle = registeredPlugin.gateway.startAccount(lifecycleCtx);
    await vi.waitFor(() => {
      expect(setStatus.mock.calls.filter(([status]) => status.running === true)).toHaveLength(1);
    });

    const replacementLifecycle = registeredPlugin.gateway.startAccount(lifecycleCtx);
    await vi.waitFor(() => {
      expect(setStatus.mock.calls.filter(([status]) => status.running === true)).toHaveLength(2);
    });
    await firstLifecycle;

    await plugin.stop();
    await replacementLifecycle;

    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
      running: false,
      connected: false,
      restartPending: false,
    }));
  });

  it('clears shutdown state when OpenClaw restarts the registered gateway lifecycle', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    await plugin.start();

    await registeredPlugin.gateway.stopAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: new AbortController().signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus: vi.fn(),
    });
    const internal = plugin as unknown as { stopping: boolean };
    expect(internal.stopping).toBe(true);

    const controller = new AbortController();
    const lifecycle = registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: controller.signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus: vi.fn(),
    });
    await waitForBridgePort(plugin);

    expect(internal.stopping).toBe(false);

    controller.abort();
    await lifecycle;
  });

  it('waits for an in-flight stop before restarting the registered gateway lifecycle', async () => {
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

      await flushAsyncContinuations();
      expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({
        running: true,
      }));

      closeNow?.();
      await stopPromise;
      await waitForBridgePort(plugin);
      expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));

      controller.abort();
      await lifecycle;
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('ignores different-account stopAccount while a lifecycle is waiting to claim ownership', async () => {
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
      await flushAsyncContinuations();

      const unrelatedStopStatus = vi.fn();
      await registeredPlugin.gateway.stopAccount({
        accountId: 'other',
        account: { accountId: 'other' },
        cfg: {},
        runtime: {},
        getStatus: () => ({ accountId: 'other' }),
        setStatus: unrelatedStopStatus,
      });
      expect(unrelatedStopStatus).toHaveBeenCalledWith(expect.objectContaining({
        accountId: 'other',
        running: false,
        connected: false,
      }));

      closeNow?.();
      await stopPromise;
      await waitForBridgePort(plugin);
      expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));

      controller.abort();
      await lifecycle;
    } finally {
      closeSpy.mockRestore();
    }
  });

});
