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



  it('concurrent overlapping dispatches on the same sessionKey each see their OWN ALS store (Codex B6)', async () => {
    // The critical B6 invariant: two dispatches that interleave on the
    // same `sessionKey` must NOT clobber each other's UI-selected CG.
    // AsyncLocalStorage gives each dispatch its own isolated store, so
    // turn A's callback reads turn A's CG and turn B's callback reads
    // turn B's CG even though they share the sessionKey and overlap in
    // wall-clock time.
    //
    // The mock dispatch callback inspects a per-turn gate keyed by
    // correlationId — turn A parks on its gate until turn B has
    // completed, proving the scopes are isolated rather than shared.
    const captures = new Map<string, string | undefined>();
    const gates = new Map<string, Promise<void>>();
    const gateResolvers = new Map<string, () => void>();

    function prepareGate(correlationId: string): void {
      const promise = new Promise<void>((resolve) => {
        gateResolvers.set(correlationId, resolve);
      });
      gates.set(correlationId, promise);
    }

    const mockRuntime = {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'agent-1', sessionKey: 'session-overlap' }),
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
            // Discriminate turn A vs turn B via the raw body text. The
            // ctxPayload does not carry a correlationId field but it
            // does preserve RawBody, which the test sets to `turn-A`
            // or `turn-B`. Capture the in-scope CG BEFORE parking on
            // the gate AND AFTER resuming, to prove both that the
            // scope is present at entry and that it survives the
            // await boundary with the correct value (not the value
            // from the OTHER concurrent turn).
            const ctx = params?.ctx ?? params?.ctxPayload ?? {};
            const turnLabel: string = String(ctx.RawBody ?? '').trim();
            captures.set(`${turnLabel}:pre-gate`, plugin.getSessionProjectContextGraphId('session-overlap'));
            const gate = gates.get(turnLabel);
            if (gate) await gate;
            captures.set(`${turnLabel}:post-gate`, plugin.getSessionProjectContextGraphId('session-overlap'));
            await params.dispatcherOptions.deliver({ text: `ok-${turnLabel}` });
          },
        },
      },
    };
    const api = makeApi() as any;
    api.runtime = mockRuntime;
    api.cfg = { session: { dmScope: 'main' }, agents: {} };
    vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    plugin.register(api);

    // Turn A parks on its gate. Turn B runs to completion without a gate.
    prepareGate('turn-A');

    const turnAPromise = plugin.processInbound('turn-A', 'corr-overlap-a', 'owner', {
      uiContextGraphId: 'project-a',
    });

    // Yield so turn A enters its dispatch callback and parks on the gate
    // before turn B starts.
    await new Promise((resolve) => setImmediate(resolve));

    // Turn B runs to completion immediately on the same sessionKey.
    await plugin.processInbound('turn-B', 'corr-overlap-b', 'owner', {
      uiContextGraphId: 'project-b',
    });

    // Turn B observed project-b both before and after its (no-op) gate.
    expect(captures.get('turn-B:pre-gate')).toBe('project-b');
    expect(captures.get('turn-B:post-gate')).toBe('project-b');

    // Release turn A. Its pre-gate capture happened BEFORE turn B
    // started; its post-gate capture happens AFTER turn B completed.
    // The critical B6 assertion: both captures still read 'project-a'
    // even though turn B ran inside the same sessionKey with a
    // different uiContextGraphId. If the previous TTL-based cache
    // were still in use, turn A's post-gate capture would read
    // 'project-b' because turn B would have overwritten the map entry.
    // With ALS both captures are isolated by async call tree.
    gateResolvers.get('turn-A')!();
    await turnAPromise;
    expect(captures.get('turn-A:pre-gate')).toBe('project-a');
    expect(captures.get('turn-A:post-gate')).toBe('project-a');
  });

});
