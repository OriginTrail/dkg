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

describe('DkgChannelPlugin', () => {
  let client: DkgDaemonClient;
  let plugin: DkgChannelPlugin;

  beforeEach(() => {
    client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
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
    expect(registerChannel.mock.calls[0][0].name).toBe(CHANNEL_NAME);
  });

  it('should call registerHttpRoute if available', () => {
    const registerHttpRoute = vi.fn();
    const api = makeApi({ registerHttpRoute });
    plugin.register(api);

    expect(registerHttpRoute).toHaveBeenCalledOnce();
    expect(registerHttpRoute.mock.calls[0][0].method).toBe('POST');
    expect(registerHttpRoute.mock.calls[0][0].path).toBe('/api/dkg-channel/inbound');
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

  it('processInbound should use routeInboundMessage if available', async () => {
    const expectedReply = { text: 'Hello from agent', turnId: 't-1' };
    const routeInboundMessage = vi.fn().mockResolvedValueOnce(expectedReply);
    const api = makeApi({ routeInboundMessage });
    plugin.register(api);

    const reply = await plugin.processInbound('Hello', 'corr-1', 'owner');

    expect(reply).toEqual(expectedReply);
    expect(routeInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelName: CHANNEL_NAME,
        senderId: 'owner',
        senderIsOwner: true,
        text: 'Hello',
        correlationId: 'corr-1',
      }),
    );
  });

  it('processInbound should throw if api is not registered', async () => {
    await expect(plugin.processInbound('test', 'c-1', 'owner'))
      .rejects.toThrow('Channel not registered');
  });

  it('processInbound should throw if no routing mechanism available', async () => {
    // Register with a bare api (no routeInboundMessage, no registerChannel)
    const api = makeApi();
    plugin.register(api);

    await expect(plugin.processInbound('test', 'c-1', 'owner'))
      .rejects.toThrow('No message routing mechanism available');
  });

  it('processInbound should wait for onOutbound when registerChannel is available', async () => {
    let channelAdapter: any;
    const registerChannel = vi.fn((opts) => { channelAdapter = opts.plugin; });
    const api = makeApi({ registerChannel });
    plugin.register(api);

    // Start the processInbound — it should create a pending request
    const replyPromise = plugin.processInbound('Hello', 'corr-2', 'owner');

    // Simulate the gateway calling onOutbound
    await channelAdapter.onOutbound({ correlationId: 'corr-2', text: 'Reply!', turnId: 't-2' });

    const reply = await replyPromise;
    expect(reply.text).toBe('Reply!');
    expect(reply.correlationId).toBe('corr-2');
  });

  it('stop should reject pending requests', async () => {
    const registerChannel = vi.fn();
    const api = makeApi({ registerChannel });
    plugin.register(api);

    // Start a request that will be rejected by stop()
    const promise = plugin.processInbound('test', 'c-1', 'owner').catch(e => e.message);

    // Stop the channel — should reject pending
    await plugin.stop();

    const errorMsg = await promise;
    expect(errorMsg).toBe('Channel shutting down');
  });

  it('stop should be safe to call multiple times', async () => {
    const api = makeApi();
    plugin.register(api);

    await plugin.stop();
    await plugin.stop();
  });
});
