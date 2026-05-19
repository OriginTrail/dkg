import type { DKGNode } from './node.js';
import type { EventBus } from './types.js';
import { DKGEvent } from './event-bus.js';
import { withRetry } from './retry.js';

export type GossipMessageHandler = (
  topic: string,
  data: Uint8Array,
  from: string,
) => void;

export class GossipSubManager {
  private readonly node: DKGNode;
  private readonly eventBus: EventBus;
  private topicHandlers = new Map<string, Set<GossipMessageHandler>>();

  constructor(node: DKGNode, eventBus: EventBus) {
    this.node = node;
    this.eventBus = eventBus;
    this.setupListener();
  }

  private setupListener(): void {
    const pubsub = this.node.libp2p.services.pubsub;
    pubsub.addEventListener('message', (evt) => {
      const msg = evt.detail;
      const topic = msg.topic;
      const data =
        msg.data instanceof Uint8Array ? msg.data : new Uint8Array(0);
      const from = 'from' in msg ? String(msg.from) : 'unknown';

      this.eventBus.emit(DKGEvent.GOSSIP_MESSAGE, { topic, data, from });

      const handlers = this.topicHandlers.get(topic);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(topic, data, from);
          } catch (err) {
            console.error(`[GossipSub] handler error on topic "${topic}":`, err instanceof Error ? err.message : err);
          }
        }
      }
    });
  }

  subscribe(topic: string): void {
    this.node.libp2p.services.pubsub.subscribe(topic);
  }

  unsubscribe(topic: string): void {
    this.node.libp2p.services.pubsub.unsubscribe(topic);
    this.topicHandlers.delete(topic);
  }

  async publish(topic: string, data: Uint8Array): Promise<void> {
    await withRetry(
      () => this.node.libp2p.services.pubsub.publish(topic, data),
      {
        maxAttempts: 3,
        baseDelayMs: 500,
        onRetry: (attempt, delay) => {
          console.warn(`[GossipSub] publish retry ${attempt}/3 on topic "${topic}" (delay ${Math.round(delay)}ms)`);
        },
      },
    );
  }

  onMessage(topic: string, handler: GossipMessageHandler): void {
    let handlers = this.topicHandlers.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.topicHandlers.set(topic, handlers);
    }
    handlers.add(handler);
  }

  offMessage(topic: string, handler: GossipMessageHandler): void {
    const handlers = this.topicHandlers.get(topic);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) this.topicHandlers.delete(topic);
  }

  get subscribedTopics(): string[] {
    return this.node.libp2p.services.pubsub.getTopics();
  }

  /**
   * The set of peers we've observed subscribed to {@link topic} via
   * GossipSub's peer-exchange + heartbeat. Returned as plain peer-id
   * strings (no PeerId object dependency leaks out).
   *
   * Empty array when no peers are subscribed OR when the underlying
   * pubsub implementation does not expose `getSubscribers` (legacy
   * test doubles). Callers MUST treat the result as "best-effort, may
   * be stale by up to one heartbeat interval" — GossipSub's view of
   * topic membership lags real subscription state because there's no
   * authoritative roster.
   *
   * rc.9 PR-B (SWM reliable fan-out plan, Step 1a): consumed by
   * {@link createCGMemberEnumerator} for runtime fan-out decisions
   * on public (non-curated) context graphs.
   */
  getSubscribers(topic: string): string[] {
    const pubsub = this.node.libp2p.services.pubsub as { getSubscribers?: (t: string) => Array<{ toString(): string }> };
    if (typeof pubsub.getSubscribers !== 'function') return [];
    return pubsub.getSubscribers(topic).map(p => p.toString());
  }
}
