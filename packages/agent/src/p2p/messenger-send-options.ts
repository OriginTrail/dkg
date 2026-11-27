export interface SendReliableOpts {
  /**
   * Caller-supplied message id. Used by the receiver-side idempotency
   * cache to dedupe duplicate deliveries and by the sender-side
   * "did-I-already-deliver-this" cache. If omitted, the Messenger
   * generates a UUID v4 — but callers that have their own correlation
   * id (e.g. chat `messageId`, query `requestId`) should pass it so
   * retries replayed across daemon restarts stay keyed consistently.
   */
  messageId?: string;
  timeoutMs?: number;
  /**
   * Max age (ms) before an outbox entry for this `(peer, protocol,
   * messageId)` is considered stale and dropped. Defaults to the
   * Messenger's instance-level `maxAgeMs` (24h). Override for callers
   * that want shorter expiry (e.g. ephemeral chat) or longer
   * (e.g. join-approval).
   */
  maxAgeMs?: number;
}

/** Foreground request ownership; durable sends keep their existing retry policy. */
export interface RequestOwnedSendOpts extends SendReliableOpts {
  signal?: AbortSignal;
  /** Tighten the router's response ceiling before buffering the payload. */
  maxReadBytes?: number;
  /** Default true. Disable for a one-shot read whose caller will retry explicitly. */
  recoverPeerAfterFailure?: boolean;
}
