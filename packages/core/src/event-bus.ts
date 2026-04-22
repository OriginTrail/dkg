import type { EventBus } from './types.js';

export const DKGEvent = {
  KC_PUBLISHED: 'kc:published',
  KC_CONFIRMED: 'kc:confirmed',
  KC_DELETED: 'kc:deleted',
  KA_UPDATED: 'ka:updated',
  PEER_CONNECTED: 'peer:connected',
  PEER_DISCONNECTED: 'peer:disconnected',
  CONNECTION_OPEN: 'connection:open',
  CONNECTION_CLOSE: 'connection:close',
  CONNECTION_UPGRADED: 'connection:upgraded',
  GOSSIP_MESSAGE: 'gossip:message',
  PUBLISH_REQUEST: 'publish:request',
  PUBLISH_ACK: 'publish:ack',
  ACCESS_REQUEST: 'access:request',
  ACCESS_RESPONSE: 'access:response',
  MESSAGE_RECEIVED: 'message:received',
  MESSAGE_SENT: 'message:sent',
  AKA_SESSION_PROPOSED: 'aka:session:proposed',
  AKA_SESSION_ACTIVATED: 'aka:session:activated',
  AKA_SESSION_FINALIZED: 'aka:session:finalized',
  AKA_SESSION_ABORTED: 'aka:session:aborted',
  AKA_ROUND_STARTED: 'aka:round:started',
  AKA_ROUND_FINALIZED: 'aka:round:finalized',
  AKA_ROUND_TIMEOUT: 'aka:round:timeout',
  PUBLISH_FAILED: 'publish:failed',
  CONTEXT_GRAPH_REGISTRATION_FAILED: 'context-graph:registration:failed',
  JOIN_REQUEST_RECEIVED: 'join-request:received',
  JOIN_APPROVED: 'join:approved',
  JOIN_REJECTED: 'join:rejected',
  PROJECT_SYNCED: 'project:synced',
} as const;

export type DKGEventType = (typeof DKGEvent)[keyof typeof DKGEvent];

export class TypedEventBus implements EventBus {
  private listeners = new Map<string, Set<(data: unknown) => void>>();

  emit(event: string, data: unknown): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[EventBus] Handler error on "${event}":`, err instanceof Error ? err.message : err);
      }
    }
  }

  on(event: string, handler: (data: unknown) => void): void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
  }

  off(event: string, handler: (data: unknown) => void): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) this.listeners.delete(event);
  }

  once(event: string, handler: (data: unknown) => void): void {
    const wrapper = (data: unknown) => {
      this.off(event, wrapper);
      handler(data);
    };
    this.on(event, wrapper);
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}
