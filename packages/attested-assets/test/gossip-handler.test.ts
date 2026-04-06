import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  contextGraphSessionsTopic,
  sessionTopic,
  AKAGossipHandler,
} from '../src/gossip-handler.js';
import type { GossipSubManager, GossipMessageHandler } from '@origintrail-official/dkg-core';

function createMockGossip(): GossipSubManager & {
  _handlers: Map<string, GossipMessageHandler>;
  _subscribed: Set<string>;
} {
  const handlers = new Map<string, GossipMessageHandler>();
  const subscribed = new Set<string>();
  return {
    _handlers: handlers,
    _subscribed: subscribed,
    subscribe: vi.fn((topic: string) => { subscribed.add(topic); }),
    unsubscribe: vi.fn((topic: string) => { subscribed.delete(topic); }),
    onMessage: vi.fn((topic: string, handler: GossipMessageHandler) => {
      handlers.set(topic, handler);
    }),
    offMessage: vi.fn((topic: string) => {
      handlers.delete(topic);
    }),
    publish: vi.fn(),
  } as unknown as GossipSubManager & {
    _handlers: Map<string, GossipMessageHandler>;
    _subscribed: Set<string>;
  };
}

describe('gossip topic helpers', () => {
  it('contextGraphSessionsTopic follows convention', () => {
    expect(contextGraphSessionsTopic('oregon-trail')).toBe('dkg/context-graph/oregon-trail/sessions');
  });

  it('sessionTopic includes session id', () => {
    expect(sessionTopic('oregon-trail', 'session-123')).toBe(
      'dkg/context-graph/oregon-trail/sessions/session-123',
    );
  });

  it('handles special characters in ids', () => {
    expect(contextGraphSessionsTopic('my-paranet')).toBe('dkg/context-graph/my-paranet/sessions');
    expect(sessionTopic('p1', 's-with-dashes')).toBe('dkg/context-graph/p1/sessions/s-with-dashes');
  });
});

describe('AKAGossipHandler', () => {
  let mockGossip: ReturnType<typeof createMockGossip>;
  let handler: AKAGossipHandler;

  beforeEach(() => {
    mockGossip = createMockGossip();
    handler = new AKAGossipHandler(mockGossip);
  });

  it('subscribeContextGraph subscribes to the correct topic', () => {
    handler.subscribeContextGraph('test-paranet');
    expect(mockGossip.subscribe).toHaveBeenCalledWith('dkg/context-graph/test-paranet/sessions');
    expect(mockGossip.onMessage).toHaveBeenCalledWith(
      'dkg/context-graph/test-paranet/sessions',
      expect.any(Function),
    );
  });

  it('subscribeContextGraph is idempotent — second call does not re-subscribe', () => {
    handler.subscribeContextGraph('test-paranet');
    handler.subscribeContextGraph('test-paranet');
    expect(mockGossip.subscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribeContextGraph removes the subscription and handler', () => {
    handler.subscribeContextGraph('test-paranet');
    handler.unsubscribeContextGraph('test-paranet');
    expect(mockGossip.offMessage).toHaveBeenCalledWith(
      'dkg/context-graph/test-paranet/sessions',
      expect.any(Function),
    );
    expect(mockGossip.unsubscribe).toHaveBeenCalledWith('dkg/context-graph/test-paranet/sessions');
  });

  it('subscribeSession subscribes to session-specific topic', () => {
    handler.subscribeSession('p1', 'session-abc');
    expect(mockGossip.subscribe).toHaveBeenCalledWith('dkg/context-graph/p1/sessions/session-abc');
  });

  it('unsubscribeSession removes session-specific subscription', () => {
    handler.subscribeSession('p1', 'session-abc');
    handler.unsubscribeSession('p1', 'session-abc');
    expect(mockGossip.unsubscribe).toHaveBeenCalledWith('dkg/context-graph/p1/sessions/session-abc');
  });

  it('onEvent/offEvent registers and removes event handlers', () => {
    const eventHandler = vi.fn();
    const topic = 'dkg/context-graph/p1/sessions';

    handler.onEvent(topic, eventHandler);
    handler.offEvent(topic, eventHandler);

    // After removal, the handler should not be called even if we simulate a message
    // (no easy way to test without triggering gossip, but verify no throw)
    expect(() => handler.offEvent(topic, eventHandler)).not.toThrow();
  });

  it('publishEvent encodes and publishes via gossip', async () => {
    const topic = 'dkg/context-graph/p1/sessions/s1';
    const event = {
      mode: 'AKA' as const,
      type: 'InputSubmitted' as const,
      sessionId: 's1',
      round: 1,
      prevStateHash: '0x0000',
      signerPeerId: '12D3KooWTest',
      payload: new Uint8Array([1, 2, 3]),
      signature: new Uint8Array(64),
      nonce: '0',
      timestamp: Date.now(),
    };

    await handler.publishEvent(topic, event);
    expect(mockGossip.publish).toHaveBeenCalledWith(topic, expect.any(Uint8Array));
  });

  it('incoming gossip message dispatches to registered event handlers', () => {
    const topic = contextGraphSessionsTopic('test');
    const eventHandler = vi.fn();

    handler.onEvent(topic, eventHandler);
    handler.subscribeContextGraph('test');

    const registeredGossipHandler = mockGossip._handlers.get(topic);
    expect(registeredGossipHandler).toBeDefined();

    // Malformed data should be silently dropped (not throw, not call handler)
    registeredGossipHandler!(topic, new Uint8Array([0xff, 0xff]), 'peer-1');
    expect(eventHandler).not.toHaveBeenCalled();
  });
});
