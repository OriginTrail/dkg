import type { GossipSubManager, GossipMessageHandler } from '@dkg/core';
import type { AKAEvent } from './types.js';
import { decodeAKAEvent } from './proto/aka-events.js';

export function paranetSessionsTopic(paranetId: string): string {
  return `dkg/paranet/${paranetId}/sessions`;
}

export function sessionTopic(paranetId: string, sessionId: string): string {
  return `dkg/paranet/${paranetId}/sessions/${sessionId}`;
}

export type AKAEventHandler = (event: AKAEvent, from: string) => void;

export class AKAGossipHandler {
  private readonly gossip: GossipSubManager;
  private handlers = new Map<string, Set<AKAEventHandler>>();
  private boundHandlers = new Map<string, GossipMessageHandler>();

  constructor(gossip: GossipSubManager) {
    this.gossip = gossip;
  }

  subscribeParanet(paranetId: string): void {
    const topic = paranetSessionsTopic(paranetId);
    this.ensureTopicSubscription(topic);
  }

  unsubscribeParanet(paranetId: string): void {
    const topic = paranetSessionsTopic(paranetId);
    this.teardownTopicSubscription(topic);
  }

  subscribeSession(paranetId: string, sessionId: string): void {
    const topic = sessionTopic(paranetId, sessionId);
    this.ensureTopicSubscription(topic);
  }

  unsubscribeSession(paranetId: string, sessionId: string): void {
    const topic = sessionTopic(paranetId, sessionId);
    this.teardownTopicSubscription(topic);
  }

  onEvent(topic: string, handler: AKAEventHandler): void {
    let handlers = this.handlers.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(topic, handlers);
    }
    handlers.add(handler);
  }

  offEvent(topic: string, handler: AKAEventHandler): void {
    const handlers = this.handlers.get(topic);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) this.handlers.delete(topic);
  }

  async publishEvent(topic: string, event: AKAEvent): Promise<void> {
    const { encodeAKAEvent } = await import('./proto/aka-events.js');
    const encoded = encodeAKAEvent(event);
    await this.gossip.publish(topic, encoded);
  }

  private ensureTopicSubscription(topic: string): void {
    if (this.boundHandlers.has(topic)) return;

    const handler: GossipMessageHandler = (_topic, data, from) => {
      try {
        const event = decodeAKAEvent(data);
        const eventHandlers = this.handlers.get(topic);
        if (eventHandlers) {
          for (const h of eventHandlers) {
            h(event, from);
          }
        }
      } catch {
        // malformed message — silently drop
      }
    };

    this.gossip.subscribe(topic);
    this.gossip.onMessage(topic, handler);
    this.boundHandlers.set(topic, handler);
  }

  private teardownTopicSubscription(topic: string): void {
    const handler = this.boundHandlers.get(topic);
    if (handler) {
      this.gossip.offMessage(topic, handler);
      this.boundHandlers.delete(topic);
    }
    this.gossip.unsubscribe(topic);
    this.handlers.delete(topic);
  }
}
