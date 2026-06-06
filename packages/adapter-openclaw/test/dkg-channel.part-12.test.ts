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
      sessionKey: 'session-1',
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
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(250);
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

  // The following tests verify the ALS-scoped dispatch context (Codex Bug
  // B6) which replaced the earlier TTL-based sessionState map. Each dispatch
  // runs inside an AsyncLocalStorage scope; `getSessionProjectContextGraphId`
  // is only observable from code running INSIDE the dispatch's async call
  // tree. The test mocks grab the in-scope value from the dispatch callback
  // (simulating what a real memory-slot tool call would do), then assert
  // that after `processInbound` resolves the ALS has been torn down and the
  // getter returns undefined from outside.

  /**
   * Construct a runtime mock that captures the value of
   * `plugin.getSessionProjectContextGraphId(observedSessionKey)` from
   * inside the dispatch callback — i.e. while the ALS scope is active.
   */
  function makeDispatchObservingRuntime(
    plugin: DkgChannelPlugin,
    sessionKey: string,
    observedSessionKey: string,
    capture: { inScope?: string | undefined },
  ) {
    return {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue('[DKG UI Owner] Hello'),
          async dispatchReplyWithBufferedBlockDispatcher(params: any) {
            // Simulate a memory-slot tool call happening during dispatch.
            // Captured value lives in the outer closure so the test can
            // assert on it after processInbound resolves.
            capture.inScope = plugin.getSessionProjectContextGraphId(observedSessionKey);
            await params.dispatcherOptions.deliver({ text: 'ok' });
          },
        },
      },
    };
  }

  it('processInbound stamps the UI-selected context graph onto an ALS-scoped dispatch store that slot-backed recall can observe (Codex B6)', async () => {
    const capture: { inScope?: string | undefined } = {};
    const api = makeApi() as any;
    api.runtime = makeDispatchObservingRuntime(plugin, 'session-ui', 'session-ui', capture);
    api.cfg = { session: { dmScope: 'main' }, agents: {} };
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    plugin.register(api);

    // Before the turn, there is no active dispatch scope.
    expect(plugin.getSessionProjectContextGraphId('session-ui')).toBeUndefined();

    await plugin.processInbound('Hello', 'corr-stamp', 'owner', {
      uiContextGraphId: 'research-x',
    });

    // While the dispatch was running the in-scope value was observable.
    expect(capture.inScope).toBe('research-x');
    // After the dispatch resolves the ALS has been torn down — no leak.
    expect(plugin.getSessionProjectContextGraphId('session-ui')).toBeUndefined();
  });

  it('processInbound yields no project CG in the dispatch scope when the turn carries no uiContextGraphId', async () => {
    const capture: { inScope?: string | undefined } = {};
    const api = makeApi() as any;
    api.runtime = makeDispatchObservingRuntime(plugin, 'session-no-ui', 'session-no-ui', capture);
    api.cfg = { session: { dmScope: 'main' }, agents: {} };
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    plugin.register(api);

    await plugin.processInbound('Hello', 'corr-none', 'owner');

    // No uiContextGraphId → scope store has no CG → resolver returns undefined.
    expect(capture.inScope).toBeUndefined();
    // And nothing leaks post-dispatch.
    expect(plugin.getSessionProjectContextGraphId('session-no-ui')).toBeUndefined();
  });

  it('dispatch scope auto-clears between turns — second turn on the same sessionKey without uiContextGraphId is NOT polluted by the first turn (Codex B4+B6)', async () => {
    // Bug B4 regression guard, now enforced through the ALS lifecycle
    // from Bug B6 rather than an explicit clear. Turn 1 stamps a project
    // CG inside its dispatch scope; the resolver-reading dispatch callback
    // observes it. Turn 2 arrives without uiContextGraphId on the SAME
    // sessionKey; its dispatch callback observes undefined because each
    // dispatch gets its own fresh ALS store, and turn 1's store was torn
    // down when turn 1's dispatch promise resolved.
    const capture1: { inScope?: string | undefined } = {};
    const capture2: { inScope?: string | undefined } = {};
    const api = makeApi() as any;
    api.runtime = makeDispatchObservingRuntime(plugin, 'session-b4', 'session-b4', capture1);
    api.cfg = { session: { dmScope: 'main' }, agents: {} };
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    plugin.register(api);

    // Turn 1: user has research-x selected in the UI.
    await plugin.processInbound('first turn', 'corr-b4-1', 'owner', {
      uiContextGraphId: 'research-x',
    });
    expect(capture1.inScope).toBe('research-x');

    // Swap the dispatch observer for turn 2. Same sessionKey.
    api.runtime = makeDispatchObservingRuntime(plugin, 'session-b4', 'session-b4', capture2);

    // Turn 2: user deselected. NO uiContextGraphId on the envelope.
    await plugin.processInbound('second turn', 'corr-b4-2', 'owner');

    // Turn 2's dispatch callback saw undefined — not 'research-x'.
    expect(capture2.inScope).toBeUndefined();
    // And nothing leaks post-dispatch.
    expect(plugin.getSessionProjectContextGraphId('session-b4')).toBeUndefined();
  });

});
