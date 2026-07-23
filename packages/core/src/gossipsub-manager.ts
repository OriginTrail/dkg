import type { DKGNode } from './node.js';
import type { EventBus } from './types.js';
import { DKGEvent } from './event-bus.js';
import { withRetry } from './retry.js';
import { logicalTopicFromWireTopic, wireTopicForNetwork } from './constants.js';

export type GossipMessageHandler = (
  topic: string,
  data: Uint8Array,
  from: string,
) => void | Promise<void>;

export interface GossipSubManagerOptions {
  networkId?: string;
  chainId?: string;
  isPeerAccepted?: (peerId: string, topic: string) => boolean;
}

export class GossipSubManager {
  private readonly node: DKGNode;
  private readonly eventBus: EventBus;
  private readonly networkId?: string;
  private readonly chainId?: string;
  private readonly isPeerAccepted?: (peerId: string, topic: string) => boolean;
  private topicHandlers = new Map<string, Set<GossipMessageHandler>>();

  constructor(node: DKGNode, eventBus: EventBus, options: GossipSubManagerOptions = {}) {
    this.node = node;
    this.eventBus = eventBus;
    this.networkId = options.networkId;
    this.chainId = options.chainId;
    this.isPeerAccepted = options.isPeerAccepted;
    this.setupListener();
  }

  private toWireTopic(logicalTopic: string): string {
    return wireTopicForNetwork(this.networkId, logicalTopic, this.chainId);
  }

  private toLogicalTopic(wireTopic: string): string | null {
    return logicalTopicFromWireTopic(this.networkId, wireTopic, this.chainId);
  }

  private setupListener(): void {
    const pubsub = this.node.libp2p.services.pubsub;
    pubsub.addEventListener('message', (evt) => {
      const msg = evt.detail;
      const topic = this.toLogicalTopic(msg.topic);
      if (topic == null) return;
      const data =
        msg.data instanceof Uint8Array ? msg.data : new Uint8Array(0);
      const from = 'from' in msg ? String(msg.from) : 'unknown';
      if (this.isPeerAccepted && !this.isPeerAccepted(from, topic)) return;

      this.eventBus.emit(DKGEvent.GOSSIP_MESSAGE, { topic, data, from });

      const handlers = this.topicHandlers.get(topic);
      if (handlers) {
        for (const handler of handlers) {
          this.dispatchHandler(handler, topic, data, from);
        }
      }
    });
  }

  /**
   * Invoke in registration order, then deliberately detach async completion.
   * Gossip delivery never waits for handler work and shutdown does not drain
   * it; synchronous throws and detached rejections are contained here.
   */
  private dispatchHandler(
    handler: GossipMessageHandler,
    topic: string,
    data: Uint8Array,
    from: string,
  ): void {
    try {
      const completion = handler(topic, data, from);
      void Promise.resolve(completion).catch((error: unknown) => {
        this.logHandlerError(topic, error);
      });
    } catch (error) {
      this.logHandlerError(topic, error);
    }
  }

  private logHandlerError(topic: string, error: unknown): void {
    console.error(
      `[GossipSub] handler error on topic "${topic}":`,
      error instanceof Error ? error.message : error,
    );
  }

  subscribe(topic: string): void {
    this.node.libp2p.services.pubsub.subscribe(this.toWireTopic(topic));
  }

  unsubscribe(topic: string): void {
    this.node.libp2p.services.pubsub.unsubscribe(this.toWireTopic(topic));
    this.topicHandlers.delete(topic);
  }

  async publish(topic: string, data: Uint8Array): Promise<void> {
    const wireTopic = this.toWireTopic(topic);
    await withRetry(
      () => this.node.libp2p.services.pubsub.publish(wireTopic, data),
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
    return this.node.libp2p.services.pubsub.getTopics()
      .map((topic) => this.toLogicalTopic(topic))
      .filter((topic): topic is string => topic != null);
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
    return pubsub.getSubscribers(this.toWireTopic(topic)).map(p => p.toString());
  }
}
