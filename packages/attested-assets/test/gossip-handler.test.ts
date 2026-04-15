import { describe, it, expect, beforeEach } from 'vitest';
import {
  contextGraphSessionsTopic,
  sessionTopic,
  AKAGossipHandler,
} from '../src/gossip-handler.js';
import type { GossipSubManager, GossipMessageHandler } from '@origintrail-official/dkg-core';

function createTrackingGossip() {
  const handlers = new Map<string, GossipMessageHandler>();
  const subscribed = new Set<string>();
  const publishedMessages: Array<{ topic: string; data: Uint8Array }> = [];
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  let onMessageCount = 0;
  let offMessageCount = 0;
  const subscribeCalls: string[] = [];
  const unsubscribeCalls: string[] = [];

  const gossip: GossipSubManager = {
    subscribe(topic: string) {
      subscribed.add(topic);
      subscribeCalls.push(topic);
      subscribeCount++;
    },
    unsubscribe(topic: string) {
      subscribed.delete(topic);
      unsubscribeCalls.push(topic);
      unsubscribeCount++;
    },
    onMessage(topic: string, handler: GossipMessageHandler) {
      handlers.set(topic, handler);
      onMessageCount++;
    },
    offMessage(topic: string) {
      handlers.delete(topic);
      offMessageCount++;
    },
    async publish(topic: string, data: Uint8Array) {
      publishedMessages.push({ topic, data });
    },
  };

  return {
    gossip,
    handlers,
    subscribed,
    publishedMessages,
    subscribeCalls,
    unsubscribeCalls,
    get subscribeCount() { return subscribeCount; },
    get unsubscribeCount() { return unsubscribeCount; },
    get onMessageCount() { return onMessageCount; },
    get offMessageCount() { return offMessageCount; },
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
  let tracking: ReturnType<typeof createTrackingGossip>;
  let handler: AKAGossipHandler;

  beforeEach(() => {
    tracking = createTrackingGossip();
    handler = new AKAGossipHandler(tracking.gossip);
  });

  it('subscribeContextGraph subscribes to the correct topic', () => {
    handler.subscribeContextGraph('test-paranet');
    expect(tracking.subscribed.has('dkg/context-graph/test-paranet/sessions')).toBe(true);
    expect(tracking.subscribeCount).toBe(1);
    expect(tracking.onMessageCount).toBe(1);
  });

  it('subscribeContextGraph is idempotent — second call does not re-subscribe', () => {
    handler.subscribeContextGraph('test-paranet');
    handler.subscribeContextGraph('test-paranet');
    expect(tracking.subscribeCount).toBe(1);
  });

  it('unsubscribeContextGraph removes the subscription and handler', () => {
    handler.subscribeContextGraph('test-paranet');
    handler.unsubscribeContextGraph('test-paranet');

    expect(tracking.offMessageCount).toBe(1);
    expect(tracking.unsubscribeCalls).toContain('dkg/context-graph/test-paranet/sessions');
  });

  it('subscribeSession subscribes to session-specific topic', () => {
    handler.subscribeSession('p1', 'session-abc');
    expect(tracking.subscribeCalls).toContain('dkg/context-graph/p1/sessions/session-abc');
  });

  it('unsubscribeSession removes session-specific subscription', () => {
    handler.subscribeSession('p1', 'session-abc');
    handler.unsubscribeSession('p1', 'session-abc');
    expect(tracking.unsubscribeCalls).toContain('dkg/context-graph/p1/sessions/session-abc');
  });

  it('onEvent/offEvent registers and removes event handlers', () => {
    let called = false;
    const eventHandler = () => { called = true; };
    const topic = 'dkg/context-graph/p1/sessions';

    handler.onEvent(topic, eventHandler);
    handler.offEvent(topic, eventHandler);

    expect(() => handler.offEvent(topic, eventHandler)).not.toThrow();
    expect(called).toBe(false);
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

    expect(tracking.publishedMessages.length).toBe(1);
    expect(tracking.publishedMessages[0].topic).toBe(topic);
    expect(tracking.publishedMessages[0].data.length).toBeGreaterThan(0);
  });

  it('incoming gossip message with malformed data does not dispatch to handlers', () => {
    const topic = contextGraphSessionsTopic('test');
    let handlerCalled = false;
    const eventHandler = () => { handlerCalled = true; };

    handler.onEvent(topic, eventHandler);
    handler.subscribeContextGraph('test');

    const registeredGossipHandler = tracking.handlers.get(topic);
    expect(registeredGossipHandler).toBeDefined();

    registeredGossipHandler!(topic, new Uint8Array([0xff, 0xff]), 'peer-1');
    expect(handlerCalled).toBe(false);
  });
});

describe('AKAGossipHandler — unsubscribeContextGraph then resubscribe', () => {
  let tracking: ReturnType<typeof createTrackingGossip>;
  let handler: AKAGossipHandler;

  beforeEach(() => {
    tracking = createTrackingGossip();
    handler = new AKAGossipHandler(tracking.gossip);
  });

  it('re-subscribing after unsubscribe re-registers the handler', () => {
    handler.subscribeContextGraph('test-paranet');
    handler.unsubscribeContextGraph('test-paranet');
    handler.subscribeContextGraph('test-paranet');

    expect(tracking.subscribeCount).toBe(2);
    expect(tracking.onMessageCount).toBe(2);
  });

  it('unsubscribeContextGraph for unknown id does not throw', () => {
    expect(() => handler.unsubscribeContextGraph('nonexistent')).not.toThrow();
  });

  it('multiple context graphs can be subscribed independently', () => {
    handler.subscribeContextGraph('cg-1');
    handler.subscribeContextGraph('cg-2');

    expect(tracking.subscribeCalls).toContain('dkg/context-graph/cg-1/sessions');
    expect(tracking.subscribeCalls).toContain('dkg/context-graph/cg-2/sessions');

    handler.unsubscribeContextGraph('cg-1');
    expect(tracking.unsubscribeCalls).toContain('dkg/context-graph/cg-1/sessions');
    expect(tracking.unsubscribeCalls).not.toContain('dkg/context-graph/cg-2/sessions');
  });
});
