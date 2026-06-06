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

  it('processInbound routeInboundMessage fallback marks direct-channel persists with the returned session key', async () => {
    const routeInboundMessage = trackAsyncFn(async () => ({
      correlationId: 'corr-route-marker',
      text: 'Reply!',
      sessionKey: 'agent:main:main',
    }));
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
    plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    const reply = await plugin.processInbound('Hello', 'corr-route-marker', 'owner');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reply.sessionKey).toBe('agent:main:main');
    expect(routeInboundMessage.calls[0][0]).not.toHaveProperty('sessionKey');
    expect(routeInboundMessage.calls[0][0]).not.toHaveProperty('SessionKey');
    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'Hello',
      'Reply!',
      { turnId: 'corr-route-marker' },
    ]);
    expect(markExternalTurnPersistedDurable).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'agent:main:main',
      turnId: 'corr-route-marker',
      user: 'Hello',
      userAliases: expect.arrayContaining(['Hello']),
      assistant: 'Reply!',
    }));
  });

  it('processInbound routeInboundMessage fallback hashes the routed agent body for direct-channel markers', async () => {
    const routeInboundMessage = trackAsyncFn(async () => ({
      correlationId: 'corr-route-context-marker',
      text: 'Reply!',
      sessionKey: 'agent:main:main',
    }));
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
    plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    await plugin.processInbound('Hello', 'corr-route-context-marker', 'owner', {
      contextEntries: [{ key: 'target_context_graph', label: 'Target context graph', value: 'dkg-code-project' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(routeInboundMessage.calls[0][0].text).toContain('Context for this chat turn:');
    expect(storeCalls[0][1]).toBe('Hello');
    expect(markExternalTurnPersistedDurable).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'agent:main:main',
      turnId: 'corr-route-context-marker',
      user: expect.stringContaining('Context for this chat turn:'),
      userAliases: expect.arrayContaining(['Hello']),
      assistant: 'Reply!',
    }));
  });

  it('processInbound routeInboundMessage fallback does not collapse owner-like identities into the owner marker bucket', async () => {
    const routeInboundMessage = trackAsyncFn(async () => ({
      correlationId: 'corr-route-ownerish',
      text: 'Reply!',
      sessionKey: 'agent:main:owner',
    }));
    client.storeChatTurn = async () => undefined as any;
    const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
    plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    await plugin.processInbound('Hello', 'corr-route-ownerish', 'owner!');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(routeInboundMessage.calls[0][0]).toEqual(expect.objectContaining({
      senderId: 'owner!',
    }));
    expect(routeInboundMessage.calls[0][0]).not.toHaveProperty('sessionKey');
    expect(routeInboundMessage.calls[0][0]).not.toHaveProperty('SessionKey');
    expect(markExternalTurnPersistedDurable).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'agent:main:owner',
      turnId: 'corr-route-ownerish',
      user: 'Hello',
      assistant: 'Reply!',
    }));
  });

  it('processInbound routeInboundMessage fallback marks non-owner direct-channel persists with the non-owner session key', async () => {
    const routeInboundMessage = trackAsyncFn(async () => ({
      correlationId: 'corr-route-worker',
      text: 'Worker reply',
      sessionKey: 'agent:main:background-worker',
    }));
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
    plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    await plugin.processInbound('Work item', 'corr-route-worker', 'background-worker');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(routeInboundMessage.calls[0][0]).toEqual(expect.objectContaining({
      senderId: 'background-worker',
    }));
    expect(routeInboundMessage.calls[0][0]).not.toHaveProperty('sessionKey');
    expect(routeInboundMessage.calls[0][0]).not.toHaveProperty('SessionKey');
    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui:background-worker',
      'Work item',
      'Worker reply',
      { turnId: 'corr-route-worker' },
    ]);
    expect(markExternalTurnPersistedDurable).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'agent:main:background-worker',
      turnId: 'corr-route-worker',
      user: 'Work item',
      assistant: 'Worker reply',
    }));
  });

  it('processInbound routeInboundMessage fallback accepts uppercase reply SessionKey for marker persistence', async () => {
    const routeInboundMessage = trackAsyncFn(async () => ({
      correlationId: 'corr-route-uppercase-session',
      text: 'Reply!',
      SessionKey: 'agent:legacy:actual',
    }));
    client.storeChatTurn = async () => undefined as any;
    const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
    plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    const reply = await plugin.processInbound('Hello', 'corr-route-uppercase-session', 'owner');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect((reply as any).SessionKey).toBe('agent:legacy:actual');
    expect(reply.sessionKey).toBe('agent:legacy:actual');
    expect(markExternalTurnPersistedDurable).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'agent:legacy:actual',
      turnId: 'corr-route-uppercase-session',
      user: 'Hello',
      assistant: 'Reply!',
    }));
  });

  it('processInbound routeInboundMessage fallback skips marker persistence when the route does not return its resolved session key', async () => {
    const routeInboundMessage = trackAsyncFn(async () => ({
      correlationId: 'corr-route-no-session',
      text: 'Reply!',
    }));
    const storeCalls: unknown[][] = [];
    client.storeChatTurn = async (...args: unknown[]) => { storeCalls.push(args); return undefined as any; };
    const markExternalTurnPersistedDurable = vi.fn().mockResolvedValue(undefined);
    plugin.setChatTurnWriter({ markExternalTurnPersistedDurable } as any);
    const api = makeApi({
      routeInboundMessage,
      logger: { info: trackFn(), warn: trackFn(), debug: trackFn() },
    });
    plugin.register(api);

    await plugin.processInbound('Hello', 'corr-route-no-session', 'owner');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(routeInboundMessage.calls[0][0]).not.toHaveProperty('sessionKey');
    expect(routeInboundMessage.calls[0][0]).not.toHaveProperty('SessionKey');
    expect(storeCalls[0]).toEqual([
      'openclaw:dkg-ui',
      'Hello',
      'Reply!',
      { turnId: 'corr-route-no-session' },
    ]);
    expect(markExternalTurnPersistedDurable).not.toHaveBeenCalled();
    expect(api.logger.warn.calls.some((call: unknown[]) =>
      String(call[0]).includes('did not include sessionKey'),
    )).toBe(true);
  });

  it('processInbound wraps the routeInboundMessage fallback in an ALS dispatch scope so slot-backed recall sees the UI-selected CG (Codex B13)', async () => {
    // B13 regression guard. When the gateway has no `runtime.channel` and
    // the adapter falls back to `api.routeInboundMessage`, the fallback
    // must run inside the same AsyncLocalStorage dispatch scope that
    // `dispatchViaPluginSdk` uses — otherwise slot-backed memory tool
    // calls fired during that dispatch read an empty ALS store and
    // silently degrade recall to `agent-context` only. This test uses a
    // `routeInboundMessage` mock that captures
    // `plugin.getSessionProjectContextGraphId(undefined)` from inside the
    // callback (i.e. while the ALS scope is active) and asserts the
    // captured value matches the stamped `uiContextGraphId`.
    const capture: {
      inScope?: string | undefined;
      sessionScope?: string | undefined;
      alternateSessionScope?: string | undefined;
    } = {};
    const routeInboundMessage = vi.fn().mockImplementation(async (message: any) => {
      expect(message).not.toHaveProperty('sessionKey');
      expect(message).not.toHaveProperty('SessionKey');
      capture.inScope = plugin.getSessionProjectContextGraphId(undefined);
      capture.sessionScope = plugin.getSessionProjectContextGraphId('agent:main:main');
      capture.alternateSessionScope = plugin.getSessionProjectContextGraphId('agent:other:owner');
      return { correlationId: 'corr-b13', text: 'Reply from route' };
    });
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    // Before the turn, nothing is observable.
    expect(plugin.getSessionProjectContextGraphId(undefined)).toBeUndefined();

    await plugin.processInbound('Hello', 'corr-b13', 'owner', {
      uiContextGraphId: 'research-b13',
    });

    // While the fallback was running, the ALS scope was populated.
    expect(capture.inScope).toBe('research-b13');
    expect(capture.sessionScope).toBe('research-b13');
    expect(capture.alternateSessionScope).toBe('research-b13');
    // After the dispatch resolves, the ALS is torn down.
    expect(plugin.getSessionProjectContextGraphId(undefined)).toBeUndefined();
  });

  it('processInbound should append attachment context for legacy routeInboundMessage fallback', async () => {
    const routeInboundMessage = vi.fn().mockResolvedValue({
      correlationId: 'corr-legacy-attach',
      text: 'Reply with attachments',
      turnId: 't-legacy-attach',
    });
    const attachmentRefs = [
      {
        assertionUri: 'did:dkg:context-graph:cg-2/assertion/chat-doc',
        fileHash: 'sha256:abc123',
        contextGraphId: 'cg-2',
        fileName: 'chat-doc.pdf',
      },
    ];
    const storeSpy = vi.spyOn(client, 'storeChatTurn').mockResolvedValue(undefined);
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    const reply = await plugin.processInbound('Summarize these files.', 'corr-legacy-attach', 'owner', { attachmentRefs });

    expect(routeInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelName: CHANNEL_NAME,
      senderId: 'owner',
      senderIsOwner: true,
      correlationId: 'corr-legacy-attach',
      text: expect.stringContaining('Attached Working Memory items:'),
    }));
    expect(reply.text).toBe('Reply with attachments');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storeSpy).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      'Summarize these files.',
      'Reply with attachments',
      expect.objectContaining({
        turnId: 'corr-legacy-attach',
        attachmentRefs,
      }),
    );
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

});
