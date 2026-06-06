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
    expect(registeredPlugin.gateway.startAccount).toBeTypeOf('function');
    expect(registeredPlugin.gateway.stopAccount).toBeTypeOf('function');
  });

  it('rejects non-default gateway accounts without preempting the default lifecycle', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const defaultController = new AbortController();
    const defaultStatus = vi.fn();
    const defaultLifecycle = registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: defaultController.signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus: defaultStatus,
    });
    await vi.waitFor(() => {
      expect(defaultStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });

    const otherStatus = vi.fn();
    await expect(registeredPlugin.gateway.startAccount({
      accountId: 'other',
      account: { accountId: 'other' },
      cfg: {},
      runtime: {},
      abortSignal: new AbortController().signal,
      getStatus: () => ({ accountId: 'other' }),
      setStatus: otherStatus,
    })).rejects.toThrow(/only supports the "default" gateway account/);

    expect(plugin.isListening).toBe(true);
    expect(otherStatus).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'other',
      running: false,
      connected: false,
      linked: false,
    }));

    await registeredPlugin.gateway.stopAccount({
      accountId: 'other',
      account: { accountId: 'other' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'other' }),
      setStatus: otherStatus,
    });
    expect(plugin.isListening).toBe(true);

    defaultController.abort();
    await defaultLifecycle;
    expect(plugin.isListening).toBe(false);
  });

  it('keeps the registered gateway lifecycle running until OpenClaw aborts it', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const controller = new AbortController();
    const setStatus = vi.fn();
    let settled = false;
    const lifecycle = registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: controller.signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus,
    }).then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
        accountId: 'default',
        running: true,
        connected: true,
        restartPending: false,
        mode: 'webhook',
      }));
    });
    expect(settled).toBe(false);

    controller.abort();
    await lifecycle;
    expect(settled).toBe(true);
    expect(plugin.isListening).toBe(false);
  });

  it('does not tear down an active bridge for an already-aborted gateway lifecycle start', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);
    await waitForBridgePort(plugin);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const controller = new AbortController();
    controller.abort();
    const setStatus = vi.fn();

    await registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: controller.signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus,
    });

    expect(plugin.isListening).toBe(true);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('keeps the registered gateway lifecycle pending until stopAccount even without an abort signal', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const setStatus = vi.fn();
    let settled = false;
    const lifecycleCtx = {
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'default' }),
      setStatus,
    };
    const lifecycle = registeredPlugin.gateway.startAccount(lifecycleCtx).then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });
    expect(settled).toBe(false);

    await registeredPlugin.gateway.stopAccount(lifecycleCtx);
    await lifecycle;
    expect(settled).toBe(true);
  });

  it('stops the current no-signal lifecycle from a fresh stopAccount context for the same account', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const setStatus = vi.fn();
    const lifecycle = registeredPlugin.gateway.startAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'default' }),
      setStatus,
    });
    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });

    await registeredPlugin.gateway.stopAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'default' }),
      setStatus: vi.fn(),
    });

    await lifecycle;
    expect(plugin.isListening).toBe(false);
  });

  it('cancels a pending replacement lifecycle without stopping the active bridge', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const firstController = new AbortController();
    const firstCtx = {
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: firstController.signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus: vi.fn(),
    };
    const firstLifecycle = registeredPlugin.gateway.startAccount(firstCtx);
    await vi.waitFor(() => {
      expect(firstCtx.setStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });

    const replacementCtx = {
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'default' }),
      setStatus: vi.fn(),
    };
    const replacementLifecycle = registeredPlugin.gateway.startAccount(replacementCtx);
    await registeredPlugin.gateway.stopAccount(replacementCtx);

    await replacementLifecycle;
    expect(plugin.isListening).toBe(true);
    expect(replacementCtx.setStatus.mock.calls.some(([status]) => status.running === true)).toBe(false);
    expect(firstCtx.setStatus.mock.calls.some(([status]) => status.running === false)).toBe(false);

    firstController.abort();
    await firstLifecycle;
    expect(plugin.isListening).toBe(false);
  });

  it('stops the active lifecycle for a fresh same-account stop during a replacement window', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    const firstCtx = {
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'default' }),
      setStatus: vi.fn(),
    };
    const firstLifecycle = registeredPlugin.gateway.startAccount(firstCtx);
    await vi.waitFor(() => {
      expect(firstCtx.setStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: true,
        connected: true,
      }));
    });

    const replacementCtx = {
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'default' }),
      setStatus: vi.fn(),
    };
    const stopStatus = vi.fn();
    const replacementLifecycle = registeredPlugin.gateway.startAccount(replacementCtx);
    await registeredPlugin.gateway.stopAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      getStatus: () => ({ accountId: 'default' }),
      setStatus: stopStatus,
    });

    await replacementLifecycle;
    await firstLifecycle;
    expect(plugin.isListening).toBe(false);
    expect(replacementCtx.setStatus.mock.calls.some(([status]) => status.running === true)).toBe(false);
    expect(stopStatus).toHaveBeenCalledWith(expect.objectContaining({
      running: false,
      connected: false,
      restartPending: false,
    }));
  });

  it('stops the registered gateway lifecycle bridge when OpenClaw stops the channel', async () => {
    const registerChannel = trackFn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    const registeredPlugin = (registerChannel.calls[0][0] as any).plugin;
    await plugin.start();
    expect(plugin.isListening).toBe(true);

    const setStatus = vi.fn();
    await registeredPlugin.gateway.stopAccount({
      accountId: 'default',
      account: { accountId: 'default' },
      cfg: {},
      runtime: {},
      abortSignal: new AbortController().signal,
      getStatus: () => ({ accountId: 'default' }),
      setStatus,
    });

    expect(plugin.isListening).toBe(false);
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'default',
      running: false,
      connected: false,
      restartPending: false,
    }));
  });

});
